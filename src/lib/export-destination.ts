import type { OutputWriter } from "./cloud-output-writer";

export type StorageEstimate = { quota?: number; usage?: number };
export type ExportStorageDecision = "local" | "cloud-consent";

/** The expected byte count already includes the encoder overhead and storage safety margin. */
export function decideExportStorage(expectedBytes: number, estimate: StorageEstimate): ExportStorageDecision {
  const { quota, usage } = estimate;
  if (typeof quota !== "number" || !Number.isFinite(quota) || typeof usage !== "number" || !Number.isFinite(usage) || quota < 0 || usage < 0) return "local";
  return Math.max(0, quota - usage) >= expectedBytes ? "local" : "cloud-consent";
}

export async function estimateExportStorage(expectedBytes: number, estimate: () => Promise<StorageEstimate>): Promise<ExportStorageDecision> {
  try { return decideExportStorage(expectedBytes, await estimate()); }
  catch { return "local"; }
}

export class LocalExportStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalExportStorageError";
  }
}

export function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { name?: unknown }).name === "QuotaExceededError";
}

export function isLocalExportStorageError(error: unknown): boolean {
  return error instanceof LocalExportStorageError;
}

/** Tag failures at the storage boundary, never from codec/decoder resource limits. */
export async function localStorageOperation<T>(operation: () => Promise<T>, report?: (error: LocalExportStorageError) => void): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (!isQuotaError(error)) throw error;
    const failure = new LocalExportStorageError("Browser storage is full", { cause: error });
    report?.(failure);
    throw failure;
  }
}

export function localStorageDestination(handle: { createWritable(): Promise<OutputWriter> }, report: (error: LocalExportStorageError) => void) {
  return { async createWritable(): Promise<OutputWriter> {
    const writer = await localStorageOperation(() => handle.createWritable(), report);
    return {
      write: (chunk) => localStorageOperation(() => writer.write(chunk), report),
      truncate: (size) => localStorageOperation(() => writer.truncate(size), report),
      close: () => localStorageOperation(() => writer.close(), report),
      abort: () => writer.abort(),
    };
  } };
}

export function shouldOfferCloudRetry(error: unknown, usedOpfs: boolean): boolean {
  return usedOpfs && isLocalExportStorageError(error);
}
