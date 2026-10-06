import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { RESERVE_CLOUD_USAGE } from "./cloud-budget";
import { readBody } from "./request-body";
import { transcriptionDurationSeconds } from "./transcription-audio";

test("per-database reservations cannot exceed units or request limits", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(await Bun.file("migrations/0002_cloud_usage.sql").text());
    const reserve = (units: number, limit: number, requests: number) => db.query(RESERVE_CLOUD_USAGE).get("2026-01-01", "test", units, units, limit, requests, limit, requests);
    expect(reserve(6, 5, 3)).toBeNull();
    expect(reserve(3, 5, 2)).toEqual({ units: 3 });
    expect(reserve(3, 5, 2)).toBeNull();
    expect(reserve(2, 5, 2)).toEqual({ units: 5 });
    expect(reserve(1, 100, 2)).toBeNull();
  } finally { db.close(); }
});

test("request limits apply without Content-Length and cancel the stream", async () => {
  let canceled = false;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(4)); }, cancel() { canceled = true; } });
  const request = new Request("https://test.invalid", { method: "POST", body });
  await expect(readBody(request, 5)).rejects.toThrow("too large");
  expect(canceled).toBe(true);
});

function wav(frames: number) {
  const bytes = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(bytes);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, frames * 2, true);
  return bytes;
}

test("transcription bills admission from actual bounded PCM length, not client metadata", () => {
  expect(transcriptionDurationSeconds(wav(16000))).toBe(1);
  expect(transcriptionDurationSeconds(wav(300 * 16000))).toBe(300);
  expect(() => transcriptionDurationSeconds(wav(301 * 16000))).toThrow();
  const invalid = wav(16000); new DataView(invalid).setUint32(24, 8000, true);
  expect(() => transcriptionDurationSeconds(invalid)).toThrow();
  expect(() => transcriptionDurationSeconds(wav(16000).slice(0, 100))).toThrow();
});
