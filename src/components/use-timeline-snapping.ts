"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { blocksEditorShortcuts } from "@/lib/editor-shortcuts";

export function useTimelineSnapping() {
  const [enabled, setEnabled] = useState(true);
  const current = useRef(true);
  const drag = useRef<{ original: boolean; refresh: () => void } | null>(null);
  const toggle = useCallback(() => {
    current.current = !current.current;
    setEnabled(current.current);
    drag.current?.refresh();
  }, []);
  const beginDrag = useCallback((refresh: () => void) => { drag.current = { original: current.current, refresh }; }, []);
  const endDrag = useCallback(() => {
    if (!drag.current) return;
    current.current = drag.current.original;
    drag.current = null;
    setEnabled(current.current);
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "n" || event.ctrlKey || event.metaKey || event.altKey || blocksEditorShortcuts(event)) return;
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) toggle();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [toggle]);
  return { enabled, current, toggle, beginDrag, endDrag };
}
