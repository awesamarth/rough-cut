import { expect, test } from "bun:test";
import { applyCommand, applyEdit, createProjectState, validateState, type EditorCommand, type ProjectState } from "./editor";

const base = () => createProjectState("00000000-0000-4000-8000-000000000000", "Safety", 10_000);
type Input = EditorCommand extends infer C ? C extends EditorCommand ? Omit<C, "actor" | "expectedVersion"> : never : never;
const edit = (state: ProjectState, command: Input) => applyCommand(state, { ...command, actor: "human", expectedVersion: state.version } as EditorCommand);

test("speed changes reflow following clips, preserve gaps and retime text", () => {
  let state = base();
  state = edit(state, { type: "split_clip", clipId: state.clips[0].id, sourceMs: 2000 });
  state = edit(state, { type: "split_clip", clipId: state.clips[1].id, sourceMs: 4000 });
  state = edit(state, { type: "set_transition", clipId: state.clips[0].id, transition: { type: "crossfade", durationMs: 1000 } });
  state = edit(state, { type: "move_clip", clipId: state.clips[2].id, timelineStartMs: 4000 });
  state.overlays = [{ id: "label", text: "Follow this clip", startMs: 4500, endMs: 5500, position: "bottom" }];
  state = edit(state, { type: "adjust_clip", clipId: state.clips[1].id, patch: { speed: 2 } });
  expect(state.clips.map((clip) => clip.timelineStartMs)).toEqual([0, 1500, 3500]);
  expect(state.clips[0].transition.durationMs).toBe(500);
  expect(state.overlays[0]).toMatchObject({ startMs: 4000, endMs: 5000 });
  state = edit(state, { type: "adjust_clip", clipId: state.clips[1].id, patch: { speed: 0.5 } });
  expect(state.clips[2].timelineStartMs).toBe(6500);
  expect(state.overlays[0]).toMatchObject({ startMs: 7000, endMs: 8000 });
  expect(() => validateState(state)).not.toThrow();
});

test("persisted clip fields are validated, not silently normalized", () => {
  for (const patch of [{ speed: -1 }, { speed: null }, { volume: 999 }, { muted: "no" }, { brightness: "garbage" }, { fadeInMs: -1 }, { contrast: NaN }]) {
    const state = base();
    Object.assign(state.clips[0], patch);
    expect(() => validateState(state)).toThrow();
  }
});

test("transition round trip preserves following gaps and transitions", () => {
  let state = base();
  state = edit(state, { type: "split_clip", clipId: state.clips[0].id, sourceMs: 3000 });
  state = edit(state, { type: "split_clip", clipId: state.clips[1].id, sourceMs: 6000 });
  const before = structuredClone(state.clips);
  state = edit(state, { type: "set_transition", clipId: state.clips[0].id, transition: { type: "crossfade", durationMs: 500 } });
  expect(state.clips.map((c) => c.timelineStartMs)).toEqual([0, 2500, 5500]);
  state = edit(state, { type: "set_transition", clipId: state.clips[0].id, transition: { type: "cut", durationMs: 0 } });
  expect(state.clips).toEqual(before);
  expect(() => validateState(state)).not.toThrow();
});

test("shortening timeline clips crossing text and removes text beyond its end", () => {
  let state = base();
  state = edit(state, { type: "add_overlay", item: { text: "Crossing", startMs: 4000, endMs: 6000, position: "center" } });
  state = edit(state, { type: "add_overlay", item: { text: "Outside", startMs: 8000, endMs: 9500, position: "bottom" } });
  state = edit(state, { type: "trim_clip", clipId: state.clips[0].id, sourceInMs: 0, sourceOutMs: 5000 });
  expect(state.overlays).toHaveLength(1);
  expect(state.overlays[0].endMs).toBe(5000);
  expect(() => validateState(state)).not.toThrow();
});

test("reorder requires an exact permutation", () => {
  let state = base();
  state = edit(state, { type: "split_clip", clipId: state.clips[0].id, sourceMs: 5000 });
  expect(() => edit(state, { type: "reorder_clips", clipIds: [state.clips[0].id, state.clips[1].id, state.clips[1].id] })).toThrow();
});

test("complete edit engine partitions anchors without a React hook", () => {
  const state = base();
  state.captions = [{ id: "caption", text: "hello world", startMs: 1000, endMs: 2000, position: "bottom", sourceWordIds: ["a", "b"] }];
  const transcript = [{ id: "a", word: "hello", startMs: 1000, endMs: 1400 }, { id: "b", word: "world", startMs: 1600, endMs: 2000 }];
  const result = applyEdit({ state, transcript }, { type: "split_text", actor: "agent", expectedVersion: 0, kind: "caption", id: "caption", timelineMs: 1500 });
  expect(result.state.captions.map((c) => [c.text, c.sourceWordIds])).toEqual([["hello", ["a"]], ["world", ["b"]]]);
  expect(result.transcript).toBe(transcript);
  expect(state.captions).toHaveLength(1);
});

test("invalid commands never install an invalid project", () => {
  const state = base();
  expect(() => edit(state, { type: "add_overlay", item: { text: "Bad", startMs: 0, endMs: 1000, position: "center", fontSize: 1000 } })).toThrow();
  expect(() => edit(state, { type: "adjust_clip", clipId: state.clips[0].id, patch: { speed: NaN } })).toThrow();
  expect(state.version).toBe(0);
});
