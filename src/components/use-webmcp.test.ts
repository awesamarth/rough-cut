import { expect, test } from "bun:test";
import { applyCommand, createProjectState } from "@/lib/editor";
import { boundedInteger, compactMutationResult, coordinatePatch } from "./use-webmcp";

test("tool pagination rejects values that would bypass bounded output", () => {
  for (const value of [-1, 0, 501, Infinity, NaN, 1.5, "500"]) expect(() => boundedInteger(value, 1, 500, "limit")).toThrow();
  expect(boundedInteger(500, 1, 500, "limit")).toBe(500);
});

test("agent coordinate updates match human preset/reset semantics and reject invalid coordinates", () => {
  expect(coordinatePatch({ x: 0, y: 100 })).toEqual({ x: 0, y: 100 });
  expect(coordinatePatch({ position: "top" })).toEqual({ x: undefined, y: undefined });
  expect(coordinatePatch({ position: "center", x: 25 })).toEqual({ x: 25, y: undefined });
  expect(coordinatePatch({})).toEqual({});
  for (const value of [-1, 101, NaN, Infinity, "50"]) expect(() => coordinatePatch({ x: value })).toThrow();
});

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
