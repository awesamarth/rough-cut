import { expect, test } from "bun:test";
import { applyCommand, createProjectState } from "@/lib/editor";
import { compactMutationResult } from "./use-webmcp";

const projectId = "00000000-0000-4000-8000-000000000000";

test("WebMCP mutations return compact structured diffs", () => {
  const before = createProjectState(projectId, "Demo", 10_000);
  const adjusted = applyCommand(before, { type: "adjust_clip", expectedVersion: 0, actor: "agent", clipId: before.clips[0].id, patch: { volume: 3 } });
  const adjustment = compactMutationResult(before, adjusted);
  expect(adjustment.project_version).toBe(1);
  expect(adjustment.diff).toEqual({ clips: { changed: [{ id: before.clips[0].id, fields: { volume: { from: 1, to: 3 } } }] } });

  const split = applyCommand(adjusted, { type: "split_clip", expectedVersion: 1, actor: "agent", clipId: adjusted.clips[0].id, sourceMs: 5000 });
  expect(compactMutationResult(adjusted, split).diff).toMatchObject({ clips: { created: [split.clips[1].id] } });
});
