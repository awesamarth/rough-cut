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
      className={`upload-zone ${dragging ? "is-dragging" : ""}`}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files[0]; if (file) void upload(file); }}
    >
      <input ref={inputRef} hidden type="file" accept="video/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
      <div className="upload-icon" aria-hidden>↗</div>
      <h2>{progress === null ? "Drop a video here" : progress === 100 ? "Opening editor…" : "Uploading source…"}</h2>
      <p>{progress === null ? "MP4, WebM, MOV and other video formats" : `${progress}% uploaded`}</p>
      {progress !== null && <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>}
      {progress === null && <button className="primary-button" onClick={() => inputRef.current?.click()}>Choose video</button>}
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  );
}
