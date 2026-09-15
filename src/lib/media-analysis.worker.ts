import { normalizePcmTimestamp } from "./media-timing";
import { ALL_FORMATS, AudioSampleSink, BlobSource, NullTarget, Conversion, Input, Output, UrlSource, WavOutputFormat } from "mediabunny";
import { accumulatePeaks, ANALYSIS_WINDOW_MS, type AudioAnalysis } from "./audio-analysis";
import { transcriptionWav, writeTranscriptionPcm } from "./pcm-wav";

type Request = { source: string | Blob; chunk?: { startMs: number; endMs: number } };
const scope = self as unknown as { onmessage: ((event: MessageEvent<Request>) => void) | null; postMessage(message: unknown, transfer?: Transferable[]): void };

scope.onmessage = async ({ data }) => {
  const input = new Input({ source: typeof data.source === "string" ? new UrlSource(data.source) : new BlobSource(data.source), formats: ALL_FORMATS });
  try {
    if (data.chunk) {
      const { startMs, endMs } = data.chunk;
      if (![startMs, endMs].every(Number.isFinite) || startMs < 0 || endMs <= startMs || endMs - startMs > 300_000) throw new Error("Invalid audio chunk range");
      const track = await input.getPrimaryAudioTrack();
      if (!track || !await track.canDecode()) throw new Error("Source audio cannot be decoded in this browser");
      const buffer = transcriptionWav(endMs - startMs);
      const output = new Output({ format: new WavOutputFormat(), target: new NullTarget() });
      let samples = 0;
      const conversion = await Conversion.init({ input, output, trim: { start: startMs / 1000, end: endMs / 1000 }, video: { discard: true }, audio: (candidate) => candidate.id === track.id ? {
        codec: "pcm-s16", numberOfChannels: 2, sampleRate: 16_000,
        process: (sample) => {
          normalizePcmTimestamp(sample);
          const pcm = new Float32Array(sample.allocationSize({ format: "f32", planeIndex: 0 }) / 4);
          sample.copyTo(pcm, { format: "f32", planeIndex: 0 });
          writeTranscriptionPcm(buffer, pcm, sample.timestamp);
          samples += sample.numberOfFrames;
          return sample;
        },
      } : { discard: true } });
      if (!conversion.isValid) throw new Error("Cannot prepare transcription audio in this browser");
      try { await conversion.execute(); }
      catch (error) { if (samples || !String(error).includes("Cannot finalize an empty WAVE file")) throw error; }
      scope.postMessage({ chunk: buffer, offsetMs: startMs, hasSamples: samples > 0 }, [buffer]);
      return;
    }
    const video = await input.getPrimaryVideoTrack();
    const durationMs = Math.ceil((video ? await video.computeDuration() : await input.computeDuration()) * 1000);
    // Explicit analysis bound: at most ~17 MB of peak data for a 24-hour source.
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 86_400_000) throw new Error("Local audio analysis supports recordings up to 24 hours");
    const track = await input.getPrimaryAudioTrack();
    const peaks = new Float32Array(track ? Math.ceil(durationMs / ANALYSIS_WINDOW_MS) : 0).fill(-1);
    if (track) {
      if (!await track.canDecode()) throw new Error("This browser cannot decode this audio codec. No cloud processing was started.");
      const sink = new AudioSampleSink(track);
      for await (const sample of sink.samples()) {
        try {
          const pcm = new Float32Array(sample.allocationSize({ format: "f32", planeIndex: 0 }) / 4);
          sample.copyTo(pcm, { format: "f32", planeIndex: 0 });
          accumulatePeaks(peaks, pcm, sample.numberOfChannels, sample.sampleRate, sample.timestamp);
        } finally { sample.close(); }
      }
    }
    const result: AudioAnalysis = { durationMs, windowMs: ANALYSIS_WINDOW_MS, hasAudio: !!track, peaks };
    scope.postMessage({ result }, [peaks.buffer]);
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : "Local audio analysis failed" });
  } finally { input.dispose(); }
};
