import type { TimedText } from "./editor";
import { FRAME_HEIGHT, FRAME_WIDTH } from "./composition";

/** Coordinates describe the centre of the measured text box, not its baseline. */
export function textBoxPosition(item: Pick<TimedText, "position" | "x" | "y">, width: number, height: number, padding: number) {
  const clampCentre = (value: number, extent: number, size: number) => Math.max(size / 2 + padding, Math.min(extent - size / 2 - padding, value));
  const centreX = item.x === undefined ? FRAME_WIDTH / 2 : clampCentre(item.x * FRAME_WIDTH / 100, FRAME_WIDTH, width);
  const presetTop = item.position === "top" ? 60 : item.position === "bottom" ? FRAME_HEIGHT - 60 - height : (FRAME_HEIGHT - height) / 2;
  const top = item.y === undefined ? presetTop : clampCentre(item.y * FRAME_HEIGHT / 100, FRAME_HEIGHT, height) - height / 2;
  return { centreX, top };
}
