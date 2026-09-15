"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const node = dialog.current!;
    const previous = document.activeElement;
    node.showModal();
    return () => { node.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} aria-labelledby={titleId} className="m-auto max-h-[calc(100dvh-40px)] w-[min(500px,calc(100%_-_40px))] overflow-auto rounded-xl border border-[#3a4049] bg-[#14171b] p-0 text-[var(--text)] shadow-2xl backdrop:bg-[#000c]" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
  }}><div className="p-6"><h2 id={titleId} className="mt-0 mb-3 text-xl font-semibold">{title}</h2>{children}</div></dialog>;
}

export const modalCancelClass = "cursor-pointer rounded-md border border-[var(--line)] bg-transparent px-4 py-2.5 text-sm";
export const modalActionClass = "cursor-pointer rounded-md border-0 bg-[var(--lime)] px-4 py-2.5 text-sm font-bold text-[#10120d] disabled:cursor-not-allowed disabled:opacity-40";

export function useConfirmation() {
  const [request, setRequest] = useState<{ message: string; title: string; action: string; input?: boolean } | null>(null);
  const [text, setText] = useState("");
  const resolve = useRef<((answer: boolean | string) => void) | null>(null);
  useEffect(() => () => { resolve.current?.(false); }, []);
  const confirm = useCallback((message: string, title = "Please confirm", action = "Continue") => new Promise<boolean>((done) => {
    resolve.current?.(false);
    resolve.current = (answer) => done(answer === true);
    setRequest({ message, title, action });
  }), []);
  const prompt = useCallback((title: string, initial = "") => new Promise<string | null>((done) => {
    resolve.current?.(false);
    resolve.current = (answer) => done(typeof answer === "string" ? answer : null);
    setText(initial);
    setRequest({ title, message: title, action: "Save", input: true });
  }), []);
  const finish = (answer: boolean | string) => { resolve.current?.(answer); resolve.current = null; setRequest(null); };
  const confirmation = request && <Modal title={request.title} onClose={() => finish(false)}>
    <form onSubmit={(event) => { event.preventDefault(); if (!request.input || text.trim()) finish(request.input ? text.trim() : true); }}>
      {request.input ? <input autoFocus aria-label={request.title} className="mt-4 mb-6 w-full rounded-md border border-[var(--line)] bg-[#0b0d10] px-3 py-2.5 text-sm text-white outline-[var(--lime)]" value={text} onChange={(event) => setText(event.target.value)} /> : <p className="mt-2 mb-5 text-sm leading-relaxed text-[var(--muted)]">{request.message}</p>}
      <div className="flex justify-end gap-3"><button autoFocus={!request.input} type="button" className={modalCancelClass} onClick={() => finish(false)}>Cancel</button><button type="submit" disabled={request.input && !text.trim()} className={modalActionClass}>{request.action}</button></div>
    </form>
  </Modal>;
  return { confirm, prompt, confirmation };
}
