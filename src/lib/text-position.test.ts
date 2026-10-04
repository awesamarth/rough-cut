import { expect, test } from "bun:test";
import { applyCommand, createProjectState, validateState } from "./editor";
import { textBoxPosition } from "./text-position";
import { drawText } from "./video-renderer";

test("XY text placement preserves presets and clamps the entire box inside the frame", () => {
  expect(textBoxPosition({ position: "bottom" }, 200, 40, 10)).toEqual({ centreX: 960, top: 980 });
  expect(textBoxPosition({ position: "top", x: 50, y: 50 }, 200, 40, 10)).toEqual({ centreX: 960, top: 520 });
  expect(textBoxPosition({ position: "center", x: 0, y: 0 }, 200, 40, 10)).toEqual({ centreX: 110, top: 10 });
  expect(textBoxPosition({ position: "center", x: 100, y: 100 }, 200, 40, 10)).toEqual({ centreX: 1810, top: 1030 });
});

test("text coordinates and opacity persist, split and reset through shared commands", () => {
  const state = createProjectState("p", "Text", 3000);
  const added = applyCommand(state, { type: "add_overlay", actor: "human", expectedVersion: 0, item: { text: "Test", startMs: 0, endMs: 3000, position: "center", x: 25, y: 75, backgroundOpacity: 0 } });
  validateState(JSON.parse(JSON.stringify(added)));
  const split = applyCommand(added, { type: "split_text", actor: "human", expectedVersion: 1, kind: "overlay", id: added.overlays[0].id, timelineMs: 1000 });
  expect(split.overlays.every((item) => item.x === 25 && item.y === 75 && item.backgroundOpacity === 0)).toBe(true);
  const reset = applyCommand(added, { type: "update_overlay", actor: "agent", expectedVersion: 1, id: added.overlays[0].id, patch: { position: "top", x: undefined, y: undefined } });
  expect(reset.overlays[0].x).toBeUndefined();
  expect(reset.overlays[0].position).toBe("top");
  for (const patch of [{ x: -1 }, { y: 101 }, { x: NaN }, { backgroundOpacity: 1.1 }, { backgroundOpacity: Infinity }]) {
    expect(() => applyCommand(added, { type: "update_overlay", actor: "human", expectedVersion: 1, id: added.overlays[0].id, patch })).toThrow();
  }
});

test("shared canvas renderer places text and its background together, including zero opacity", () => {
  for (const opacity of [0, 0.47, 1]) {
    const state = createProjectState("p", "Text", 3000);
    state.overlays = [{ id: "o", text: "Test", startMs: 0, endMs: 3000, position: "center", x: 25, y: 75, background: true, backgroundOpacity: opacity }];
    let textX = 0, textY = 0, boxX = 0, boxY = 0, boxStyle = "";
    const ctx = {
      fillStyle: "", save() {}, restore() {},
      measureText() { return { width: 200, actualBoundingBoxAscent: 35, actualBoundingBoxDescent: 5 }; },
      fillRect(x: number, y: number) { boxX = x; boxY = y; boxStyle = this.fillStyle; },
      fillText(_text: string, x: number, y: number) { textX = x; textY = y; },
    };
    drawText(ctx as unknown as CanvasRenderingContext2D, state, 100);
    expect(textX).toBe(480);
    expect(boxX).toBe(370);
    expect(boxY).toBe(780);
    expect(textY).toBe(825);
    expect(boxStyle).toBe(`rgb(0 0 0 / ${opacity})`);
  }
});
