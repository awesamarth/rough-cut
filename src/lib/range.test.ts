import { describe, expect, test } from "bun:test";
import { parseByteRange } from "./range";

describe("parseByteRange", () => {
  test("parses bounded, open, and suffix ranges without relying on R2 metadata", () => {
    expect(parseByteRange("bytes=0-31", 100)).toEqual({ offset: 0, length: 32 });
    expect(parseByteRange("bytes=90-", 100)).toEqual({ offset: 90, length: 10 });
    expect(parseByteRange("bytes=-20", 100)).toEqual({ offset: 80, length: 20 });
    expect(parseByteRange("bytes=100-101", 100)).toBeNull();
  });
});
