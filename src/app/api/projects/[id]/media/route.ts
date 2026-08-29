import { parseByteRange } from "@/lib/range";
import { cloudflare, findProject, jsonError } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const project = await findProject(id);
  if (!project || project.status !== "ready") return jsonError("Media not found", 404);

  const range = parseByteRange(request.headers.get("range"), project.source_size);
  if (range === null) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${project.source_size}` } });
  const object = await cloudflare().MEDIA.get(project.source_key, range ? { range } : undefined);
  if (!object) return jsonError("Media not found", 404);

  const headers = new Headers({
    "Content-Type": project.source_type,
    "Accept-Ranges": "bytes",
    "ETag": object.httpEtag,
    "Cache-Control": "private, max-age=3600",
    "Content-Length": String(range?.length ?? project.source_size),
  });
  if (range) headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${project.source_size}`);
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

export async function HEAD(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const project = await findProject(id);
  if (!project || project.status !== "ready") return new Response(null, { status: 404 });
  const object = await cloudflare().MEDIA.head(project.source_key);
  if (!object) return new Response(null, { status: 404 });
  return new Response(null, { headers: { "Content-Type": project.source_type, "Content-Length": String(project.source_size), "Accept-Ranges": "bytes", ETag: object.httpEtag } });
}
