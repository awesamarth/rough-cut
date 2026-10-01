import { expect, test } from "bun:test";
import { createProjectState } from "./editor";
import { localExport } from "./local-export";
import { shouldOfferCloudRetry } from "./export-destination";

test("OPFS retries require tagged storage errors and confirmed temporary-file cleanup", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  try {
    for (const [name, cleanupFails, retry] of [
      ["LocalExportStorageError", false, true],
      ["QuotaExceededError", false, false], // Raw decoder/encoder quota is not storage quota.
      ["LocalExportStorageError", true, false],
      ["AbortError", false, false],
    ] as const) {
      let removed = false, terminated = false;
      const directory = {
        getFileHandle: async () => ({}),
        removeEntry: async () => { if (cleanupFails) throw new Error("cleanup failed"); removed = true; },
      };
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { storage: {
        estimate: async () => ({ quota: 1e9, usage: 0 }),
        getDirectory: async () => ({ getDirectoryHandle: async () => directory }),
      } } });
      Object.defineProperty(globalThis, "Worker", { configurable: true, value: class {
        onmessage?: (event: { data: unknown }) => void;
        postMessage() { queueMicrotask(() => this.onmessage?.({ data: { error: { name, message: "test failure" } } })); }
        terminate() { terminated = true; }
      } });
      let failure: unknown;
      try {
        await localExport(createProjectState(crypto.randomUUID(), "Test", 3000), new Blob(), {}, "test.mp4", new AbortController().signal, () => {});
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(shouldOfferCloudRetry(failure, true)).toBe(retry);
      expect(removed).toBe(!cleanupFails);
      expect(terminated).toBe(true);
      if (cleanupFails) expect(String(failure)).toContain("Could not remove");
    }
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator); else Reflect.deleteProperty(globalThis, "navigator");
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker); else Reflect.deleteProperty(globalThis, "Worker");
  }
});
