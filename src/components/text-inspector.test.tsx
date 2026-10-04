import { expect, test } from "bun:test";
import { Children, isValidElement, type ReactNode } from "react";
import { TextInspector } from "./editor";
import { createProjectState, type TimedText } from "@/lib/editor";
import type { CommandInput } from "./use-editor";

function find(node: ReactNode, type: string): Record<string, unknown> | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === type) return child.props;
    const nested = find(child.props.children, type);
    if (nested) return nested;
  }
}

test("caption and overlay typing previews every change but commits a single edit on blur", () => {
  for (const kind of ["caption", "overlay"] as const) {
    const state = createProjectState("p", "Text", 3000);
    const item: TimedText = { id: "text", text: "Original", startMs: 0, endMs: 3000, position: "center" };
    const previews: Partial<TimedText>[] = [];
    const edits: CommandInput[] = [];
    let clears = 0;
    const tree = TextInspector({ state, kind, item, onPreview: (patch) => previews.push(patch), onCommit: () => clears++, onCaptionOpacityPreview() {}, onCaptionOpacityCommit() {}, dispatch(command) { edits.push(command); return state; } });
    const textarea = find(tree, "textarea")!;
    const change = textarea.onChange as (event: { target: { value: string } }) => void;
    const blur = textarea.onBlur as (event: { target: { value: string }; currentTarget: { value: string } }) => void;
    const key = textarea.onKeyDown as (event: { key: string; currentTarget: { value: string } }) => void;
    change({ target: { value: "N" } });
    change({ target: { value: "New text" } });
    expect(previews).toEqual([{ text: "N" }, { text: "New text" }]);
    expect(edits).toHaveLength(0);
    const changed = { value: "New text" };
    blur({ target: changed, currentTarget: changed });
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ type: kind === "caption" ? "update_caption" : "update_overlay", patch: { text: "New text" } });
    const blank = { value: "   " };
    const empty = { target: blank, currentTarget: blank };
    change(empty);
    blur(empty);
    expect(empty.target.value).toBe("Original");
    expect(edits).toHaveLength(1);
    const escape = { key: "Escape", currentTarget: { value: "Uncommitted" } };
    key(escape);
    expect(escape.currentTarget.value).toBe("Original");
    expect(clears).toBe(3);
    const position = find(tree, "select")!;
    (position.onChange as (event: { target: { value: string } }) => void)({ target: { value: "bottom" } });
    expect(edits.at(-1)).toMatchObject({ patch: { position: "bottom", x: undefined, y: undefined } });
  }
});
