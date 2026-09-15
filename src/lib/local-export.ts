import { timelineDuration, type ProjectState } from "./editor";
import type { CloudOutputSession } from "./cloud-output-client";
import type { MediaSource } from "./video-renderer";
import { LocalExportStorageError, decideExportStorage, localStorageOperation } from "./export-destination";

export function mp4Filename(name: string) {
  const base = name.trim().replace(/\.mp4$/i, "").replaceAll("/", "_").replaceAll("\\", "_").replace(/\p{Cc}/gu, "").slice(0, 120);
  return `${base || "rough-cut"}.mp4`;
}

export type ReadyExport = { handle: FileSystemFileHandle; temporaryName?: string; filename: string; savedDirectly: boolean };

export const exportByteEstimate = (state: ProjectState) => Math.ceil(timelineDuration(state) / 1000 * (8_000_000 + 192_000) / 8 * 1.15 + 32 * 1024 * 1024);

export async function runExportWorker(state: ProjectState, source: MediaSource, music: Record<string, MediaSource>, target: { handle: FileSystemFileHandle } | { cloud: CloudOutputSession }, signal: AbortSignal, progress: (fraction: number) => void) {
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL("./export.worker.ts", import.meta.url), { type: "module" });
    let cancelTimeout: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => { cleanup(); reject(new Error("Export exceeded the one-hour execution limit")); }, 60 * 60_000);
    const cleanup = () => { clearTimeout(timeout); clearTimeout(cancelTimeout); signal.removeEventListener("abort", abort); worker.terminate(); };
    const abort = () => {
      worker.postMessage({ cancel: true });
      cancelTimeout = setTimeout(() => { cleanup(); reject(signal.reason); }, 5000);
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = () => { cleanup(); reject(new Error("Browser export worker failed")); };
    worker.onmessage = ({ data }) => {
      if (typeof data.progress === "number") progress(data.progress);
      if (data.error || data.result) {
        cleanup();
        if (signal.aborted) reject(signal.reason);
        else if (data.error) {
          const detail = typeof data.error === "string" ? { name: "Error", message: data.error } : data.error as { name?: string; message?: string };
          if (detail.name === "LocalExportStorageError") reject(new LocalExportStorageError(detail.message || "Browser storage is full"));
          else { const error = new Error(detail.message || "Export failed"); error.name = detail.name || "Error"; reject(error); }
        } else resolve();
      }
    };
    try { signal.throwIfAborted(); worker.postMessage({ state, source, music, ...target }); }
    catch (error) { cleanup(); reject(error); }
  });
}

export async function localExport(state: ProjectState, source: MediaSource, music: Record<string, MediaSource>, filename: string, signal: AbortSignal, progress: (fraction: number) => void, destination?: FileSystemFileHandle): Promise<ReadyExport> {
  signal.throwIfAborted();
  filename = mp4Filename(filename);
  let directory: FileSystemDirectoryHandle | undefined;
  let temporaryName: string | undefined;
  try {
    let handle = destination;
    if (!handle) {
      let storage: StorageEstimate = {};
      try { storage = await navigator.storage.estimate(); } catch { /* An unknown estimate is not upload consent; try OPFS. */ }
      const expected = exportByteEstimate(state);
      if (decideExportStorage(expected, storage) === "cloud-consent") throw new LocalExportStorageError("Not enough browser storage for this export. Nothing was uploaded.");
      signal.throwIfAborted();
      directory = await localStorageOperation(async () => (await navigator.storage.getDirectory()).getDirectoryHandle("rough-cut-exports", { create: true }));
      temporaryName = `${Date.now()}-${crypto.randomUUID()}--${filename}`;
      handle = await localStorageOperation(() => directory!.getFileHandle(temporaryName!, { create: true }));
    }
    await runExportWorker(state, source, music, { handle }, signal, progress);
    return { handle, filename, temporaryName, savedDirectly: !!destination };
  } catch (error) {
    if (directory && temporaryName) {
      try { await directory.removeEntry(temporaryName); }
      catch (cleanupError) {
        if (!(cleanupError instanceof DOMException && cleanupError.name === "NotFoundError")) throw new Error("Could not remove the incomplete browser export. Free browser storage before trying again. Nothing was uploaded.", { cause: cleanupError });
      }
    }
    throw error;
  }
}

export async function listTemporaryExports(): Promise<ReadyExport[]> {
  const root = await navigator.storage.getDirectory();
  let directory: FileSystemDirectoryHandle;
  try { directory = await root.getDirectoryHandle("rough-cut-exports"); }
  catch (error) { if (error instanceof DOMException && error.name === "NotFoundError") return []; throw error; }
  const results: ReadyExport[] = [];
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind !== "file" || !/^\d{13}-[0-9a-f-]{36}(--|\.mp4$)/.test(name)) continue;
    const file = handle as FileSystemFileHandle;
    // createWritable commits atomically. An unfinished/new canceled file has no readable output.
    if (!(await file.getFile()).size) continue;
    results.push({ handle: file, temporaryName: name, filename: name.includes("--") ? name.slice(name.indexOf("--") + 2) : "rough-cut.mp4", savedDirectly: false });
  }
  return results.sort((a, b) => b.temporaryName!.localeCompare(a.temporaryName!));
}

export async function removeTemporaryExport(result: ReadyExport) {
  if (!result.temporaryName) return;
  const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("rough-cut-exports");
  await directory.removeEntry(result.temporaryName);
}
