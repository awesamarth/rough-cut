// Run these in a single D1 batch. The second statement must immediately follow the update.
export const UPDATE_PROJECT = `UPDATE projects SET name = ?, version = ?, state_json = ?, transcript_json = COALESCE(?, transcript_json), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND version = ?`;
export const INSERT_REVISION = `INSERT INTO revisions (project_id, version, state_json, actor, summary) SELECT id, version, state_json, ?, ? FROM projects WHERE id = ? AND version = ? AND changes() = 1`;
