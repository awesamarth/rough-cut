import { ALL_FORMATS, BlobSource, CanvasSink, Input, UrlSource } from "mediabunny";
import { FRAME_HEIGHT, FRAME_WIDTH, framePlan, TEXT_COLORS } from "./composition";
import type { ProjectState } from "./editor";
import { ensureTrackDecodable } from "./codec-support";
import { textBoxPosition } from "./text-position";
import { selectVideoFrame } from "./video-frame-selection";

export type MediaSource = Blob | string;
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Frame = NonNullable<Awaited<ReturnType<CanvasSink["getCanvas"]>>>;

class FrameReader {
  private iterator?: AsyncGenerator<Frame, void, unknown>;
  private current?: Frame;
  private following?: Frame;
  private last = -Infinity;
  constructor(private sink: CanvasSink) {}
  async get(time: number, sourceOutSeconds: number, speed: number) {
    if (!this.iterator || time < this.last || time - this.last > 2) {
      await this.close();
      this.iterator = this.sink.canvases(time);
      this.current = (await this.iterator.next()).value || undefined;
      this.following = (await this.iterator.next()).value || undefined;
    }
    while (this.following && this.following.timestamp <= time + 1e-7) {
      this.current = this.following;
      this.following = (await this.iterator.next()).value || undefined;
    }
    this.last = time;
    return selectVideoFrame(this.current, this.following, time, sourceOutSeconds, speed)?.canvas;
  }
  async close() { await this.iterator?.return(); this.iterator = undefined; this.current = undefined; this.following = undefined; }
}

let fontPromise: Promise<unknown> | undefined;
export function loadCompositionFont() {
  return fontPromise ??= (async () => {
    const fonts = (globalThis as unknown as { fonts?: FontFaceSet; document?: Document }).fonts ?? document.fonts;
    await Promise.all([
      new FontFace("RoughCutText", `url(${new URL("/fonts/DejaVuSans-Bold.ttf", location.origin).href})`, { weight: "700" }),
      new FontFace("RoughCutCaptions", `url(${new URL("/fonts/Inter.ttf", location.origin).href})`, { weight: "100 900" }),
    ].map(async (font) => { await font.load(); fonts.add(font); }));
  })().catch((error) => { fontPromise = undefined; throw error; });
}

function wrapText(context: Context, text: string, width: number) {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (context.measureText(next).width <= width) { line = next; continue; }
      if (line) lines.push(line);
      line = "";
      for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(word)) {
        if (line && context.measureText(line + segment).width > width) { lines.push(line); line = ""; }
        line += segment;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function drawText(context: Context, state: ProjectState, timeMs: number) {
  const captions = state.captions.map((item) => ({ ...item, fontSize: { small: 38, medium: 48, large: 58 }[state.captionStyle.size], color: state.captionStyle.color, background: state.captionStyle.background, opacity: state.captionStyle.backgroundOpacity, padding: 8, font: "RoughCutCaptions", weight: 600, shadow: "#0006" }));
  const overlays = state.overlays.map((item) => ({ ...item, fontSize: item.fontSize ?? 54, color: item.color ?? "white", background: item.background !== false, opacity: item.backgroundOpacity ?? 0.47, padding: 10, font: "RoughCutText", weight: 700, shadow: "#000" }));
  // V2 overlays above source; S1 captions above overlays, matching the editor's semantic lanes.
  for (const item of [...overlays, ...captions]) {
    if (timeMs < item.startMs || timeMs >= item.endMs) continue;
    context.save();
    context.font = `${item.weight} ${item.fontSize}px ${item.font}`;
    context.textAlign = "center"; context.textBaseline = "alphabetic";
    const lines = wrapText(context, item.text, FRAME_WIDTH - 120);
    const lineHeight = item.fontSize * 1.2;
    const metrics = lines.map((line) => context.measureText(line));
    const inkTop = Math.min(...metrics.map((metric, index) => index * lineHeight - metric.actualBoundingBoxAscent));
    const inkBottom = Math.max(...metrics.map((metric, index) => index * lineHeight + metric.actualBoundingBoxDescent));
    const height = inkBottom - inkTop;
    const width = Math.max(...metrics.map((metric) => metric.width), 0);
    const { centreX, top } = textBoxPosition(item, width, height, item.background ? item.padding : 0);
    if (item.background) {
      context.fillStyle = `rgb(0 0 0 / ${item.opacity})`;
      context.fillRect(centreX - width / 2 - item.padding, top - item.padding, width + item.padding * 2, height + item.padding * 2);
    }
    context.fillStyle = TEXT_COLORS[item.color];
    context.shadowColor = item.shadow; context.shadowBlur = item.weight === 600 ? 1 : 3; context.shadowOffsetY = item.weight === 600 ? 1 : 2;
    lines.forEach((line, index) => context.fillText(line, centreX, top - inkTop + index * lineHeight));
    context.restore();
  }
}

/** Same pixel composition is used by the visible canvas, frame inspection and MP4 export. */
export class VideoRenderer {
  private input: Input;
  private readers = new Map<string, FrameReader>();
  private track: ReturnType<Input["getPrimaryVideoTrack"]>;
  private disposed = false;
  private pending: Promise<void> = Promise.resolve();
  private disposal?: Promise<void>;
  private trackSupport?: Promise<void>;
  private supportController = new AbortController();
  constructor(source: MediaSource) {
    this.input = new Input({ source: typeof source === "string" ? new UrlSource(source) : new BlobSource(source), formats: ALL_FORMATS });
    this.track = this.input.getPrimaryVideoTrack();
  }
  draw(context: Context, state: ProjectState, timeMs: number) {
    if (this.disposed) return Promise.reject(new DOMException("Renderer closed", "AbortError"));
    const draw = this.pending.catch(() => {}).then(() => this.render(context, state, timeMs));
    this.pending = draw;
    return draw;
  }
  private async render(context: Context, state: ProjectState, timeMs: number) {
    if (this.disposed) throw new DOMException("Renderer closed", "AbortError");
    await loadCompositionFont();
    const plan = framePlan(state, timeMs);
    const wanted = new Set(plan.map(({ clip }) => clip.id));
    for (const [id, reader] of this.readers) if (!wanted.has(id)) { await reader.close(); this.readers.delete(id); }
    context.save();
    try {
      context.setTransform(context.canvas.width / FRAME_WIDTH, 0, 0, context.canvas.height / FRAME_HEIGHT, 0, 0);
      context.globalAlpha = 1; context.filter = "none";
      context.fillStyle = "black"; context.fillRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
      for (const { clip, sourceSeconds, video } of plan) {
        if (video <= 0) continue;
        let reader = this.readers.get(clip.id);
        if (!reader) {
          const track = await this.track;
          if (!track) throw new Error("The source has no video track");
          this.trackSupport ??= ensureTrackDecodable(track, "video", this.supportController.signal).then(() => undefined);
          await this.trackSupport;
          reader = new FrameReader(new CanvasSink(track, { width: FRAME_WIDTH, height: FRAME_HEIGHT, fit: "contain", poolSize: 3 }));
          this.readers.set(clip.id, reader);
        }
        const image = await reader.get(sourceSeconds, clip.sourceOutMs / 1000, clip.speed);
        if (!image) throw new Error(`No decoded video frame at ${sourceSeconds.toFixed(3)}s`);
        context.save();
        context.globalAlpha = video;
        context.filter = `brightness(${1 + clip.brightness}) contrast(${clip.contrast}) saturate(${clip.saturation}) hue-rotate(${clip.hue}deg)`;
        context.translate(FRAME_WIDTH / 2 + clip.positionX * FRAME_WIDTH / 100, FRAME_HEIGHT / 2 + clip.positionY * FRAME_HEIGHT / 100);
        context.scale(clip.scaleX, clip.scaleY);
        context.drawImage(image, -FRAME_WIDTH / 2, -FRAME_HEIGHT / 2, FRAME_WIDTH, FRAME_HEIGHT);
        context.restore();
      }
      context.filter = "none"; context.globalAlpha = 1;
      drawText(context, state, timeMs);
    } finally { context.restore(); }
  }
  dispose() {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.supportController?.abort(new DOMException("Renderer closed", "AbortError"));
    return this.disposal = (async () => {
      // Finish any in-flight draw before returning the iterators and their prefetched samples.
      await this.pending.catch(() => {});
      try {
        const results = await Promise.allSettled([...this.readers.values()].map((reader) => reader.close()));
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      } finally { this.input.dispose(); this.readers.clear(); }
    })();
  }
}
