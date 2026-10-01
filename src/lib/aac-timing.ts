import { ALL_FORMATS, AudioSample, AudioSampleSink, AudioSampleSource, BlobSource, BufferTarget, Input, Mp4OutputFormat, Output } from "mediabunny";
import { AUDIO_RATE } from "./composition";

/** Measure through an actual MP4, not browser/OS heuristics or bare codec round trips. */
export async function measureAacDelay(signal: AbortSignal) {
  const frames = AUDIO_RATE;
  const reference = new Float32Array(frames);
  for (let index = 0; index < frames; index++) {
    const t = index / AUDIO_RATE;
    reference[index] = t >= 0.15 && t < 0.85 ? Math.sin(2 * Math.PI * (350 * t + 900 * t * t)) * 0.3 : 0;
  }
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
  const source = new AudioSampleSource({ codec: "aac", bitrate: 192_000 });
  output.addAudioTrack(source);
  let input: Input | undefined;
  try {
    await output.start();
    for (let first = 0; first < frames; first += 1600) {
      signal.throwIfAborted();
      const count = Math.min(1600, frames - first);
      const pcm = new Float32Array(count * 2);
      for (let index = 0; index < count; index++) pcm[index * 2] = pcm[index * 2 + 1] = reference[first + index];
      const sample = new AudioSample({ data: pcm, format: "f32", numberOfChannels: 2, sampleRate: AUDIO_RATE, timestamp: first / AUDIO_RATE });
      try { await source.add(sample); } finally { sample.close(); }
    }
    source.close(); await output.finalize();
    if (!target.buffer) throw new Error("AAC timing probe produced no file");
    input = new Input({ source: new BlobSource(new Blob([target.buffer])), formats: ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error("AAC timing probe has no audio");
    const decoded = new Float32Array(AUDIO_RATE * 2);
    for await (const sample of new AudioSampleSink(track).samples()) {
      try {
        signal.throwIfAborted();
        const pcm = new Float32Array(sample.numberOfFrames);
        sample.copyTo(pcm, { format: "f32-planar", planeIndex: 0 });
        const offset = Math.round(sample.timestamp * AUDIO_RATE);
        for (let index = 0; index < pcm.length; index++) if (offset + index >= 0 && offset + index < decoded.length) decoded[offset + index] = pcm[index];
      } finally { sample.close(); }
    }
    const correlation = (delay: number) => {
      let dot = 0, a = 0, b = 0;
      for (let index = 12000; index < 18000; index++) {
        const x = reference[index], y = decoded[index + delay];
        dot += x * y; a += x * x; b += y * y;
      }
      return dot / Math.sqrt(a * b || 1);
    };
    let delay = 0, score = -Infinity;
    for (let candidate = 0; candidate <= 8192; candidate += 4) {
      const value = correlation(candidate);
      if (value > score) { score = value; delay = candidate; }
    }
    const coarse = delay;
    for (let candidate = Math.max(0, coarse - 4); candidate <= coarse + 4; candidate++) {
      const value = correlation(candidate);
      if (value > score) { score = value; delay = candidate; }
    }
    if (score < 0.98) throw new Error("Could not verify AAC synchronization on this browser; no export was produced");
    return { seconds: delay / AUDIO_RATE, frames: delay, correlation: score };
  } finally {
    input?.dispose();
    if (output.state !== "finalized" && output.state !== "canceled") await output.cancel().catch(() => {});
  }
}
