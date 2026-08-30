"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function Uploader() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function upload(file: File) {
    if (!file.type.startsWith("video/")) return setError("Choose a video file.");
    setError("");
    setProgress(0);
    let uploadId = "";
    try {
      const start = await fetch("/api/uploads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, type: file.type, size: file.size }) });
      const session = await start.json() as { uploadId: string; projectId: string; chunkSize: number; error?: string };
      if (!start.ok) throw new Error(session.error || "Could not start upload");
      uploadId = session.uploadId;
      const parts: Array<{ partNumber: number; etag: string }> = [];
      const partCount = Math.ceil(file.size / session.chunkSize);
      for (let index = 0; index < partCount; index++) {
        const response = await fetch(`/api/uploads/${uploadId}/parts/${index + 1}`, { method: "PUT", body: file.slice(index * session.chunkSize, Math.min(file.size, (index + 1) * session.chunkSize)) });
        const part = await response.json() as { partNumber: number; etag: string; error?: string };
        if (!response.ok) throw new Error(part.error || `Part ${index + 1} failed`);
        parts.push(part);
        setProgress(Math.round(((index + 1) / (partCount + 1)) * 100));
      }
      const complete = await fetch(`/api/uploads/${uploadId}/complete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parts }) });
      const result = await complete.json() as { projectId?: string; error?: string };
      if (!complete.ok || !result.projectId) throw new Error(result.error || "Could not finish upload");
      setProgress(100);
      router.push(`/editor/${result.projectId}`);
    } catch (cause) {
      if (uploadId) void fetch(`/api/uploads/${uploadId}/complete`, { method: "DELETE" });
      setError(cause instanceof Error ? cause.message : "Upload failed");
      setProgress(null);
    }
  }

  return (
    <div
      className={`mt-10.5 flex min-h-[230px] flex-col items-center justify-center rounded-[18px] border border-dashed p-[30px] text-center transition duration-200 ${dragging ? "scale-[1.01] border-[var(--lime)] bg-[#1b2114]" : "border-[#3a404a] bg-[#121419cc]"}`}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files[0]; if (file) void upload(file); }}
    >
      <input ref={inputRef} hidden type="file" accept="video/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
      <div className="grid size-11 place-items-center rounded-xl bg-[#252a31] text-2xl text-[var(--lime)]" aria-hidden>↗</div>
      <h2 className="mt-2 mb-1.25 text-[19px]">{progress === null ? "Drop a video here" : progress === 100 ? "Opening editor…" : "Uploading source…"}</h2>
      <p className="mt-0 mb-[18px] text-[13px] text-[var(--muted)]">{progress === null ? "MP4, WebM, MOV and other video formats" : `${progress}% uploaded`}</p>
      {progress !== null && <div className="h-1.25 w-[min(400px,90%)] overflow-hidden rounded-[9px] bg-[#292d33]" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span className="block h-full bg-[var(--lime)] transition-[width] duration-250" style={{ width: `${progress}%` }} /></div>}
      {progress === null && <button className="cursor-pointer rounded-[10px] border-0 bg-[var(--lime)] px-5 py-[13px] font-extrabold text-[#10120d] shadow-[0_8px_30px_#d9ff6324] hover:bg-[#e5ff93]" onClick={() => inputRef.current?.click()}>Choose video</button>}
      {error && <p className="mt-4 text-[#ff9781]" role="alert">{error}</p>}
    </div>
  );
}
