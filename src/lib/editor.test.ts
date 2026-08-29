import { describe, expect, test } from "bun:test";
import { applyCommand, createProjectState, timelineDuration } from "./editor";

describe("editing commands", () => {
  test("rejects stale and protected destructive edits", () => {
    let state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 10_000);
    state = applyCommand(state, { type: "protect_segment", expectedVersion: 0, actor: "human", startMs: 3000, endMs: 5000, label: "Keep" });
    expect(() => applyCommand(state, { type: "split_clip", expectedVersion: 0, actor: "agent", clipId: state.clips[0].id, sourceMs: 2000 })).toThrow("STALE_VERSION:1");
    expect(() => applyCommand(state, { type: "remove_segments", expectedVersion: 1, actor: "agent", ranges: [{ startMs: 4000, endMs: 4500 }] })).toThrow("Protected range");
  });

  test("removes a source range non-destructively", () => {
    const state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 10_000);
    const next = applyCommand(state, { type: "remove_segments", expectedVersion: 0, actor: "human", ranges: [{ startMs: 4000, endMs: 6000 }] });
    expect(next.clips.map((clip) => [clip.sourceInMs, clip.sourceOutMs])).toEqual([[0, 4000], [6000, 10_000]]);
    expect(timelineDuration(next)).toBe(8000);
    expect(next.version).toBe(1);
  });
});
