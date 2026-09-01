import { cloudflare, jsonError } from "@/lib/server";

export const dynamic = "force-dynamic";

async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const env = cloudflare() as CloudflareEnv & { MEDIA_WORKER_TOKEN?: string };
  if (!env.MEDIA_WORKER_URL || !env.MEDIA_WORKER_TOKEN) return jsonError("Media service is not configured", 503);
  const { path } = await context.params;
  const incoming = new URL(request.url);
  const target = new URL(path.map(encodeURIComponent).join("/"), `${env.MEDIA_WORKER_URL.replace(/\/$/, "")}/`);
  target.search = incoming.search;
  const filename = target.searchParams.get("filename");
  target.searchParams.delete("filename");
  const upstream = new Request(target, request);
  upstream.headers.set("authorization", `Bearer ${env.MEDIA_WORKER_TOKEN}`);
  upstream.headers.delete("host");
  const response = await fetch(upstream);
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
