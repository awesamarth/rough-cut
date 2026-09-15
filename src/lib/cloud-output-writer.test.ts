import { expect, test } from "bun:test";
import { cloudOutputWriter, OUTPUT_CHUNK_BYTES as chunk } from "./cloud-output-writer";

test("cloud output retains header and trailing metadata patches, seals once, and bounds writes", async () => {
  const parts = new Map<number, Uint8Array>();
  let committed = 0, canceled = false;
  const writer = cloudOutputWriter(chunk * 5, async (part, bytes) => {
    expect(parts.has(part)).toBe(false); parts.set(part, bytes.slice());
  }, async (bytes) => { committed = bytes; }, async () => { canceled = true; });
  const write = (position: number, data: Uint8Array<ArrayBuffer>) => writer.write({ type: "write", position, data });
  for (let index = 0; index < 5; index++) await write(index * chunk, new Uint8Array(index === 4 ? 20 : chunk).fill(index + 1));
  expect(parts.has(0)).toBe(false);
  expect(parts.has(1)).toBe(true);
  await expect(write(chunk, new Uint8Array([8]))).rejects.toThrow("sealed");
  await expect(write(chunk * 5, new Uint8Array([8]))).rejects.toThrow("byte limit");
  await write(0, new Uint8Array([9]));
  await write(chunk * 4 - 10, new Uint8Array(20).fill(7));
  await writer.truncate(chunk * 4 + 10);
  await writer.close();
  expect(committed).toBe(chunk * 4 + 10);
  expect(parts.get(0)![0]).toBe(9);
  expect(parts.get(3)!.at(-1)).toBe(7);
  expect([...parts.get(4)!]).toEqual(Array(10).fill(7));
  await writer.abort(); expect(canceled).toBe(false);
});

test("failed upload never commits and can be aborted", async () => {
  let canceled = false, committed = false;
  const writer = cloudOutputWriter(chunk, async () => { throw new Error("offline"); }, async () => { committed = true; }, async () => { canceled = true; });
  await writer.write({ type: "write", position: 0, data: new Uint8Array([1]) });
  await expect(writer.close()).rejects.toThrow("offline");
  await writer.abort();
  expect(canceled).toBe(true); expect(committed).toBe(false);
});
