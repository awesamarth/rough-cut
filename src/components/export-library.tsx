"use client";

import { useEffect, useState } from "react";
import { useConfirmation } from "./modal";
import { listTemporaryExports, removeTemporaryExport, type ReadyExport } from "@/lib/local-export";

type Entry = ReadyExport & { file: File; url: string };
export function ExportLibrary({ onRemoved }: { onRemoved?: (name: string) => void }) {
  const { confirm, confirmation } = useConfirmation();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [revision, refresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let canceled = false;
    const urls: string[] = [];
    setLoading(true); setError(""); setEntries([]);
    void (async () => {
      const results: Entry[] = [];
      for (const item of await listTemporaryExports()) {
        if (canceled) return;
        const file = new File([await item.handle.getFile()], item.filename, { type: "video/mp4" });
        if (canceled) return;
        const url = URL.createObjectURL(file); urls.push(url);
        results.push({ ...item, file, url });
      }
      if (!canceled) setEntries(results);
    })().catch((cause) => { if (!canceled) setError(String(cause)); }).finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; urls.forEach((url) => URL.revokeObjectURL(url)); };
  }, [revision]);
  const remove = async (item: Entry) => {
    if (!await confirm("Remove this browser copy? Wait until its download finishes first. Files already saved elsewhere will not be deleted.", "Delete browser copy?", "Delete")) return;
    try { await removeTemporaryExport(item); onRemoved?.(item.temporaryName!); refresh((value) => value + 1); }
    catch (cause) { setError(String(cause)); }
  };
  return <div className="space-y-3 p-3 text-xs">{confirmation}
    <div className="flex items-center gap-3"><p className="mr-auto text-[var(--muted)]">Browser copies from all projects. Download before clearing browser storage; deleting here does not delete your projects or source media.</p><button className="shrink-0 underline" onClick={() => refresh((value) => value + 1)}>Refresh</button></div>
    {error && <p role="alert" className="text-[#ff9781]">{error}</p>}
    {loading ? <p role="status">Reading saved exports…</p> : !entries.length && <p>No finished browser copies. Directly saved files remain in your chosen folder.</p>}
    {entries.map((item) => <div key={item.temporaryName} className="flex flex-wrap items-center gap-3 border-t border-[var(--line)] py-3">
      <span className="min-w-0 flex-1 break-words">{item.filename} · {(item.file.size / 1024 ** 2).toFixed(1)} MB</span>
      <a className="rounded bg-[var(--lime)] px-3 py-2 font-bold text-black" href={item.url} download={item.filename}>Download</a>
      <button className="underline" onClick={() => void remove(item)}>Delete browser copy</button>
    </div>)}
  </div>;
}
