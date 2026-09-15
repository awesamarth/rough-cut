import { expect, test } from "bun:test";
import { transcriptionWav, writeTranscriptionPcm } from "./pcm-wav";
import { transcriptionDurationSeconds } from "./transcription-audio";

test("WAV preparation preserves source gaps and phase-inverted speech", () => {
  const wav = transcriptionWav(1000);
  const pcm = new Float32Array(3200);
  for (let index = 0; index < pcm.length; index += 2) { pcm[index] = 0.5; pcm[index + 1] = -0.5; }
  writeTranscriptionPcm(wav, pcm, 0.5);
  const view = new DataView(wav);
  expect(transcriptionDurationSeconds(wav)).toBe(1);
  expect(view.getInt16(44 + 16000 * 0.25 * 2, true)).toBe(0);
  expect(view.getInt16(44 + 16000 * 0.55 * 2, true)).toBe(16384);
  expect(view.getInt16(44 + 16000 * 0.75 * 2, true)).toBe(0);
  expect(() => transcriptionWav(300001)).toThrow();
  expect(() => writeTranscriptionPcm(wav, new Float32Array([NaN, 0]), 0)).toThrow();
  expect(() => writeTranscriptionPcm(wav, pcm, Infinity)).toThrow();
});
