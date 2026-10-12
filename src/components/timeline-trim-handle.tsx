import type { PointerEventHandler } from "react";

/** Hit areas stay inside their own clip and never overlap, even on a 2px clip.
 * Only the hovered/focused edge is painted; the transparent target stays usable
 * without covering the clip's contents or stealing clicks from a neighbour. */
export function TimelineTrimHandle({ edge, label, hidden, onPointerDown }: {
  edge: "in" | "out";
  label: string;
  hidden?: boolean;
  onPointerDown: PointerEventHandler<HTMLButtonElement>;
}) {
  return <button type="button" data-trim-handle aria-label={label} title={label}
    className={`absolute inset-y-0 z-[3] cursor-ew-resize border-0 bg-transparent p-0 text-[var(--lime)] after:pointer-events-none after:absolute after:inset-y-0 after:w-px after:bg-current after:opacity-0 hover:after:opacity-100 focus-visible:after:opacity-100 active:after:opacity-100 ${edge === "in" ? "left-0 after:left-0" : "right-0 after:right-0"} ${hidden ? "hidden" : ""}`}
    style={{ width: "min(8px, 50%)" }}
    onClick={(event) => event.stopPropagation()} onPointerDown={onPointerDown} />;
}
