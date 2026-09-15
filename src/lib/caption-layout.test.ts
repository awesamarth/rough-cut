import { expect, test } from "bun:test";
import { createProjectState } from "./editor";
import { drawText } from "./video-renderer";

test("caption backgrounds center measured glyphs, including multiline descenders", () => {
  for (const text of ["transactions for", "transactions for\ngy"]) {
    const state = createProjectState("test", "Captions", 3000);
    state.captions = [{ id: "caption", text, startMs: 0, endMs: 3000, position: "bottom" }];
    state.captionStyle.background = true;
    const baselines: number[] = [];
    let boxTop = 0, boxHeight = 0;
    const context = {
      font: "", shadowColor: "", textBaseline: "",
      save() {}, restore() {},
      measureText(line: string) { return { width: line.length * 20, actualBoundingBoxAscent: 35, actualBoundingBoxDescent: line === "gy" ? 10 : 0 }; },
      fillRect(_x: number, y: number, _w: number, h: number) { boxTop = y; boxHeight = h; },
      fillText(_line: string, _x: number, y: number) { baselines.push(y); },
    };
    drawText(context as unknown as CanvasRenderingContext2D, state, 500);
    const topPadding = baselines[0] - 35 - boxTop;
    const bottomPadding = boxTop + boxHeight - (baselines.at(-1)! + (text.includes("\n") ? 10 : 0));
    expect(topPadding).toBeCloseTo(8);
    expect(bottomPadding).toBeCloseTo(topPadding);
    expect(context.font).toContain("600 ");
    expect(context.font).toContain("RoughCutCaptions");
    expect(context.shadowColor).toBe("#0006");
  }
});
