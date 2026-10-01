import { AudioSample, AudioSampleSource, CanvasSource, Mp4OutputFormat, Output, StreamTarget, type StreamTargetChunk } from "mediabunny";
import type { OutputWriter } from "./cloud-output-writer";
import { AudioRenderer } from "./audio-renderer";
import { AUDIO_RATE, FRAME_HEIGHT, FRAME_RATE, FRAME_WIDTH } from "./composition";
import { timelineDuration, validateState, type ProjectState } from "./editor";
import { measureAacDelay } from "./aac-timing";
import { fixMp4Timing } from "./mp4-timing";
import { VideoRenderer, type MediaSource } from "./video-renderer";
import { ensureOutputEncoding } from "./codec-support";

export async function exportTimeline(state: ProjectState, source: MediaSource, music: Record<string, MediaSource>, handle: { createWritable(): Promise<OutputWriter> }, signal: AbortSignal, progress: (fraction: number) => void) {
  validateState(state); signal.throwIfAborted();
  await ensureOutputEncoding(signal);
  const timing = await measureAacDelay(signal);
  signal.throwIfAborted();
  const writable = await handle.createWritable();
  const canvas = new OffscreenCanvas(FRAME_WIDTH, FRAME_HEIGHT);
  const context = canvas.getContext("2d");
  if (!context) { await writable.abort(); throw new Error("Canvas rendering is not supported"); }
  const video = new VideoRenderer(source);
  const audio = new AudioRenderer(source, music);
  let metadata: { bytes: Uint8Array; position: number } | undefined;
  let size = 0;
  const target = new StreamTarget(new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      signal.throwIfAborted();
      await writable.write(chunk);
      size = Math.max(size, chunk.position + chunk.data.byteLength);
    },
    // Keep the file writer open for the final bounded metadata correction.
  }), { chunked: true, chunkSize: 1024 * 1024 });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false, onMoov: (bytes, position) => { metadata = { bytes: bytes.slice(), position }; } }), target });
  const videoSource = new CanvasSource(canvas, { codec: "avc", bitrate: 8_000_000 });
  const audioSource = new AudioSampleSource({ codec: "aac", bitrate: 192_000 });
  output.addVideoTrack(videoSource, { frameRate: FRAME_RATE });
  output.addAudioTrack(audioSource);
  const cancel = () => { void video.dispose().catch(() => {}); audio.dispose(); void output.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let complete = false;
  try {
    const duration = timelineDuration(state) / 1000;
    const frames = Math.ceil(duration * FRAME_RATE);
    const audioFrames = Math.round(duration * AUDIO_RATE);
    await output.start();
    for (let index = 0; index < frames; index++) {
      signal.throwIfAborted();
      const timestamp = index / FRAME_RATE;
      await video.draw(context, state, timestamp * 1000);
      await videoSource.add(timestamp, Math.min(1 / FRAME_RATE, duration - timestamp));
      const start = Math.round(timestamp * AUDIO_RATE);
      const count = Math.min(AUDIO_RATE / FRAME_RATE, audioFrames - start);
      if (count > 0) {
        const pcm = await audio.render(state, start, count);
        const sample = new AudioSample({ data: pcm, format: "f32", sampleRate: AUDIO_RATE, numberOfChannels: 2, timestamp });
        try { await audioSource.add(sample); } finally { sample.close(); }
      }
      if (index % FRAME_RATE === 0) progress(index / frames);
    }
    videoSource.close(); audioSource.close();
    await output.finalize(); signal.throwIfAborted();
    const moov = metadata as { bytes: Uint8Array; position: number } | undefined;
    if (!moov || moov.position + moov.bytes.length !== size) throw new Error("Unexpected MP4 layout; export was not finalized");
    const corrected = fixMp4Timing(moov.bytes, duration, timing.seconds);
    await writable.write({ type: "write", position: moov.position, data: corrected });
    await writable.truncate(moov.position + corrected.byteLength);
    // Closing commits the replacement; honor cancellation through the last staging write.
    signal.throwIfAborted();
    await writable.close(); complete = true;
    progress(1);
    return { duration, aacDelayFrames: timing.frames, bytes: moov.position + corrected.byteLength };
  } finally {
    signal.removeEventListener("abort", cancel);
    try { await video.dispose(); }
    finally {
      audio.dispose();
      if (output.state !== "finalized" && output.state !== "canceled") await output.cancel().catch(() => {});
      if (!complete) await writable.abort().catch(() => {});
    }
  }
}
