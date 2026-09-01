import { parseByteRange } from "@/lib/range";
import { cloudflare, findProject, jsonError } from "@/lib/server";

export const dynamic = "force-dynamic";
const MAX_SIZE = 100 * 1024 * 1024;
const assetId = (request: Request) => { const value = new URL(request.url).searchParams.get("asset"); return value && /^[a-f0-9-]{36}$/i.test(value) ? value : null; };
const key = (id: string, asset: string) => `projects/${id}/music/${asset}`;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!await findProject(id)) return jsonError("Project not found", 404);
  const data = await request.formData().catch(() => null);
  const file = data?.get("music");
  if (!(file instanceof File) || !file.type.startsWith("audio/") || file.size <= 0 || file.size > MAX_SIZE) return jsonError("An audio file up to 100 MB is required");
  const asset = crypto.randomUUID();
  await cloudflare().MEDIA.put(key(id, asset), await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type, contentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(file.name)}` },
    customMetadata: { originalName: file.name, projectId: id },
  });
  return Response.json({ id: asset, name: file.name, type: file.type, size: file.size });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const asset = assetId(request);
  if (!asset) return jsonError("Invalid music asset", 400);
  const bucket = cloudflare().MEDIA;
  const head = await bucket.head(key(id, asset));
  if (!head) return jsonError("Music not found", 404);
  const range = parseByteRange(request.headers.get("range"), head.size);
  if (range === null) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${head.size}` } });
  const object = await bucket.get(key(id, asset), range ? { range } : undefined);
  if (!object) return jsonError("Music not found", 404);
  const headers = new Headers({
    "Content-Type": head.httpMetadata?.contentType || "audio/mpeg",
    "Accept-Ranges": "bytes",
    "ETag": object.httpEtag,
    "Cache-Control": "private, max-age=3600",
    "Content-Length": String(range?.length ?? head.size),
  });
  if (range) headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

export async function HEAD(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const asset = assetId(request);
  if (!asset) return new Response(null, { status: 400 });
  const object = await cloudflare().MEDIA.head(key(id, asset));
  if (!object) return new Response(null, { status: 404 });
  return new Response(null, { headers: { "Content-Type": object.httpMetadata?.contentType || "audio/mpeg", "Content-Length": String(object.size), "Accept-Ranges": "bytes", ETag: object.httpEtag } });
}
