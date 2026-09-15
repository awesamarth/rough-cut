import { cloudflare, jsonError } from "@/lib/server";
import { reserveCloudUsage } from "@/lib/cloud-budget";
import { timelineDuration, validateState } from "@/lib/editor";
import { readBody } from "@/lib/request-body";

export const dynamic = "force-dynamic";

async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const env = cloudflare() as CloudflareEnv & { MEDIA_WORKER_TOKEN?: string; CLOUD_EXPORTS_DAILY_LIMIT?: string };
  if (!env.MEDIA_WORKER_URL || !env.MEDIA_WORKER_TOKEN) return jsonError("Media service is not configured", 503);
  const { path } = await context.params;
  const route = path.join("/");
  const isExport = request.method === "POST" && route === "exports";
  const isJob = request.method === "GET" && /^jobs\/[a-f0-9-]{36}(\/output)?$/i.test(route);
  if (!isExport && !isJob) return jsonError("This media operation is not available through the public proxy. Audio analysis and preparation run locally.", 404);
  if (isJob) {
    const admitted = await env.DB.prepare("SELECT id FROM cloud_jobs WHERE id = ? AND expires_at > ?").bind(path[1], Date.now()).first();
    if (!admitted) return jsonError("Export expired or not found. Render again explicitly if needed.", 410);
  }
  if (isExport) {
    const limit = Number(env.CLOUD_EXPORTS_DAILY_LIMIT ?? 0);
    if (!Number.isSafeInteger(limit) || limit <= 0) return jsonError("Cloud rendering is unavailable. You can export on this device instead.", 503);
    let body: Uint8Array<ArrayBuffer>;
    try { body = await readBody(request, 2 * 1024 * 1024); }
    catch { return jsonError("Export request is too large", 413); }
    request = new Request(request.url, { method: "POST", headers: request.headers, body });
    const input = await request.clone().json().catch(() => null) as { state?: unknown } | null;
    try { validateState(input?.state); }
    catch (error) { return jsonError(error instanceof Error ? error.message : "Invalid export state"); }
    if (timelineDuration(input!.state!) > 600_000) return jsonError("Cloud fallback supports exports up to 10 minutes");
    if (!await reserveCloudUsage(env.DB, "exports", 1, limit, limit)) return jsonError("This app's daily cloud export allowance has been reached. No Container was started.", 429);
  }
  const incoming = new URL(request.url);
  const target = new URL(path.map(encodeURIComponent).join("/"), `${env.MEDIA_WORKER_URL.replace(/\/$/, "")}/`);
  target.search = incoming.search;
  const filename = target.searchParams.get("filename");
  target.searchParams.delete("filename");
  const upstream = new Request(target, request);
  upstream.headers.set("authorization", `Bearer ${env.MEDIA_WORKER_TOKEN}`);
  upstream.headers.delete("host");
  const response = await fetch(upstream);
  if (isExport && response.ok) {
    const job = await response.clone().json() as { id?: string };
    if (!job.id || !/^[a-f0-9-]{36}$/i.test(job.id)) return jsonError("Media service returned an invalid job", 502);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM cloud_jobs WHERE expires_at <= ?").bind(Date.now()),
      env.DB.prepare("INSERT INTO cloud_jobs (id, expires_at) VALUES (?, ?)").bind(job.id, Date.now() + 30 * 60_000),
    ]);
  }
  if (!filename || !response.ok) return response;
  const safeName = filename.replace(/[\r\n"\\/]/g, "_").slice(0, 180);
  const fallbackName = safeName.replace(/[^\x20-\x7E]/g, "_");
  const headers = new Headers(response.headers);
  headers.set("content-disposition", `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export const GET = proxy;
export const POST = proxy;
export const OPTIONS = proxy;
