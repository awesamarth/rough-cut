export const ANALYSIS_WINDOW_MS = 20;
export type AudioAnalysis = { durationMs: number; windowMs: number; peaks: Float32Array; hasAudio: boolean };

/** Peak over every channel: opposite-phase stereo must never be mistaken for silence. */
export function accumulatePeaks(peaks: Float32Array, pcm: Float32Array, channels: number, sampleRate: number, timestamp: number) {
  if (!Number.isInteger(channels) || channels < 1 || !Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(timestamp) || pcm.length % channels) throw new Error("Invalid decoded audio");
  for (let frame = 0; frame < pcm.length / channels; frame++) {
    const bucket = Math.floor((timestamp * 1000 + frame / sampleRate * 1000) / ANALYSIS_WINDOW_MS);
    if (bucket < 0 || bucket >= peaks.length) continue;
    let peak = 0;
    for (let channel = 0; channel < channels; channel++) {
      const value = pcm[frame * channels + channel];
      if (!Number.isFinite(value)) throw new Error("Invalid audio sample");
      peak = Math.max(peak, Math.abs(value));
    }
    peaks[bucket] = Math.max(peaks[bucket], peak);
  }
}

export function silenceCandidates(analysis: AudioAnalysis, thresholdDb: number, minimumMs: number) {
  if (!Number.isFinite(thresholdDb) || thresholdDb < -60 || thresholdDb > -10 || !Number.isFinite(minimumMs) || minimumMs < 100 || minimumMs > 5000) throw new Error("Invalid silence settings");
  if (!analysis.hasAudio) return [];
  const threshold = 10 ** (thresholdDb / 20);
  const ranges: Array<{ startMs: number; endMs: number }> = [];
  let start = -1;
  for (let index = 0; index <= analysis.peaks.length; index++) {
    const peak = analysis.peaks[index];
    // -1 represents missing/undecoded audio, NOT evidence of silence.
    if (index < analysis.peaks.length && peak >= 0 && peak <= threshold) {
      if (start < 0) start = index * analysis.windowMs;
    } else if (start >= 0) {
      const endMs = Math.min(analysis.durationMs, index * analysis.windowMs);
      if (endMs - start >= minimumMs) ranges.push({ startMs: start, endMs });
      start = -1;
    }
  }
  return ranges;
}

export function waveformPeaks(analysis: AudioAnalysis, count = 4000) {
  if (!analysis.hasAudio || !analysis.peaks.length) return [];
  const step = Math.max(1, Math.ceil(analysis.peaks.length / count));
  const result: number[] = [];
  let maximum = 0.01;
  for (let start = 0; start < analysis.peaks.length; start += step) {
    let peak = 0;
    for (let index = start; index < Math.min(start + step, analysis.peaks.length); index++) peak = Math.max(peak, analysis.peaks[index]);
    maximum = Math.max(maximum, peak);
    result.push(peak);
  }
  return result.map((peak) => Math.min(1, peak / maximum));
}
