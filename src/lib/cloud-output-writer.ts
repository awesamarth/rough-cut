import type { StreamTargetChunk } from "mediabunny";

export const OUTPUT_CHUNK_BYTES = 5 * 1024 * 1024;
export type OutputWriter = {
  write(chunk: StreamTargetChunk): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
};

/** Keep the first (MP4 header) and trailing chunks writable; upload sealed middle chunks once. */
export function cloudOutputWriter(maxBytes: number, upload: (part: number, bytes: Uint8Array) => Promise<void>, complete: (bytes: number) => Promise<void>, cancel: () => Promise<void>): OutputWriter {
  const buffers = new Map<number, Uint8Array>();
  const sealed = new Set<number>();
  let length = 0, closed = false;
  const check = () => { if (closed) throw new Error("Cloud output is closed"); };
  async function flush(index: number, size = OUTPUT_CHUNK_BYTES) {
    const bytes = buffers.get(index);
    if (!bytes) throw new Error("Incomplete cloud output chunk");
    await upload(index, bytes.subarray(0, size));
    sealed.add(index); buffers.delete(index);
  }
  return {
    async write({ position, data }) {
      check();
      if (!Number.isSafeInteger(position) || position < 0 || position + data.byteLength > maxBytes) throw new Error("Export exceeds its admitted cloud byte limit");
      for (let offset = 0; offset < data.length;) {
        const absolute = position + offset, index = Math.floor(absolute / OUTPUT_CHUNK_BYTES);
        if (sealed.has(index)) throw new Error("MP4 attempted to rewrite sealed cloud output");
        let buffer = buffers.get(index);
        if (!buffer) { buffer = new Uint8Array(OUTPUT_CHUNK_BYTES); buffers.set(index, buffer); }
        const start = absolute % OUTPUT_CHUNK_BYTES, count = Math.min(data.length - offset, OUTPUT_CHUNK_BYTES - start);
        buffer.set(data.subarray(offset, offset + count), start); offset += count;
        length = Math.max(length, absolute + count);
        for (const key of buffers.keys()) if (key > 0 && key < Math.floor((length - 1) / OUTPUT_CHUNK_BYTES) - 1) await flush(key);
      }
    },
    async truncate(size) {
      check();
      if (!Number.isSafeInteger(size) || size < 1 || size > length || size < length - 2 * OUTPUT_CHUNK_BYTES) throw new Error("Unsupported cloud output truncation");
      const last = Math.floor((size - 1) / OUTPUT_CHUNK_BYTES);
      if ([...sealed].some((index) => (index + 1) * OUTPUT_CHUNK_BYTES > size)) throw new Error("Cannot truncate sealed cloud output");
      for (const index of buffers.keys()) if (index > last) buffers.delete(index);
      length = size;
    },
    async close() {
      check();
      for (let index = 0; index < Math.ceil(length / OUTPUT_CHUNK_BYTES); index++) if (!sealed.has(index)) await flush(index, Math.min(OUTPUT_CHUNK_BYTES, length - index * OUTPUT_CHUNK_BYTES));
      await complete(length); closed = true;
    },
    async abort() { if (!closed) { closed = true; buffers.clear(); await cancel(); } },
  };
}
