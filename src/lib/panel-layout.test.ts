import { expect, test } from "bun:test";
import { clampInspectorWidth } from "./panel-layout";

test("Inspector resizing keeps usable bounds for both panes", () => {
  expect(clampInspectorWidth(270, 1200)).toBe(270);
  expect(clampInspectorWidth(270 + 100, 1200)).toBe(370); // Move divider left.
  expect(clampInspectorWidth(270 - 100, 1200)).toBe(220);
  expect(clampInspectorWidth(2000, 1200)).toBe(520);
  expect(clampInspectorWidth(400, 600)).toBe(280); // Reserve 320px for preview.
  expect(clampInspectorWidth(270 + 40, 1200)).toBe(310); // Shift + arrow.
});
