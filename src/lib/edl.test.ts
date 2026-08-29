import { expect, test } from "bun:test";
import { applyCommand, createProjectState } from "./editor";
import { exportEdl } from "./edl";

test("exports ordered source and record timecodes", () => {
  let state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 10_000);
  state = applyCommand(state, { type: "split_clip", expectedVersion: 0, actor: "human", clipId: state.clips[0].id, sourceMs: 4000 });
  const edl = exportEdl(state);
  expect(edl).toContain("TITLE: Demo");
  expect(edl).toContain("001  AX");
  expect(edl).toContain("002  AX");
  expect(edl).toContain("00:00:04:00");
});
