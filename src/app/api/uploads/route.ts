import { cloudflare, jsonError } from "@/lib/server";

export const dynamic = "force-dynamic";
const CHUNK_SIZE = 8 * 1024 * 1024;

export async function POST(request: Request) {
  const input = await request.json().catch(() => null) as { name?: string; type?: string; size?: number } | null;
  if (!input?.name || !input.type?.startsWith("video/") || !Number.isFinite(input.size) || input.size! <= 0 || input.size! > 20 * 1024 ** 3) {
    return jsonError("A valid video up to 20 GB is required");
  }

  const { DB, MEDIA } = cloudflare();
  const projectId = crypto.randomUUID();
  const uploadId = crypto.randomUUID();
  const sourceKey = `projects/${projectId}/source`;
  const multipart = await MEDIA.createMultipartUpload(sourceKey, {
    httpMetadata: { contentType: input.type, contentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(input.name)}` },
    customMetadata: { originalName: input.name, projectId },
  });

  try {
    await DB.batch([
      DB.prepare("INSERT INTO projects (id, name, source_key, source_name, source_type, source_size) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(projectId, input.name.replace(/\.[^.]+$/, "") || "Untitled", sourceKey, input.name, input.type, input.size),
      DB.prepare("INSERT INTO uploads (id, project_id, r2_upload_id, source_key) VALUES (?, ?, ?, ?)")
        .bind(uploadId, projectId, multipart.uploadId, sourceKey),
    ]);
  } catch (error) {
    await multipart.abort().catch(() => undefined);
    throw error;
  }

  return Response.json({ uploadId, projectId, chunkSize: CHUNK_SIZE });
}
