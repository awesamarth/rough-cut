import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { ProjectState, TranscriptWord } from "./editor";

export function cloudflare() {
  return getCloudflareContext().env as CloudflareEnv;
}

export type ProjectRow = {
  id: string;
  name: string;
  status: "uploading" | "ready" | "failed";
  version: number;
  source_key: string;
  source_name: string;
  source_type: string;
  source_size: number;
  state_json: string | null;
  transcript_json: string | null;
  created_at: string;
  updated_at: string;
};

export function projectResponse(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    version: row.version,
    sourceName: row.source_name,
    sourceType: row.source_type,
    sourceSize: row.source_size,
    state: row.state_json ? JSON.parse(row.state_json) as ProjectState : null,
    transcript: row.transcript_json ? JSON.parse(row.transcript_json) as TranscriptWord[] : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function findProject(id: string) {
  return cloudflare().DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<ProjectRow>();
}

export function jsonError(message: string, status = 400, details?: unknown) {
  return Response.json({ error: message, details }, { status });
}
