import { cloudflare, jsonError } from "@/lib/server";

export const dynamic = "force-dynamic";
type UploadRow = { project_id: string; r2_upload_id: string; source_key: string; status: string };

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const input = await request.json().catch(() => null) as { parts?: Array<{ partNumber: number; etag: string }> } | null;
  if (!input?.parts?.length || input.parts.some((part) => !Number.isInteger(part.partNumber) || typeof part.etag !== "string")) return jsonError("Upload parts are required");

  const { DB, MEDIA } = cloudflare();
  const upload = await DB.prepare("SELECT project_id, r2_upload_id, source_key, status FROM uploads WHERE id = ?").bind(id).first<UploadRow>();
  if (!upload || upload.status !== "pending") return jsonError("Upload not found", 404);

  await MEDIA.resumeMultipartUpload(upload.source_key, upload.r2_upload_id).complete(input.parts.sort((a, b) => a.partNumber - b.partNumber));
  await DB.batch([
    DB.prepare("UPDATE uploads SET status = 'complete' WHERE id = ?").bind(id),
    DB.prepare("UPDATE projects SET status = 'ready', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(upload.project_id),
  ]);

  return Response.json({ projectId: upload.project_id });
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { DB, MEDIA } = cloudflare();
  const upload = await DB.prepare("SELECT project_id, r2_upload_id, source_key, status FROM uploads WHERE id = ?").bind(id).first<UploadRow>();
  if (!upload || upload.status !== "pending") return jsonError("Upload not found", 404);
  await MEDIA.resumeMultipartUpload(upload.source_key, upload.r2_upload_id).abort();
  await DB.batch([
    DB.prepare("UPDATE uploads SET status = 'aborted' WHERE id = ?").bind(id),
    DB.prepare("UPDATE projects SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(upload.project_id),
  ]);
  return new Response(null, { status: 204 });
}
