import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useRef, useState } from "react";
import { applyCommand, createClip, createProjectState, type EditorCommand } from "@/lib/editor";
import { blocksEditorShortcuts } from "@/lib/editor-shortcuts";
import type { CommandInput } from "./use-editor";
import { TextInspector, Timeline } from "./editor";

// Mounted event-path coverage in a simulated DOM, not a browser/layout test.
test("timeline commits focused text before scrubbing, edge clicks select, drags trim, and wheel zoom keeps the playhead centred", async () => {
  const dom = new Window({ url: "http://localhost" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Event", "KeyboardEvent", "MouseEvent", "PointerEvent"] as const) {
    install(key, key === "window" ? dom : dom[key]);
  }
  install("IS_REACT_ACT_ENVIRONMENT", true);
  install("requestAnimationFrame", dom.requestAnimationFrame.bind(dom));
  install("cancelAnimationFrame", dom.cancelAnimationFrame.bind(dom));
  const observers = new Set<() => void>();
  install("ResizeObserver", class {
    constructor(private callback: () => void) { observers.add(callback); }
    observe() { this.callback(); }
    disconnect() { observers.delete(this.callback); }
  });
  Object.defineProperty(dom.HTMLElement.prototype, "clientWidth", { configurable: true, get() {
    return this.classList.contains("timeline-track") ? Math.max(500, parseFloat(this.style.width) || 0) : 510;
  } });
  Object.defineProperty(dom.HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return this.clientWidth; } });
  dom.HTMLElement.prototype.setPointerCapture = () => {};
  dom.HTMLElement.prototype.getBoundingClientRect = function () {
    return new dom.DOMRect(this.classList.contains("timeline-track") ? -(this.parentElement?.scrollLeft ?? 0) : 0, 0, this.clientWidth, 240);
  };
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const commands: CommandInput[] = [];
  let plays = 0;
  let snapshot = createProjectState("p", "Interaction", 10000);
  snapshot.clips = [createClip(0, 4950, 0), createClip(4950, 5000, 4950), createClip(5000, 10000, 5000)];
  snapshot.captions = [{ id: "caption", text: "Before", startMs: 0, endMs: 3000, position: "bottom" }];
  let lastPlayhead = 5000;
  function Harness() {
    const [state, setState] = useState(snapshot);
    const stateRef = useRef(state);
    const [selected, select] = useState("");
    const [playhead, seek] = useState(5000);
    const [preview, setPreview] = useState("");
    const dispatch = (command: CommandInput) => {
      commands.push(command);
      snapshot = applyCommand(stateRef.current, { ...command, expectedVersion: stateRef.current.version } as EditorCommand);
      stateRef.current = snapshot; setState(snapshot); return snapshot;
    };
    const noop = () => {};
    return <>
      <TextInspector state={state} kind="caption" item={state.captions[0]} onPreview={(patch) => setPreview(patch.text ?? "")} onCommit={() => setPreview("")} onCaptionOpacityPreview={noop} onCaptionOpacityCommit={noop} dispatch={dispatch} />
      <output data-preview>{preview}</output>
      <Timeline state={state} waveform={[]} musicWaveform={[]} musicPreview={null} snapping={{ enabled: true, current: { current: true }, toggle: noop, beginDrag: noop, endDrag: noop }} playheadMs={playhead} selectedClipId={selected} selectedMusicId="" selectedText={null} onSelect={select} onEditText={noop} onEditMusic={noop} onClearSelection={() => select("")} onSeek={(time) => { lastPlayhead = time; seek(time); }} dispatch={dispatch} setError={(message) => { throw new Error(message); }} />
      <output data-selected>{selected}</output>
    </>;
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host as unknown as HTMLElement);
  const pointer = (target: Pick<typeof dom, "dispatchEvent">, type: string, x: number) => target.dispatchEvent(new dom.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: x }));
  const keyboard = (event: Event) => { if (!blocksEditorShortcuts(event as KeyboardEvent) && (event as KeyboardEvent).code === "Space") plays++; };
  dom.addEventListener("keydown", keyboard as never, true);
  try {
    await act(async () => root.render(<Harness />));
    const textarea = host.querySelector("textarea")!;
    await act(async () => {
      textarea.focus();
      Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "After");
      textarea.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
    expect(commands).toHaveLength(0);
    expect(host.querySelector("[data-preview]")!.textContent).toBe("After");
    textarea.dispatchEvent(new dom.KeyboardEvent("keydown", { code: "Space", bubbles: true }));
    expect(plays).toBe(0);
    const ruler = host.querySelector('[aria-label="Scrub timeline"]')!;
    await act(async () => { pointer(ruler, "pointerdown", 250); pointer(dom, "pointerup", 250); });
    expect(snapshot.captions[0].text).toBe("After");
    expect(commands.filter((c) => c.type === "update_caption")).toHaveLength(1);
    expect(dom.document.activeElement?.getAttribute("aria-label")).toBe("Timeline");
    expect(host.querySelector("[data-preview]")!.textContent).toBe("");
    dom.document.activeElement!.dispatchEvent(new dom.KeyboardEvent("keydown", { code: "Space", bubbles: true }));
    expect(plays).toBe(1);
    const edited = host.querySelector("textarea")!;
    await act(async () => {
      edited.focus();
      Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(edited, "Handle edit");
      edited.dispatchEvent(new dom.Event("input", { bubbles: true }));
      pointer(host.querySelector('[aria-label="Drag playhead"]')!, "pointerdown", 250);
      pointer(dom, "pointerup", 250);
    });
    expect(snapshot.captions[0].text).toBe("Handle edit");
    expect(commands.filter((c) => c.type === "update_caption")).toHaveLength(2);
    expect(dom.document.activeElement?.getAttribute("aria-label")).toBe("Timeline");

    // A zero-motion click near another snap target must not accidentally trim.
    const tinyId = snapshot.clips[1].id;
    const edge = host.querySelector(`[data-blade-id="${tinyId}"] [aria-label="Trim linked clip end"]`)!;
    await act(async () => { pointer(edge, "pointerdown", 250); pointer(dom, "pointerup", 250); });
    expect(host.querySelector("[data-selected]")!.textContent).toBe(tinyId);
    expect(commands.filter((c) => c.type === "trim_clip")).toHaveLength(0);
    // Trim the final clip inward, away from neighbours, with an actual drag.
    const end = host.querySelector(`[data-blade-id="${snapshot.clips[2].id}"] [aria-label="Trim linked clip end"]`)!;
    await act(async () => { pointer(end, "pointerdown", 500); pointer(dom, "pointermove", 475); pointer(dom, "pointerup", 475); });
    expect(commands.filter((c) => c.type === "trim_clip")).toHaveLength(1);
    expect(snapshot.clips[2].sourceOutMs).toBe(9500);

    const viewport = host.querySelector(".timeline-track")!.parentElement!;
    const wheel = (clientX: number, deltaY: number) => {
      const event = new dom.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY, deltaMode: 0 });
      // happy-dom's WheelEvent lacks MouseEvent modifier/coordinate fields.
      Object.defineProperties(event, { altKey: { value: true }, clientX: { value: clientX } });
      return viewport.dispatchEvent(event);
    };
    const beforeZoom = lastPlayhead;
    await act(async () => { wheel(5, -100); wheel(490, -100); });
    // Mock layout measurement after the style commit, as ResizeObserver would.
    await act(async () => { for (const notify of observers) notify(); });
    const track = host.querySelector(".timeline-track")! as InstanceType<typeof dom.HTMLElement>;
    expect(track.clientWidth).toBeCloseTo(500 * Math.exp(0.6));
    expect(viewport.scrollLeft).toBeCloseTo(beforeZoom / 9500 * track.clientWidth - 250);
    expect(lastPlayhead).toBe(beforeZoom);
    await act(async () => wheel(250, 10000));
    expect(viewport.scrollLeft).toBe(0);
    expect(lastPlayhead).toBe(beforeZoom);
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
