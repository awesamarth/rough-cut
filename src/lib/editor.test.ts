import { describe, expect, test } from "bun:test";
import { applyCommand, createProjectState, exportSrt, timelineDuration } from "./editor";

describe("editing commands", () => {
  test("normalizes fractional media duration to whole milliseconds", () => {
    const state = createProjectState("00000000-0000-4000-8000-000000000000", "Short", 5866.667);
    expect(state.durationMs).toBe(5867);
    expect(state.clips[0].sourceOutMs).toBe(5867);
  });

  test("renames projects through the versioned command layer", () => {
    const state = createProjectState("00000000-0000-4000-8000-000000000000", "Untitled", 1000);
    const next = applyCommand(state, { type: "rename_project", expectedVersion: 0, actor: "human", name: "  Interview cut  " });
    expect(next.name).toBe("Interview cut");
    expect(next.version).toBe(1);
    expect(() => applyCommand(next, { type: "rename_project", expectedVersion: 1, actor: "human", name: "  " })).toThrow("1–120");
  });

  test("rejects stale and protected destructive edits", () => {
    let state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 10_000);
    state = applyCommand(state, { type: "protect_segment", expectedVersion: 0, actor: "human", startMs: 3000, endMs: 5000, label: "Keep" });
    expect(() => applyCommand(state, { type: "split_clip", expectedVersion: 0, actor: "agent", clipId: state.clips[0].id, sourceMs: 2000 })).toThrow("STALE_VERSION:1");
    expect(() => applyCommand(state, { type: "remove_segments", expectedVersion: 1, actor: "agent", ranges: [{ startMs: 4000, endMs: 4500 }] })).toThrow("Protected range");
  });

  test("removes a source range non-destructively", () => {
    const state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 10_000);
    const next = applyCommand(state, { type: "remove_segments", expectedVersion: 0, actor: "human", ranges: [{ startMs: 4000, endMs: 6000 }] });
    expect(next.clips.map((clip) => [clip.timelineStartMs, clip.sourceInMs, clip.sourceOutMs])).toEqual([[0, 0, 4000], [6000, 6000, 10_000]]);
    expect(timelineDuration(next)).toBe(10_000);
    expect(next.version).toBe(1);
  });

  test("supports lift and ripple-delete semantics", () => {
    let state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 5000);
    state = applyCommand(state, { type: "split_clip", expectedVersion: 0, actor: "human", clipId: state.clips[0].id, sourceMs: 1000 });
    const firstId = state.clips[0].id;
    const lifted = applyCommand(state, { type: "delete_clip", expectedVersion: 1, actor: "human", clipId: firstId });
    const rippled = applyCommand(state, { type: "delete_clip", expectedVersion: 1, actor: "human", clipId: firstId, ripple: true });
    expect(lifted.clips[0].timelineStartMs).toBe(1000);
    expect(rippled.clips[0].timelineStartMs).toBe(0);
  });

  test("normalizes clip transforms", () => {
    const state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 5000);
    const next = applyCommand(state, { type: "adjust_clip", expectedVersion: 0, actor: "human", clipId: state.clips[0].id, patch: { scaleX: 0.1, scaleY: 5, positionX: 40, positionY: -25 } });
    expect(next.clips[0]).toMatchObject({ scaleX: 0.25, scaleY: 4, positionX: 40, positionY: -25 });
  });

  test("edits captions and one bounded background-music track", () => {
    let state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 5000);
    state = applyCommand(state, { type: "add_caption", expectedVersion: 0, actor: "human", item: { text: "Hello", startMs: 0, endMs: 1000, position: "bottom" } });
    state = applyCommand(state, { type: "update_caption", expectedVersion: 1, actor: "human", id: state.captions[0].id, patch: { text: "Hello world", endMs: 1500 } });
    state = applyCommand(state, { type: "set_music", expectedVersion: 2, actor: "human", music: { assetId: "10000000-0000-4000-8000-000000000000", name: "bed.mp3", durationMs: 10_000, timelineStartMs: 0, sourceInMs: 0, sourceOutMs: 10_000, volume: 0.3, muted: false, fadeInMs: 250, fadeOutMs: 250, loop: false } });
    state = applyCommand(state, { type: "adjust_music", expectedVersion: 3, actor: "agent", clipId: state.music[0].id, patch: { volume: 9, timelineStartMs: 1000 } });
    expect(state.captions[0].text).toBe("Hello world");
    expect(exportSrt(state)).toContain("00:00:00,000 --> 00:00:01,500\nHello world");
    expect(state.music[0]).toMatchObject({ name: "bed.mp3", volume: 2, timelineStartMs: 1000, loop: false });
    expect(timelineDuration(state)).toBe(11_000);
    state = applyCommand(state, { type: "split_text", expectedVersion: 4, actor: "human", kind: "caption", id: state.captions[0].id, timelineMs: 500 });
    state = applyCommand(state, { type: "split_music", expectedVersion: 5, actor: "human", clipId: state.music[0].id, timelineMs: 5000 });
    expect(state.captions).toHaveLength(2);
    expect(state.music).toHaveLength(2);
    state = applyCommand(state, { type: "remove_music", expectedVersion: 6, actor: "human", clipId: state.music[0].id, ripple: true });
    expect(state.music).toHaveLength(1);
    expect(state.music[0].timelineStartMs).toBe(1000);
  });

  test("trims without rippling and allows non-overlapping gaps", () => {
    let state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 5000);
    state = applyCommand(state, { type: "split_clip", expectedVersion: 0, actor: "human", clipId: state.clips[0].id, sourceMs: 1000 });
    const second = state.clips[1];
    state = applyCommand(state, { type: "trim_clip", expectedVersion: 1, actor: "human", clipId: second.id, sourceInMs: 2000, sourceOutMs: 5000 });
    expect(state.clips.map((clip) => [clip.timelineStartMs, clip.sourceInMs, clip.sourceOutMs])).toEqual([[0, 0, 1000], [2000, 2000, 5000]]);
    expect(() => applyCommand(state, { type: "move_clip", expectedVersion: 2, actor: "human", clipId: second.id, timelineStartMs: 500 })).toThrow("Clips cannot overlap");
    const joined = applyCommand(state, { type: "move_clip", expectedVersion: 2, actor: "human", clipId: second.id, timelineStartMs: 1000 });
    expect(joined.clips[1].timelineStartMs).toBe(1000);
  });
});
