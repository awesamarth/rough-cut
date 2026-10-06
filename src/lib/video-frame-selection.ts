import { FRAME_RATE } from "./composition";

type TimedFrame = { timestamp: number; duration: number };
const TIMESTAMP_EPSILON = 1e-7;

/**
 * Resample onto the composition clock without always rounding picture backwards.
 * A millisecond-based trim just before a native frame boundary can otherwise
 * choose the preceding frame on every 30fps tick (e.g. a persistent 16ms lag
 * for a 60fps source). Prefer the nearest adjacent frame, keeping ties stable.
 *
 * Lookahead is bounded to half an output frame in timeline time. Do not jump
 * decoded timestamp gaps or pick a frame at/after the clip's exclusive trim end.
 * The reader must retain its current/following pair: selecting the lookahead
 * for drawing must not advance the decoder cursor.
 */
export function selectVideoFrame<T extends TimedFrame>(
  current: T | undefined,
  following: T | undefined,
  time: number,
  sourceOutSeconds: number,
  speed = 1,
): T | undefined {
  if (!current || !following || following.timestamp >= sourceOutSeconds) return current;
  const ahead = following.timestamp - time;
  const behind = time - current.timestamp;
  const contiguous = following.timestamp <= current.timestamp + current.duration + TIMESTAMP_EPSILON;
  return contiguous && ahead >= 0 && ahead < behind && ahead <= speed / (2 * FRAME_RATE)
    ? following
    : current;
}
