import { expect, test } from "bun:test";
import { applyEdit, bladeSplitCommand, createProjectState } from "./editor";

const fixture = () => createProjectState("00000000-0000-4000-8000-000000000000", "Blade", 10_000);

test("blade targets clicked retimed video and maps timeline to source without mutating the input", () => {
  const state = fixture();
  Object.assign(state.clips[0], { timelineStartMs: 500, sourceInMs: 1000, sourceOutMs: 9000, speed: 2 });
  const command = bladeSplitCommand(state, "video", state.clips[0].id, 1000)!;
  expect(command).toMatchObject({ type: "split_clip", sourceMs: 2000, expectedVersion: 0 });
  expect(state.clips).toHaveLength(1);
  const result = applyEdit({ state, transcript: [] }, command).state;
  expect(result.clips).toHaveLength(2);
  expect(result.clips[1]).toMatchObject({ timelineStartMs: 1000, sourceInMs: 2000, speed: 2 });
  for (const time of [0, 500, 4500, 5000, NaN, Infinity]) expect(bladeSplitCommand(state, "video", state.clips[0].id, time)).toBeNull();
  expect(bladeSplitCommand(state, "video", "missing", 1000)).toBeNull();
  expect(bladeSplitCommand(state, "unknown", state.clips[0].id, 1000)).toBeNull();
});

test("blade splits only the clicked caption/overlay at the pointer time", () => {
  for (const kind of ["caption", "overlay"] as const) {
    const state = fixture();
    const key = kind === "caption" ? "captions" : "overlays";
    state[key] = [{ id: "text", text: "hello", position: "bottom", startMs: 1000, endMs: 3000 }];
    const command = bladeSplitCommand(state, kind, "text", 1800)!;
    const result = applyEdit({ state, transcript: [] }, command).state;
    expect(result[key].map(({ startMs, endMs }) => [startMs, endMs])).toEqual([[1000, 1800], [1800, 3000]]);
    expect(result.clips).toHaveLength(1);
    for (const time of [1000, 3000]) expect(bladeSplitCommand(state, kind, "text", time)).toBeNull();
  }
});

test("blade uses existing music split semantics, including the loop restriction", () => {
  const state = fixture();
  const musicId = crypto.randomUUID();
  state.music = [{ id: musicId, assetId: crypto.randomUUID(), name: "Music", durationMs: 4000, timelineStartMs: 500, sourceInMs: 0, sourceOutMs: 3000, speed: 2, volume: 1, muted: false, fadeInMs: 0, fadeOutMs: 0, loop: false }];
  const result = applyEdit({ state, transcript: [] }, bladeSplitCommand(state, "music", musicId, 1000)!).state;
  expect(result.music).toHaveLength(2);
  expect(result.music[1]).toMatchObject({ timelineStartMs: 1000, sourceInMs: 1000 });
  expect(bladeSplitCommand(state, "music", musicId, 2000)).toBeNull();
  state.music[0].loop = true;
  expect(() => applyEdit({ state, transcript: [] }, bladeSplitCommand(state, "music", musicId, 1000)!)).toThrow("Disable music looping before splitting");
  expect(state.music).toHaveLength(1);
});
