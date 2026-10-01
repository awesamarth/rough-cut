import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createProjectState } from "@/lib/editor";
import { Timeline } from "./editor";

test("timeline selection stays linked and tiny text boxes have no padding/border width floor", () => {
  const state = createProjectState("00000000-0000-4000-8000-000000000000", "Selection", 3000);
  state.captions = [{ id: "tiny-caption", text: "Long caption", startMs: 0, endMs: 3, position: "bottom" }];
  state.overlays = [{ id: "tiny-overlay", text: "Long overlay", startMs: 0, endMs: 3, position: "top" }];
  const noop = () => {};
  const render = (selected: boolean, bladeMode: boolean) => renderToStaticMarkup(<Timeline
    state={state} waveform={[0.2, 0.8, 0.5]} musicWaveform={[]} musicPreview={null}
    snapping={{ enabled: true, current: { current: true }, toggle: noop, beginDrag: noop, endDrag: noop }}
    bladeMode={bladeMode} playheadMs={0} selectedClipId={selected ? state.clips[0].id : ""}
    selectedMusicId="" selectedText={null} onSelect={noop} onEditText={noop} onEditMusic={noop}
    onClearSelection={noop} onSeek={noop} dispatch={() => state} setError={noop}
  />);
  for (const bladeMode of [false, true]) {
    const html = render(true, bladeMode);
    expect(html.match(/after:bg-white\/5/g)).toHaveLength(2);
    expect(html.match(/after:border-\[var\(--lime\)\]/g)).toHaveLength(2);
    expect(render(false, bladeMode)).not.toContain("after:bg-white/5");
    for (const kind of ["caption", "overlay"]) {
      const box = html.match(new RegExp(`data-blade-kind="${kind}"[^>]+class="([^"]+)" style="([^"]+)"`))!;
      expect(box[1]).toContain("ring-inset");
      expect(box[1]).not.toMatch(/(?:^| )(?:p[xy]?|min-w|border)(?:-| |$)/);
      expect(box[2]).toContain("width:0.1%");
    }
    expect(html.match(/<span class="block overflow-hidden px-2 pb-1 text-ellipsis whitespace-nowrap">/g)).toHaveLength(2);
  }
  expect(render(true, true).match(/hidden" aria-label="Trim linked clip (start|end)"/g)).toHaveLength(2);
  expect(render(true, false)).not.toMatch(/hidden" aria-label="Trim linked clip/);
});
