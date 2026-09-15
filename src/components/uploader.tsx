"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AUTO_TRANSCRIBE_KEY, queueAutoTranscription } from "@/lib/auto-transcription";
import { rememberProject } from "@/lib/local-projects";
import { createLocalProject, importLocalProject } from "@/lib/local-store";

export function Uploader() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const backupInput = useRef<HTMLInputElement>(null);
  const choose = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const [working, setWorking] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [autoTranscribe, setAutoTranscribe] = useState(false);
  useEffect(() => {
    try { setAutoTranscribe(localStorage.getItem(AUTO_TRANSCRIBE_KEY) === "true"); } catch { /* Storage unavailable: keep opt-in off. */ }
  }, []);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const controller = new AbortController();
    void context.registerTool({
      name: "request_video_upload", title: "Request local source video",
      description: "Highlight the human-operated local video picker. The file stays on the device; this does not upload it. Ask the human to choose a file.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute() {
        if (busy.current) return { status: "unavailable", message: "A file is already opening." };
        setRequested(true); choose.current?.focus();
        return { status: "human_action_required", message: "Choose video is highlighted. Ask the human to select a local source file." };
      },
    }, { signal: controller.signal }).catch((cause) => { if (!controller.signal.aborted) setError(String(cause)); });
    return () => controller.abort();
  }, []);

  async function open(file: File, backup = false) {
    if (busy.current) return;
    busy.current = true; setWorking(true); setError(""); setRequested(false);
    try {
      let id: string;
      if (backup) {
        if (file.size > 32 * 1024 * 1024) throw new Error("Project backup is too large (maximum 32 MB)");
        id = await importLocalProject(JSON.parse(await file.text()));
      } else {
        const { ALL_FORMATS, BlobSource, Input } = await import("mediabunny");
        const media = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
        try {
          const video = await media.getPrimaryVideoTrack();
          if (!video) throw new Error("Choose a file containing a video track");
          id = await createLocalProject(file, await video.computeDuration() * 1000);
        } finally { media.dispose(); }
      }
      if (!backup && autoTranscribe) queueAutoTranscription(id);
      rememberProject(id);
      router.push(`/editor/${id}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open file"); }
    finally { busy.current = false; setWorking(false); }
  }

  return <><div className={`mt-10 flex min-h-[230px] flex-col items-center justify-center rounded-2xl border border-dashed p-8 text-center ${dragging ? "border-[var(--lime)] bg-[#1b2114]" : "border-[#3a404a] bg-[#121419cc]"}`}
    onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
    onDrop={(event) => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files[0]; if (file) void open(file); }}>
    <input ref={input} hidden disabled={working} type="file" accept="video/*" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void open(file); }} />
    <h2 className="mb-2 text-xl">{working ? "Opening locally…" : "Drop a video here"}</h2>
    <p className="mb-5 text-sm text-[var(--muted)]">No account or upload required. Your original media stays on this device.</p>
    <button ref={choose} disabled={working} className={`cursor-pointer rounded-lg bg-[var(--lime)] px-5 py-3 font-bold text-[#10120d] ${requested ? "ring-2 ring-white ring-offset-2 ring-offset-[#121419]" : ""}`} onClick={() => input.current?.click()}>Choose video</button>
    <label className="mt-4 flex max-w-full items-start gap-2 text-left text-xs text-[var(--muted)]"><input className="mt-0.5" type="checkbox" checked={autoTranscribe} disabled={working} onChange={(event) => {
      const enabled = event.target.checked; setAutoTranscribe(enabled);
      try { localStorage.setItem(AUTO_TRANSCRIBE_KEY, String(enabled)); }
      catch { setError("Choice applies for now, but could not be remembered on this device."); }
    }} /><span>Automatically transcribe new videos using Workers AI. Audio is sent to the cloud.</span></label>
  </div>
    <div className="mt-4 flex justify-end">
      <input ref={backupInput} hidden type="file" accept="application/json,.json" disabled={working} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void open(file, true); }} />
      <button type="button" disabled={working} className="cursor-pointer rounded-lg border border-[var(--line)] bg-[var(--panel-2)] px-4 py-2.5 text-sm text-[var(--text)] hover:border-[var(--lime)] disabled:cursor-not-allowed disabled:opacity-40" onClick={() => backupInput.current?.click()}>Import project backup</button>
    </div>
    {error && <p role="alert" className="mt-4 text-sm text-[#ff9781]">{error}</p>}
  </>;
}
