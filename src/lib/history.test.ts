import { expect, test } from "bun:test";
import { createProjectState } from "./editor";
import { advanceHistory, boundHistory } from "./local-store";

test("history retains closest steps within count and size limits", () => {
  const state = createProjectState("p", "History", 1000);
  const past = Array.from({ length: 101 }, (_, version) => ({ state: { ...state, version }, transcript: [] }));
  const bounded = boundHistory(past, []);
  expect(bounded.past).toHaveLength(100);
  expect(bounded.past[0].state.version).toBe(1);
  const undone = advanceHistory(bounded.past, [], { state: { ...state, version: 101 }, transcript: [] }, "undo");
  expect(undone.past).toHaveLength(99);
  expect(undone.future[0].state.version).toBe(101);
  const large = { state, transcript: [{ id: "w", word: "x".repeat(5 * 1024 * 1024), startMs: 0, endMs: 100 }] };
  expect(boundHistory([large, large], []).past).toHaveLength(1);
  const mixed = boundHistory([large], [large]);
  expect(mixed.past.length + mixed.future.length).toBe(1);
});
