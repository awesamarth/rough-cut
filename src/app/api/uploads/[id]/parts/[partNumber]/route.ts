import { cloudflare, jsonError } from "@/lib/server";

export const dynamic = "force-dynamic";

type UploadRow = { r2_upload_id: string; source_key: string; status: string };

export async function PUT(request: Request, context: { params: Promise<{ id: string; partNumber: string }> }) {
  const { id, partNumber: rawPartNumber } = await context.params;
  const partNumber = Number(rawPartNumber);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000 || !request.body) return jsonError("Invalid upload part");

  const { DB, MEDIA } = cloudflare();
  const upload = await DB.prepare("SELECT r2_upload_id, source_key, status FROM uploads WHERE id = ?").bind(id).first<UploadRow>();
  if (!upload || upload.status !== "pending") return jsonError("Upload not found", 404);

  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > 8 * 1024 * 1024) return jsonError("Upload part must be between 1 byte and 8 MB");
  const part = await MEDIA.resumeMultipartUpload(upload.source_key, upload.r2_upload_id).uploadPart(partNumber, body);
  return Response.json({ partNumber: part.partNumber, etag: part.etag });
}
