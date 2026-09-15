import { reserveCloudUsage } from "./cloud-budget";
import { OUTPUT_CHUNK_BYTES as CHUNK } from "./cloud-output-writer";
import { parseByteRange } from "./range";
import { readBody } from "./request-body";

type Env = { DB: D1Database; OUTPUTS: R2Bucket; CLOUD_OUTPUT_DAILY_MIB?: string; CLOUD_OUTPUT_LIFECYCLE_READY?: string };
type Row = { id: string; filename: string; max_bytes: number; bytes: number | null; status: string; created_at: number; expires_at: number };
const MiB = 1024 * 1024;
const key = (id: string, part: number) => `rough-cut-output/${id}/${part}`;
const error = (message: string, status = 400) => Response.json({ error: message }, { status });
const hash = async (token: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))), (byte) => byte.toString(16).padStart(2, "0")).join("");
const json = async (request: Request) => JSON.parse(new TextDecoder().decode(await readBody(request, 4096)));

/** Anonymous, capability-scoped rendered bytes only. Never invokes a Container or accepts a source URL. */
export async function serveCloudOutput(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), id = url.searchParams.get("id"), now = Date.now();
  if (!["GET", "POST", "PUT", "DELETE"].includes(request.method)) return error("Method not allowed", 405);
  // Next dev can normalize request.url to localhost even when the browser used 127.0.0.1.
  // Host is the actual HTTP destination; never use a client-supplied forwarded-host header.
  const requestOrigin = request.headers.get("host") ? `${url.protocol}//${request.headers.get("host")}` : url.origin;
  if (request.method !== "GET" && request.headers.get("origin") !== requestOrigin) return error("Same-origin request required", 403);
  if (!id) {
    if (request.method !== "POST") return error("Output not found", 404);
    const limit = Number(env.CLOUD_OUTPUT_DAILY_MIB ?? 0);
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 8192 || env.CLOUD_OUTPUT_LIFECYCLE_READY !== "1") return error("Cloud storage is temporarily unavailable. You can export locally instead.", 503);
    let input: { filename?: unknown; maxBytes?: unknown };
    try { input = await json(request); } catch { return error("Invalid output request"); }
    if (!input || typeof input.filename !== "string" || !input.filename.endsWith(".mp4") || input.filename.length > 124 || /[\p{Cc}\\/]/u.test(input.filename) || !Number.isSafeInteger(input.maxBytes) || Number(input.maxBytes) < 1 || Number(input.maxBytes) > 4096 * MiB) return error("Output must have an MP4 filename and a byte limit up to 4 GiB");
    const bytes = Number(input.maxBytes);
    if (!await reserveCloudUsage(env.DB, "output-mib", Math.ceil(bytes / MiB), limit, 20)) return error("Daily cloud output allowance reached. No upload started.", 429);
    await env.DB.prepare("DELETE FROM cloud_outputs WHERE expires_at <= ?").bind(now).run();
    const outputId = crypto.randomUUID(), token = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const expiresAt = now + 24 * 60 * 60_000;
    const admitted = await env.DB.prepare("INSERT INTO cloud_outputs (id, token_hash, filename, max_bytes, created_at, expires_at) SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM cloud_outputs WHERE status = 'uploading' AND created_at > ?) < 2")
      .bind(outputId, await hash(token), input.filename, bytes, now, expiresAt, now - 60 * 60_000).run();
    if (!admitted.meta.changes) return error("Cloud output is busy. Admission reservations are not refunded; no automatic retry.", 429);
    return Response.json({ id: outputId, filename: input.filename, maxBytes: bytes, expiresAt }, { headers: {
      "set-cookie": `rc-output-${outputId}=${token}; Path=/api/outputs; HttpOnly; SameSite=Strict; Max-Age=86400${url.protocol === "https:" ? "; Secure" : ""}`,
      "cache-control": "no-store",
    } });
  }
  // Native downloads use an HttpOnly cookie, never a capability in the URL/access logs.
  const cookie = request.headers.get("cookie")?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`rc-output-${id}=`))?.split("=")[1];
  const token = cookie ?? "";
  if (!/^[a-f0-9-]{36}$/.test(id) || !/^[a-f0-9]{64}$/.test(token)) return error("Output not found", 404);
  const row = await env.DB.prepare("SELECT * FROM cloud_outputs WHERE id = ? AND token_hash = ? AND expires_at > ?").bind(id, await hash(token), now).first<Row>();
  if (!row) return error("Output expired or not found", 410);
  if (request.method === "DELETE") {
    await env.DB.prepare("UPDATE cloud_outputs SET status = 'canceled' WHERE id = ?").bind(id).run();
    const parts = await env.DB.prepare("SELECT part FROM cloud_output_parts WHERE output_id = ?").bind(id).all<{ part: number }>();
    for (let index = 0; index < parts.results.length; index += 100) await env.OUTPUTS.delete(parts.results.slice(index, index + 100).map(({ part }) => key(id, part)));
    return Response.json({ deleted: true }, { headers: { "set-cookie": `rc-output-${id}=; Path=/api/outputs; HttpOnly; SameSite=Strict; Max-Age=0${url.protocol === "https:" ? "; Secure" : ""}` } });
  }
  if (request.method === "GET") {
    if (row.status !== "ready" || !row.bytes) return error("Output is not ready", 409);
    const range = parseByteRange(request.headers.get("range"), row.bytes);
    if (range === null) return new Response(null, { status: 416, headers: { "content-range": `bytes */${row.bytes}` } });
    const claimed = await env.DB.prepare("UPDATE cloud_outputs SET downloads = downloads + 1 WHERE id = ? AND status = 'ready' AND downloads < 10").bind(id).run();
    if (!claimed.meta.changes) return error("Download request limit reached", 429);
    const start = range?.offset ?? 0, end = start + (range?.length ?? row.bytes);
    let position = start, expectedEnd = start, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          while (position < end) {
            if (!reader) {
              const part = Math.floor(position / CHUNK), offset = position % CHUNK;
              const length = Math.min(end - position, CHUNK - offset);
              const object = await env.OUTPUTS.get(key(id, part), { range: { offset, length } });
              if (!object) throw new Error("Cloud output part is missing");
              expectedEnd = position + length;
              reader = object.body.getReader();
            }
            const next = await reader.read();
            if (next.done) {
              if (position !== expectedEnd) throw new Error("Cloud output part is truncated");
              reader.releaseLock(); reader = undefined; continue;
            }
            position += next.value.length; controller.enqueue(next.value); return;
          }
          await reader?.cancel(); reader = undefined; controller.close();
        } catch (cause) { await reader?.cancel().catch(() => {}); reader = undefined; controller.error(cause); }
      },
      async cancel(reason) { await reader?.cancel(reason); reader = undefined; },
    });
    const safeName = row.filename.replace(/["\\\r\n]/g, "_").replace(/[^\x20-\x7e]/g, "_");
    return new Response(body, { status: range ? 206 : 200, headers: {
      "content-type": "video/mp4", "content-length": String(end - start), "accept-ranges": "bytes",
      ...(range ? { "content-range": `bytes ${start}-${end - 1}/${row.bytes}` } : {}),
      "content-disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
    } });
  }
  if (row.status !== "uploading" || row.created_at + 60 * 60_000 <= now) return error("Upload is closed or expired", 410);
  if (request.method === "PUT") {
    const part = Number(url.searchParams.get("part"));
    if (!url.searchParams.has("part") || !Number.isSafeInteger(part) || part < 0 || part >= Math.ceil(row.max_bytes / CHUNK)) return error("Invalid output part");
    // One in-flight part per output, one attempt per part. Ambiguous writes fail-stop, not paid retries.
    const claimed = await env.DB.prepare("INSERT OR IGNORE INTO cloud_output_parts (output_id, part) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM cloud_outputs WHERE id = ? AND status = 'uploading') AND NOT EXISTS (SELECT 1 FROM cloud_output_parts WHERE output_id = ? AND bytes IS NULL)").bind(id, part, id, id).run();
    if (!claimed.meta.changes) return error("Part already attempted or another part is pending; cancel this output rather than retrying", 409);
    try {
      const bytes = await readBody(request, Math.min(CHUNK, row.max_bytes - part * CHUNK));
      if (!bytes.length || part === 0 && (bytes.length < 12 || new TextDecoder().decode(bytes.subarray(4, 8)) !== "ftyp")) throw new Error("Invalid MP4 output bytes");
      await env.OUTPUTS.put(key(id, part), bytes, { storageClass: "Standard" });
      const active = await env.DB.prepare("UPDATE cloud_output_parts SET bytes = ? WHERE output_id = ? AND part = ? AND EXISTS (SELECT 1 FROM cloud_outputs WHERE id = ? AND status = 'uploading' AND created_at > ?)").bind(bytes.length, id, part, id, Date.now() - 60 * 60_000).run();
      if (!active.meta.changes) { await env.OUTPUTS.delete(key(id, part)); return error("Upload canceled", 410); }
      return Response.json({ uploaded: bytes.length });
    } catch {
      return error("Output part failed. Cancel and start again explicitly; no automatic retry.", 400);
    }
  }
  let input: { bytes?: unknown };
  try { input = await json(request); } catch { return error("Invalid completion request"); }
  if (!input || !Number.isSafeInteger(input.bytes) || Number(input.bytes) <= 0 || Number(input.bytes) > row.max_bytes) return error("Invalid completed size");
  const size = Number(input.bytes), count = Math.ceil(size / CHUNK);
  const parts = await env.DB.prepare("SELECT part, bytes FROM cloud_output_parts WHERE output_id = ? ORDER BY part").bind(id).all<{ part: number; bytes: number | null }>();
  if (parts.results.length !== count || parts.results.some((part, index) => part.part !== index || part.bytes !== Math.min(CHUNK, size - index * CHUNK))) return error("Output parts are incomplete", 409);
  const completed = await env.DB.prepare("UPDATE cloud_outputs SET status = 'ready', bytes = ? WHERE id = ? AND status = 'uploading' AND created_at > ?").bind(size, id, Date.now() - 60 * 60_000).run();
  return completed.meta.changes ? Response.json({ ready: true, bytes: size }) : error("Upload canceled or expired", 410);
}
