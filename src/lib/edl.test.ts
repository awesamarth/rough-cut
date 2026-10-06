import { expect, test } from "bun:test";
import { applyCommand, createProjectState } from "./editor";
import { exportEdl } from "./edl";

test("exports ordered source and record timecodes", () => {
  let state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 10_000);
  state = applyCommand(state, { type: "split_clip", expectedVersion: 0, actor: "human", clipId: state.clips[0].id, sourceMs: 4000 });
  // Unsorted storage, a nonzero source trim, and a timeline gap distinguish
  // source timecodes from record timecodes and exercise chronological ordering.
  state = applyCommand(state, { type: "trim_clip", expectedVersion: 1, actor: "human", clipId: state.clips[1].id, sourceInMs: 5000, sourceOutMs: 9000 });
  state = applyCommand(state, { type: "move_clip", expectedVersion: 2, actor: "human", clipId: state.clips[1].id, timelineStartMs: 6000 });
  state.clips.reverse();
  const edl = exportEdl(state);
  expect(edl).toContain("TITLE: Demo");
  expect(edl.split("\n").filter((line) => /^\d{3}\s/.test(line)).map((line) => line.trim().split(/\s+/))).toEqual([
    ["001", "AX", "V", "C", "00:00:00:00", "00:00:04:00", "00:00:00:00", "00:00:04:00"],
    ["002", "AX", "V", "C", "00:00:05:00", "00:00:09:00", "00:00:06:00", "00:00:10:00"],
  ]);
  expect(state.clips[0].sourceInMs).toBe(5000); // Export must not reorder saved state.
});
