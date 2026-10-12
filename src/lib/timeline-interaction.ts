/** Focus the timeline before drag handlers cancel the browser's default focus
 * transfer. Native blur commits any pending inspector edit before selection or
 * seeking; preventScroll keeps this from disturbing the timeline viewport. */
export function focusTimeline(timeline: Pick<HTMLElement, "focus">) {
  timeline.focus({ preventScroll: true });
}

export function centeredTimelineScroll(playheadMs: number, totalMs: number, trackWidth: number, viewportWidth: number) {
  if (totalMs <= 0 || trackWidth <= viewportWidth) return 0;
  const ratio = Math.max(0, Math.min(1, playheadMs / totalMs));
  return Math.max(0, Math.min(trackWidth - viewportWidth, ratio * trackWidth - viewportWidth / 2));
}

/** Wheel units differ between mice/trackpads. Zoom is independent of pointer X.
 * Include the fit-to-view scale so even very short projects can zoom in. */
export function timelineWheelZoom(zoom: number, naturalWidth: number, viewportWidth: number, deltaY: number, deltaMode: number) {
  if (naturalWidth <= 0 || viewportWidth <= 0 || !Number.isFinite(deltaY)) return zoom;
  const minimum = viewportWidth / naturalWidth;
  const maximum = Math.max(12, minimum * 12);
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? viewportWidth : 1;
  return Math.max(minimum, Math.min(maximum, Math.max(minimum, zoom) * Math.exp(-deltaY * unit * 0.003)));
}
