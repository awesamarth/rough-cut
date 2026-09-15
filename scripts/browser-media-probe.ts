import { ALL_FORMATS, AudioSample, AudioSampleSink, AudioSampleSource, BlobSource, CanvasSink, CanvasSource, Input, Mp4OutputFormat, Output, StreamTarget } from "mediabunny";
import { analyzeAudio, prepareAudioChunk } from "../src/lib/browser-audio";
import { silenceCandidates } from "../src/lib/audio-analysis";
import { transcriptionDurationSeconds } from "../src/lib/transcription-audio";
import { exportTimeline } from "../src/lib/browser-export";
import { AudioRenderer } from "../src/lib/audio-renderer";
import { VideoRenderer } from "../src/lib/video-renderer";
import { requestCloudOutput, cloudOutputUrl, cancelCloudOutput } from "../src/lib/cloud-output-client";
import { localExport, runExportWorker } from "../src/lib/local-export";
import { applyCommand, createProjectState } from "../src/lib/editor";
import { createLocalProject, deleteLocalProject, getLocalProject, importLocalProject, saveLocalProject } from "../src/lib/local-store";
import { claimRecoveryKey } from "../src/lib/recovery";

const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };

async function probe() {
  const root = await navigator.storage.getDirectory();
  const filename = `rough-cut-smoke-${crypto.randomUUID()}.mp4`;
  const fileHandle = await root.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  const canvas = new OffscreenCanvas(1920, 1080);
  const context = canvas.getContext("2d")!;
  const video = new CanvasSource(canvas, { codec: "avc", bitrate: 8_000_000 });
  const audio = new AudioSampleSource({ codec: "aac", bitrate: 192_000 });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable, { chunked: true, chunkSize: 1024 * 1024 }) });
  output.addVideoTrack(video, { frameRate: 30 });
  output.addAudioTrack(audio);
  let input: Input | undefined;
  try {
    await output.start();
    for (let frame = 0; frame < 60; frame++) {
      context.fillStyle = frame < 30 ? "#ff0000" : "#0000ff";
      context.fillRect(0, 0, 1920, 1080);
      context.fillStyle = "white";
      context.font = "48px sans-serif";
      context.fillText(`Frame ${frame}`, 80, 80);
      await video.add(frame / 30, 1 / 30);
      const pcm = new Float32Array(1600 * 2);
      // First second audible, second second silent; opposite-phase stereo.
      for (let index = 0; index < 1600; index++) {
        const value = frame < 30 ? Math.sin(2 * Math.PI * 440 * (frame * 1600 + index) / 48000) * 0.25 : 0;
        pcm[index * 2] = value;
        pcm[index * 2 + 1] = -value;
      }
      const sample = new AudioSample({ data: pcm, format: "f32", numberOfChannels: 2, sampleRate: 48000, timestamp: frame / 30 });
      try { await audio.add(sample); } finally { sample.close(); }
    }
    video.close(); audio.close();
    await output.finalize();
    const file = await fileHandle.getFile();
    assert(file.size > 1000, "Empty MP4");
    input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    const videoTrack = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    assert(videoTrack && audioTrack, "Missing output track");
    const duration = await input.computeDuration();
    assert(Math.abs(duration - 2) < 0.1, `Unexpected duration ${duration}`);
    const sink = new CanvasSink(videoTrack!, { width: 32, height: 18, fit: "contain" });
    const red = await sink.getCanvas(0.5);
    const blue = await sink.getCanvas(1.5);
    const pixel = (image: NonNullable<typeof red>) => (image.canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D).getImageData(16, 9, 1, 1).data;
    assert(red && pixel(red)[0] > 200 && pixel(red)[2] < 30, "First frame is not red");
    assert(blue && pixel(blue)[2] > 200 && pixel(blue)[0] < 30, "Second frame is not blue");
    const audioSink = new AudioSampleSink(audioTrack!);
    let audioFrames = 0;
    for await (const sample of audioSink.samples()) { audioFrames += sample.numberOfFrames; sample.close(); }
    assert(audioFrames >= 96000, "Audio is truncated");
    const signal = new AbortController().signal;
    const analysis = await analyzeAudio(file, `smoke-${filename}`, signal);
    const silences = silenceCandidates(analysis, -35, 500);
    assert(silences.length === 1 && silences[0].startMs >= 950 && silences[0].startMs < 1100, `Wrong silence result: ${JSON.stringify(silences)}`);
    const chunk = await prepareAudioChunk(file, 1000, 2000, signal);
    assert(chunk.offsetMs === 1000, "Incorrect transcription offset");
    assert(transcriptionDurationSeconds(await chunk.audio.arrayBuffer()) === 1, "Incorrect prepared WAV duration");
    const canceled = new AbortController(); canceled.abort();
    let aborted = false;
    try { await analyzeAudio(file, `cancel-${filename}`, canceled.signal); } catch { aborted = true; }
    assert(aborted, "Canceled analysis still ran");
    const speechChunk = await prepareAudioChunk(file, 500, 900, signal);
    const speechPcm = new DataView(await speechChunk.audio.arrayBuffer());
    let speechEnergy = 0;
    for (let offset = 44; offset < speechPcm.byteLength; offset += 2) speechEnergy += (speechPcm.getInt16(offset, true) / 32768) ** 2;
    assert(speechChunk.hasSamples && speechEnergy / ((speechPcm.byteLength - 44) / 2) > 0.01, "Transcription preparation lost trimmed/phase-inverted speech");
    const delayed = await (await fetch("/delayed.mp4")).blob();
    const delayedChunk = await prepareAudioChunk(delayed, 0, 1000, signal);
    const delayedPcm = new DataView(await delayedChunk.audio.arrayBuffer());
    let earlyEnergy = 0, laterEnergy = 0;
    for (let index = 1600; index < 3200; index++) earlyEnergy += Math.abs(delayedPcm.getInt16(44 + index * 2, true));
    for (let index = 8000; index < 9600; index++) laterEnergy += Math.abs(delayedPcm.getInt16(44 + index * 2, true));
    assert(earlyEnergy < 100 && laterEnergy > 100000, "Transcription preparation collapsed the source's leading audio gap");
    const composedName = `timeline-${filename}`;
    const composedHandle = await root.getFileHandle(composedName, { create: true });
    let composedInput: Input | undefined;
    try {
      const localId = await createLocalProject(file, 2000);
      let importedId: string | undefined;
      const owner = new AbortController(), duplicate = new AbortController(), reopened = new AbortController();
      let firstKey = "";
      try {
        const original = (await getLocalProject(localId))!;
        const next = applyCommand(original.state, { type: "rename_project", expectedVersion: 0, actor: "human", name: "Atomic local edit" });
        const writes = await Promise.allSettled([saveLocalProject(localId, 0, { state: next, transcript: [] }), saveLocalProject(localId, 0, { state: next, transcript: [] })]);
        assert(writes.filter((write) => write.status === "fulfilled").length === 1, "Concurrent IndexedDB revisions both succeeded");
        await saveLocalProject(localId, 1, { state: { ...original.state, version: 2 }, transcript: [] }, "undo");
        importedId = await importLocalProject(await getLocalProject(localId));
        const imported = (await getLocalProject(importedId))!;
        assert(imported.future.length === 1 && imported.future[0].state.id === importedId, "Backup lost undo/redo history or retained old project identity");
        firstKey = await claimRecoveryKey(localId, owner.signal);
        const identity = sessionStorage.getItem(`rough-cut.tab:${localId}`)!;
        localStorage.setItem(firstKey, "pending original tab");
        const secondKey = await claimRecoveryKey(localId, duplicate.signal);
        assert(secondKey !== firstKey && localStorage.getItem(firstKey) === "pending original tab", "Duplicated tab claimed another live recovery journal");
        owner.abort();
        await new Promise((resolve) => setTimeout(resolve, 0));
        sessionStorage.setItem(`rough-cut.tab:${localId}`, identity);
        assert(await claimRecoveryKey(localId, reopened.signal) === firstKey, "Reload could not reclaim its own journal");
      } finally {
        owner.abort(); duplicate.abort(); reopened.abort();
        if (firstKey) localStorage.removeItem(firstKey);
        sessionStorage.removeItem(`rough-cut.tab:${localId}`);
        await deleteLocalProject(localId);
        if (importedId) await deleteLocalProject(importedId);
      }
      const state = createProjectState(crypto.randomUUID(), "Timeline smoke", 2000);
      state.overlays = [{ id: "text", text: "Shared browser compositor", startMs: 100, endMs: 900, position: "bottom", fontSize: 48 }];
      const faster = structuredClone(state); faster.clips[0].speed = 2;
      const mixer = new AudioRenderer(file, {});
      try {
        const pcm = await mixer.render(faster, 0, 48000);
        let crossings = 0;
        for (let index = 7201; index < 16800; index++) if (pcm[index * 2 - 2] <= 0 && pcm[index * 2] > 0) crossings++;
        assert(Math.abs(crossings - 88) <= 3, `Speed changed audio pitch: ${crossings} crossings instead of 88`);
      } finally { mixer.dispose(); }
      const silentFile = await (await fetch("/silent-vfr.mp4")).blob();
      const silentInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(silentFile) });
      try {
        assert(!await silentInput.getPrimaryAudioTrack(), "Silent fixture unexpectedly contains audio");
        const frames = new CanvasSink((await silentInput.getPrimaryVideoTrack())!, { width: 32, height: 18, fit: "contain" });
        const early = await frames.getCanvas(0.25), late = await frames.getCanvas(1.25);
        assert(early && late && Math.abs(early.timestamp - 0.2) < 0.001 && Math.abs(late.timestamp - 1.233333) < 0.001, "Fixture did not preserve variable frame timestamps");
      } finally { silentInput.dispose(); }
      const musicState = createProjectState(crypto.randomUUID(), "Silent VFR and looping music", 2000);
      const toneId = crypto.randomUUID();
      musicState.music = [{ id: crypto.randomUUID(), assetId: toneId, name: "Tone", durationMs: 2000, timelineStartMs: 300, sourceInMs: 200, sourceOutMs: 800, speed: 1, volume: 0.5, muted: false, fadeInMs: 200, fadeOutMs: 200, loop: true }];
      const musicMixer = new AudioRenderer(silentFile, { [toneId]: file });
      try {
        const pcm = await musicMixer.render(musicState, 0, 96000);
        const rms = (start: number, end: number) => {
          let sum = 0;
          for (let frame = start; frame < end; frame++) sum += pcm[frame * 2] ** 2;
          return Math.sqrt(sum / (end - start));
        };
        assert(rms(0, 14400) === 0, "Music leaked before its timeline start");
        const level = rms(28800, 38400);
        assert(level > 0.06 && level < 0.11 && Math.abs(rms(57600, 67200) - level) < 0.01, "Trimmed music loop or volume changed across its boundary");
        assert(rms(14400, 16800) < level * 0.3 && rms(93600, 96000) < level * 0.3, "Music fades did not reach silence at timeline edges");
      } finally { musicMixer.dispose(); }
      const mutedMixer = new AudioRenderer(silentFile, {});
      try {
        const muted = { ...musicState, music: musicState.music.map((clip) => ({ ...clip, muted: true })) };
        assert((await mutedMixer.render(muted, 0, 4800)).every((value) => value === 0), "Muted music/no-audio source produced sound");
      } finally { mutedMixer.dispose(); }
      await exportTimeline(musicState, silentFile, { [toneId]: file }, composedHandle, signal, () => {});
      const musicAnalysis = await analyzeAudio(await composedHandle.getFile(), `music-${filename}`, signal);
      const musicSilences = silenceCandidates(musicAnalysis, -35, 200);
      assert(musicSilences.length === 1 && musicSilences[0].startMs === 0 && musicSilences[0].endMs >= 280 && musicSilences[0].endMs <= 400, `Music export lost timing: ${JSON.stringify(musicSilences)}`);
      const rendered = await exportTimeline(state, file, {}, composedHandle, signal, () => {});
      const composedFile = await composedHandle.getFile();
      composedInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(composedFile) });
      const composedDuration = await composedInput.computeDuration();
      const url = URL.createObjectURL(composedFile);
      const player = document.createElement("video");
      const presentationDuration = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Native MP4 metadata timed out")), 10_000);
        player.onloadedmetadata = () => { clearTimeout(timer); resolve(player.duration); };
        player.onerror = () => { clearTimeout(timer); reject(new Error("Native player rejected composed MP4")); };
        player.src = url;
      });
      player.removeAttribute("src"); player.load(); URL.revokeObjectURL(url);
      assert(Math.abs(presentationDuration - 2) < 0.001, `Composed MP4 presentation has wrong duration: ${JSON.stringify({ presentationDuration, composedDuration, rendered })}`);
      const composedAnalysis = await analyzeAudio(composedFile, `composed-${filename}`, signal);
      const composedSilences = silenceCandidates(composedAnalysis, -35, 500);
      assert(composedSilences.length === 1 && Math.abs(composedSilences[0].startMs - silences[0].startMs) <= 20, `AAC synchronization drifted: ${JSON.stringify({ silences, composedSilences, rendered })}`);
      composedInput.dispose(); composedInput = undefined;
      let transitionState = applyCommand(state, { type: "split_clip", actor: "human", expectedVersion: state.version, clipId: state.clips[0].id, sourceMs: 1000 });
      transitionState = applyCommand(transitionState, { type: "set_transition", actor: "human", expectedVersion: transitionState.version, clipId: transitionState.clips[0].id, transition: { type: "crossfade", durationMs: 400 } });
      const renderer = new VideoRenderer(file);
      const previewCanvas = new OffscreenCanvas(32, 18), previewContext = previewCanvas.getContext("2d")!;
      let previewPixel: Uint8ClampedArray;
      try {
        await renderer.draw(previewContext, transitionState, 800);
        previewPixel = previewContext.getImageData(16, 3, 1, 1).data;
        assert(Math.abs(previewPixel[0] - 128) < 5 && Math.abs(previewPixel[2] - 128) < 5, `Crossfade did not blend red/blue: ${previewPixel}`);
        const black = applyCommand(transitionState, { type: "set_transition", actor: "human", expectedVersion: transitionState.version, clipId: transitionState.clips[0].id, transition: { type: "fade-black", durationMs: 400 } });
        await renderer.draw(previewContext, black, 800);
        const blackPixel = previewContext.getImageData(16, 3, 1, 1).data;
        assert(blackPixel[0] + blackPixel[1] + blackPixel[2] < 5, "Fade-through-black midpoint was not black");
      } finally { renderer.dispose(); }
      const workerExport = await localExport(transitionState, file, {}, "worker.mp4", signal, () => {}, composedHandle);
      composedInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(await composedHandle.getFile()) });
      const exportedFrame = await new CanvasSink((await composedInput.getPrimaryVideoTrack())!, { width: 32, height: 18, fit: "contain" }).getCanvas(0.8);
      const exportedPixel = (exportedFrame!.canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D).getImageData(16, 3, 1, 1).data;
      assert([0, 1, 2].every((channel) => Math.abs(exportedPixel[channel] - previewPixel[channel]) < 10), `Export/preview crossfade mismatch: ${exportedPixel} vs ${previewPixel}`);
      composedInput.dispose(); composedInput = undefined;
      const completedSize = (await workerExport.handle.getFile()).size;
      assert(completedSize > 1000, "Export worker did not produce a file");
      const cancellation = new AbortController();
      let canceled = false;
      try { await localExport(state, file, {}, "canceled.mp4", cancellation.signal, () => cancellation.abort(new DOMException("Test cancellation", "AbortError")), composedHandle); }
      catch (error) { canceled = error instanceof DOMException && error.name === "AbortError"; }
      assert(canceled && (await composedHandle.getFile()).size === completedSize, "Canceled export changed an existing destination file");
      const savedBytes = new Uint8Array(await (await composedHandle.getFile()).arrayBuffer());
      for (const fault of ["write", "late-abort"] as const) {
        const controller = new AbortController();
        const failingHandle = { async createWritable() {
          const writer = await composedHandle.createWritable();
          return {
            async write(data: FileSystemWriteChunkType) {
              await writer.write(data);
              if (fault === "write") throw new DOMException("Injected disk full", "QuotaExceededError");
            },
            async truncate(size: number) {
              await writer.truncate(size);
              if (fault === "late-abort") controller.abort(new DOMException("Injected late cancellation", "AbortError"));
            },
            close: () => writer.close(), abort: () => writer.abort(),
          };
        } } as FileSystemFileHandle;
        let rejected = false;
        try { await exportTimeline(state, file, {}, failingHandle, controller.signal, () => {}); }
        catch (error) { rejected = String(error).includes(fault === "write" ? "Injected disk full" : "Injected late cancellation"); }
        const remaining = new Uint8Array(await (await composedHandle.getFile()).arrayBuffer());
        assert(rejected && remaining.length === savedBytes.length && remaining.every((value, index) => value === savedBytes[index]), `${fault} replaced an existing export or reported success`);
      }
      const NativeWorker = globalThis.Worker;
      let terminated = 0, cloneRejected = false;
      try {
        globalThis.Worker = class extends NativeWorker {
          postMessage(): never { throw new DOMException("Injected handle clone failure", "DataCloneError"); }
          terminate() { terminated++; super.terminate(); }
        };
        try { await localExport(state, file, {}, "clone-failure.mp4", signal, () => {}, composedHandle); }
        catch (error) { cloneRejected = String(error).includes("Injected handle clone failure"); }
      } finally { globalThis.Worker = NativeWorker; }
      assert(cloneRejected && terminated === 1, "Failed worker startup leaked a worker");
      const estimate = navigator.storage.estimate.bind(navigator.storage);
      let quotaRejected = false;
      try {
        navigator.storage.estimate = async () => ({ quota: 1, usage: 1 });
        try { await localExport(state, file, {}, "no-space.mp4", signal, () => {}); }
        catch (error) { quotaRejected = String(error).includes("Not enough browser storage"); }
      } finally { navigator.storage.estimate = estimate; }
      assert(quotaRejected, "Local quota exhaustion did not fail before exporting");
      let localR2WorkerExport = false;
      if (await (await fetch("/cloud-test-enabled")).json()) {
        const session = await requestCloudOutput("cloud-test.mp4", 40 * 1024 * 1024, signal);
        let cloudInput: Input | undefined;
        try {
          await runExportWorker(state, file, {}, { cloud: session }, signal, () => {});
          const response = await fetch(cloudOutputUrl(session));
          assert(response.ok, `Cloud output download failed: ${response.status}`);
          cloudInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(await response.blob()) });
          const frame = await new CanvasSink((await cloudInput.getPrimaryVideoTrack())!, { width: 32, height: 18, fit: "contain" }).getCanvas(1.5);
          assert(frame && pixel(frame)[2] > 200, "Cloud output did not contain the composed video");
          assert(Math.abs(await cloudInput.computeDuration() - 2) < 0.1, "Cloud output was truncated");
          localR2WorkerExport = true;
        } finally { cloudInput?.dispose(); await cancelCloudOutput(session); }
        const deleted = await fetch(cloudOutputUrl(session));
        assert(!deleted.ok, "Deleted cloud output was still downloadable");
      }
      return { ok: true, localR2WorkerExport, bytes: file.size, duration, audioFrames, silences, wavBytes: chunk.audio.size, rendered, composedDuration, presentationDuration, composedSilences, workerExport: true, crossfadePreviewExportParity: true, fadeBlack: true, pitchPreservingSpeed: true, localHistoryAndRecovery: true, cancellation: true, quotaPreflight: true, writeFailureAndLateCancellation: true, silentVfrAndLoopingMusic: true, workerStartupCleanup: true, transcriptionPhaseAndOffsets: true, note: "Actual shared compositor/audio timeline export with calibrated AAC edit list; local headless browser, not download/share or long-file UX verification." };
    } finally { composedInput?.dispose(); await root.removeEntry(composedName).catch(() => {}); }
  } finally {
    input?.dispose();
    if (output.state !== "finalized" && output.state !== "canceled") await output.cancel().catch(() => {});
    await root.removeEntry(filename).catch(() => {});
    await caches.delete("rough-cut-audio-v2");
  }
}

void probe().then((result) => fetch("/result", { method: "POST", body: JSON.stringify(result) }))
  .catch((error) => fetch("/result", { method: "POST", body: JSON.stringify({ ok: false, error: String(error), stack: error.stack }) }));
