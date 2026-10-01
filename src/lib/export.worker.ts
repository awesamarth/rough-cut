import { cloudOutputDestination, type CloudOutputSession } from "./cloud-output-client";
import { localStorageDestination, type LocalExportStorageError } from "./export-destination";
import { exportTimeline } from "./browser-export";
import type { ProjectState } from "./editor";
import type { MediaSource } from "./video-renderer";

export type ExportRequest = { state: ProjectState; source: MediaSource; music: Record<string, MediaSource> } & ({ handle: FileSystemFileHandle } | { cloud: CloudOutputSession });
let controller: AbortController | undefined;
const scope = self as unknown as { onmessage: ((event: MessageEvent<ExportRequest | { cancel: true }>) => void) | null; postMessage(value: unknown): void };
scope.onmessage = async ({ data }) => {
  if ("cancel" in data) { controller?.abort(new DOMException("Export canceled", "AbortError")); return; }
  if (controller) return;
  controller = new AbortController();
  let storageFailure: LocalExportStorageError | undefined;
  try {
    const target = "cloud" in data ? cloudOutputDestination(data.cloud, controller.signal) : localStorageDestination(data.handle, (error) => { storageFailure = error; });
    const result = await exportTimeline(data.state, data.source, data.music, target, controller.signal, (progress) => scope.postMessage({ progress }));
    scope.postMessage({ result });
  } catch (error) {
    const failure = controller.signal.aborted ? controller.signal.reason : storageFailure ?? error;
    scope.postMessage({ error: failure instanceof Error ? { name: failure.name, message: failure.message } : { name: "Error", message: "Export failed" } });
  }
};
