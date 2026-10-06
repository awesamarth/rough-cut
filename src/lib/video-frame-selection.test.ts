import { expect, test } from "bun:test";
import { selectVideoFrame } from "./video-frame-selection";

const frame = (timestamp: number, duration = 1 / 60) => ({ timestamp, duration });

test("60fps source trimmed just below a boundary does not lag every 30fps output tick", () => {
  // Opening, later ticks, either side of the plain split, and final opening tick.
  for (const index of [0, 1, 30, 109, 110, 167]) {
    const time = 10.466 + index / 30;
    const current = frame(Math.floor(time * 60) / 60);
    const following = frame(current.timestamp + 1 / 60);
    const selected = selectVideoFrame(current, following, time, 16.064)!;
    expect(selected).toBe(following);
    expect((selected.timestamp - time) * 1000).toBeCloseTo(2 / 3, 7);
  }
});

test("a new cut has its own sampling phase, without a global video/audio shift", () => {
  const time = 94.966 + (11 - 10.978);
  const current = frame(Math.floor(time * 60) / 60);
  const following = frame(current.timestamp + 1 / 60);
  expect(selectVideoFrame(current, following, time, 96.795)).toBe(current);
  expect((current.timestamp - time) * 1000).toBeCloseTo(-14 / 3, 7);
});

test("exact timestamps and midpoint ties keep the current frame", () => {
  const current = frame(1, 0.02), following = frame(1.02, 0.02);
  expect(selectVideoFrame(current, following, 1, 2)).toBe(current);
  expect(selectVideoFrame(current, following, 1.01, 2)).toBe(current);
  expect(selectVideoFrame(current, following, 1.019, 2)).toBe(following);
});

test("lookahead cannot resurrect a frame beyond the exclusive source trim", () => {
  const current = frame(1), following = frame(1 + 1 / 60);
  expect(selectVideoFrame(current, following, 1.016, following.timestamp)).toBe(current);
  expect(selectVideoFrame(current, following, 1.016, 1.0165)).toBe(current);
  expect(selectVideoFrame(current, following, 1.016, 1.02)).toBe(following);
});

test("VFR long holds and timestamp gaps do not pull distant future pictures forward", () => {
  const current = frame(1, 1), following = frame(2, 1);
  expect(selectVideoFrame(current, following, 1.8, 3)).toBe(current);
  const beforeGap = frame(1, 0.01), afterGap = frame(1.03, 0.01);
  expect(selectVideoFrame(beforeGap, afterGap, 1.025, 2)).toBe(beforeGap);
});

test("half-output-frame lookahead is measured in timeline time at different speeds", () => {
  const current = frame(1, 0.06), following = frame(1.06, 0.06);
  expect(selectVideoFrame(current, following, 1.035, 2, 1)).toBe(current);
  expect(selectVideoFrame(current, following, 1.035, 2, 2)).toBe(following);
  const slowCurrent = frame(1), slowFollowing = frame(1 + 1 / 60);
  expect(selectVideoFrame(slowCurrent, slowFollowing, 1.01, 2, 0.25)).toBe(slowCurrent);
});

test("missing lookahead and exhausted tracks keep the available frame", () => {
  const current = frame(1);
  expect(selectVideoFrame(current, undefined, 1.01, 2)).toBe(current);
  expect(selectVideoFrame(undefined, undefined, 1, 2)).toBeUndefined();
});
