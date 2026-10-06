import { expect, test } from "bun:test";
import { applyCommand, createProjectState } from "./editor";
import { clipEnvelope, framePlan, musicGain } from "./composition";
import { fixMp4Timing } from "./mp4-timing";

test("composition uses the same transition and fade envelopes for video and audio", () => {
  let state = createProjectState("p", "Test", 4000);
  state = applyCommand(state, { type: "split_clip", actor: "human", expectedVersion: state.version, clipId: state.clips[0].id, sourceMs: 2000 });
  state = applyCommand(state, { type: "set_transition", actor: "human", expectedVersion: state.version, clipId: state.clips[0].id, transition: { type: "crossfade", durationMs: 500 } });
  const plan = framePlan(state, 1750);
  expect(plan.map((item) => item.sourceSeconds)).toEqual([1.75, 2.25]);
  expect(plan.map(({ video, audio }) => [video, audio])).toEqual([[1, 0.5], [0.5, 0.5]]);
  state = applyCommand(state, { type: "set_transition", actor: "human", expectedVersion: state.version, clipId: state.clips[0].id, transition: { type: "fade-black", durationMs: 500 } });
  expect(framePlan(state, 1750).map(({ video, audio }) => [video, audio])).toEqual([[0, 0], [0, 0]]);
  const clip = { ...state.clips[0], fadeInMs: 400 };
  expect(clipEnvelope(state, clip, 100, null)).toEqual({ video: 0.25, audio: 0.25 });
  expect(framePlan(state, 4000)).toEqual([]);
  expect(musicGain(0.5, false, 100, 0, 1000, 200, 200)).toBe(0.25);
  expect(musicGain(0.5, true, 500, 0, 1000, 0, 0)).toBe(0);
});

function box(type: string, payload: Uint8Array) {
  const data = new Uint8Array(payload.length + 8);
  new DataView(data.buffer).setUint32(0, data.length);
  data.set(new TextEncoder().encode(type), 4); data.set(payload, 8); return data;
}
function concat(...parts: Uint8Array[]) { const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; }

test("MP4 metadata patch writes AAC priming and rejects unsafe metadata", () => {
  const mvhd = new Uint8Array(100); new DataView(mvhd.buffer).setUint32(12, 1000);
  const mdhd = new Uint8Array(24); new DataView(mdhd.buffer).setUint32(12, 48000);
  const handler = new Uint8Array(24); handler.set(new TextEncoder().encode("soun"), 8);
  const track = box("trak", concat(box("tkhd", new Uint8Array(84)), box("mdia", concat(box("mdhd", mdhd), box("hdlr", handler)))));
  const original = box("moov", concat(box("mvhd", mvhd), track));
  const corrected = fixMp4Timing(original, 2, 2112 / 48000);
  expect(corrected.length).toBe(original.length + 44);
  const marker = new TextDecoder().decode(corrected).indexOf("elst");
  const edit = new DataView(corrected.buffer, marker + 4);
  expect(edit.getBigUint64(8)).toBe(BigInt(2000));
  expect(edit.getBigInt64(16)).toBe(BigInt(2112));
  expect(new DataView(original.buffer).getUint32(8 + 8 + 16)).toBe(0);
  expect(() => fixMp4Timing(corrected, 2, 0)).toThrow("existing AAC edit list");
  expect(() => fixMp4Timing(new Uint8Array([0, 0]), 2, 0)).toThrow("Truncated");
  expect(() => fixMp4Timing(original, 2, 1)).toThrow("Invalid MP4");
});
