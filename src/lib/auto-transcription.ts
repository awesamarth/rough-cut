export const AUTO_TRANSCRIBE_KEY = "rough-cut.auto-transcribe";

// Like the selected source File, this one-shot request lives only until navigation/reload.
// Remember the preference, not unfinished cloud jobs: reopening must not silently retry.
const pending = new Set<string>();
export function queueAutoTranscription(projectId: string) { pending.add(projectId); }
export function takeAutoTranscription(projectId: string) { return pending.delete(projectId); }
