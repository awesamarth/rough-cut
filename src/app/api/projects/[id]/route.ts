import { validateState, type ProjectState, type TranscriptWord } from "@/lib/editor";
import { cloudflare, findProject, jsonError, projectResponse } from "@/lib/server";
import { INSERT_REVISION, UPDATE_PROJECT } from "@/lib/project-sql";

export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const project = await findProject(id);
  return project ? Response.json(projectResponse(project)) : jsonError("Project not found", 404);
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const input = await request.json().catch(() => null) as {
    expectedVersion?: number;
    state?: ProjectState;
    transcript?: TranscriptWord[];
    actor?: "human" | "agent" | "system";
    summary?: string;
  } | null;

  if (!input?.state || !Number.isInteger(input.expectedVersion) || input.state.id !== id || input.state.version !== input.expectedVersion! + 1) return jsonError("Invalid project update");
  try { validateState(input.state); } catch (error) { return jsonError(error instanceof Error ? error.message : "Invalid project state"); }

  if (input.transcript && (!Array.isArray(input.transcript) || input.transcript.some((word) => typeof word.word !== "string" || !Number.isFinite(word.startMs) || !Number.isFinite(word.endMs) || word.startMs < 0 || word.endMs <= word.startMs))) {
    return jsonError("Invalid transcript");
  }

  const actor = input.actor === "agent" || input.actor === "system" ? input.actor : "human";
  const summary = String(input.summary || "Updated project").slice(0, 200);
  const { DB } = cloudflare();
  const stateJson = JSON.stringify(input.state);
  // D1 batches are transactional. Record a revision only if this conditional update won.
  const [update] = await DB.batch([
    DB.prepare(UPDATE_PROJECT)
      .bind(input.state.name, input.state.version, stateJson, input.transcript ? JSON.stringify(input.transcript) : null, id, input.expectedVersion),
    DB.prepare(INSERT_REVISION)
      .bind(actor, summary, id, input.state.version),
  ]);

  if (!update.meta.changes) {
    const current = await DB.prepare("SELECT version FROM projects WHERE id = ?").bind(id).first<{ version: number }>();
    return jsonError("Project changed since it was read", 409, { currentVersion: current?.version });
  }

  const project = await findProject(id);
  return Response.json(projectResponse(project!));
}
