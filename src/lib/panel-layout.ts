export const INSPECTOR_MIN_WIDTH = 220;
export const INSPECTOR_MAX_WIDTH = 520;
export const PREVIEW_MIN_WIDTH = 320;

export function clampInspectorWidth(width: number, paneWidth: number) {
  return Math.max(INSPECTOR_MIN_WIDTH, Math.min(INSPECTOR_MAX_WIDTH, paneWidth - PREVIEW_MIN_WIDTH, width));
}
