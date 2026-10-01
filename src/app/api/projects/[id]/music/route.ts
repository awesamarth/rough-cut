import { parseByteRange } from "@/lib/range";
import { cloudflare, jsonError } from "@/lib/server";

export const dynamic = "force-dynamic";
const assetId = (request: Request) => { const value = new URL(request.url).searchParams.get("asset"); return value && /^[a-f0-9-]{36}$/i.test(value) ? value : null; };
const key = (id: string, asset: string) => `projects/${id}/music/${asset}`;

export async function POST() {
  return jsonError("Cloud music uploads are retired. Download a project backup and import it as a local project to add music. Existing cloud music is unchanged.", 410);
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
