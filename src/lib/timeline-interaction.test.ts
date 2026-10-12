import { expect, test } from "bun:test";
import { centeredTimelineScroll, timelineWheelZoom } from "./timeline-interaction";

test("timeline zoom centres the playhead and clamps at boundaries without moving its timestamp", () => {
  expect(centeredTimelineScroll(5000, 10000, 2000, 500)).toBe(750);
  expect(centeredTimelineScroll(0, 10000, 2000, 500)).toBe(0);
  expect(centeredTimelineScroll(10000, 10000, 2000, 500)).toBe(1500);
  expect(centeredTimelineScroll(5000, 10000, 500, 500)).toBe(0);
  expect(centeredTimelineScroll(0, 0, 500, 500)).toBe(0);
});

test("wheel zoom normalizes units, accumulates steps and can magnify short timelines", () => {
  const next = timelineWheelZoom(1, 1000, 500, -16, 0);
  expect(timelineWheelZoom(1, 1000, 500, -1, 1)).toBe(next);
  expect(timelineWheelZoom(1, 1000, 500, -16 / 500, 2)).toBe(next);
  expect(timelineWheelZoom(next, 1000, 500, -16, 0)).toBeCloseTo(Math.exp(32 * 0.003));
  expect(timelineWheelZoom(1, 1000, 500, 10000, 0)).toBe(0.5);
  expect(timelineWheelZoom(1, 1000, 500, -10000, 0)).toBe(12);
  expect(timelineWheelZoom(1, 14, 500, -100, 0) * 14).toBeGreaterThan(500);
  expect(timelineWheelZoom(1, 0, 500, -100, 0)).toBe(1);
});
