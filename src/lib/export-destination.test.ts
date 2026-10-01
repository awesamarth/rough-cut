import { describe, expect, test } from "bun:test";
import { LocalExportStorageError, decideExportStorage, estimateExportStorage, isLocalExportStorageError, shouldOfferCloudRetry, localStorageDestination } from "./export-destination";

describe("export destination decisions", () => {
  test("only quota failures originating in file operations are tagged for worker transport", async () => {
    for (const stage of ["create", "write", "truncate", "close"] as const) {
      const fail = async (operation: string) => { if (stage === operation) throw new DOMException("full", "QuotaExceededError"); };
      let reported: LocalExportStorageError | undefined;
      const destination = localStorageDestination({ async createWritable() {
        await fail("create");
        return { write: () => fail("write"), truncate: () => fail("truncate"), close: () => fail("close"), abort: async () => {} };
      } }, (error) => { reported = error; });
      try {
        const writer = await destination.createWritable();
        await writer.write({ type: "write", position: 0, data: new Uint8Array(1) });
        await writer.truncate(1); await writer.close();
        throw new Error("Expected quota failure");
      } catch (error) { expect(error).toBeInstanceOf(LocalExportStorageError); expect(error).toBe(reported); }
    }
  });
  test("uses local storage when the safety-adjusted estimate fits", () => {
    expect(decideExportStorage(600, { quota: 1000, usage: 400 })).toBe("local");
    expect(decideExportStorage(599, { quota: 1000, usage: 400 })).toBe("local");
  });

  test("requires cloud consent when known available space is insufficient", () => {
    expect(decideExportStorage(601, { quota: 1000, usage: 400 })).toBe("cloud-consent");
    expect(decideExportStorage(1, { quota: 0, usage: 0 })).toBe("cloud-consent");
  });

  test("unknown or failed estimates do not grant cloud upload permission", async () => {
    for (const estimate of [{}, { quota: 1000 }, { usage: 0 }, { quota: NaN, usage: 0 }]) expect(decideExportStorage(1, estimate)).toBe("local");
    expect(await estimateExportStorage(1, async () => { throw new Error("estimate unavailable"); })).toBe("local");
  });

  test("only explicit local storage failures qualify for a cloud retry offer", () => {
    expect(isLocalExportStorageError(new LocalExportStorageError("preflight"))).toBe(true);
    expect(isLocalExportStorageError(new DOMException("decoder resources exhausted", "QuotaExceededError"))).toBe(false);
    expect(isLocalExportStorageError(new Error("Required H.264/AAC encoding is not supported"))).toBe(false);
    expect(isLocalExportStorageError(new DOMException("Export canceled", "AbortError"))).toBe(false);
    expect(isLocalExportStorageError(new Error("Browser export worker failed"))).toBe(false);
    expect(shouldOfferCloudRetry(new LocalExportStorageError("disk full"), true)).toBe(true);
    expect(shouldOfferCloudRetry(new DOMException("encoder resources exhausted", "QuotaExceededError"), true)).toBe(false);
    expect(shouldOfferCloudRetry(new LocalExportStorageError("disk full"), false)).toBe(false);
  });
});
