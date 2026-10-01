import { expect, test } from "bun:test";
import { accumulatePeaks, ANALYSIS_WINDOW_MS, silenceCandidates, waveformPeaks, type AudioAnalysis } from "./audio-analysis";

test("opposite-phase stereo remains audible and decoded silence is detected", () => {
  const peaks = new Float32Array(50).fill(-1);
  const pcm = new Float32Array(2000);
  for (let frame = 0; frame < 500; frame++) { pcm[frame * 2] = 0.5; pcm[frame * 2 + 1] = -0.5; }
  accumulatePeaks(peaks, pcm, 2, 1000, 0);
  const analysis: AudioAnalysis = { durationMs: 1000, windowMs: ANALYSIS_WINDOW_MS, hasAudio: true, peaks };
  expect(silenceCandidates(analysis, -35, 100)).toEqual([{ startMs: 500, endMs: 1000 }]);
  expect(waveformPeaks(analysis, 2)).toEqual([1, 0]);
});

test("missing samples and an absent audio track are not silence evidence", () => {
  const analysis: AudioAnalysis = { durationMs: 1000, windowMs: 20, hasAudio: true, peaks: new Float32Array(50).fill(-1) };
  expect(silenceCandidates(analysis, -35, 100)).toEqual([]);
  expect(silenceCandidates({ ...analysis, hasAudio: false, peaks: new Float32Array(50) }, -35, 100)).toEqual([]);
  expect(() => silenceCandidates(analysis, NaN, 100)).toThrow();
});

test("peaks use media timestamps rather than packet boundaries", () => {
  const peaks = new Float32Array(50).fill(-1);
  accumulatePeaks(peaks, new Float32Array(500), 1, 1000, 0.5);
  expect(silenceCandidates({ durationMs: 1000, windowMs: 20, hasAudio: true, peaks }, -35, 500)).toEqual([{ startMs: 500, endMs: 1000 }]);
});
