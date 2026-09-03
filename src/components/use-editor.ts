"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { applyCommand, correctTranscriptWords, createProjectState, partitionCaptionWords, reconcileAnchoredCaptions, retimeCaptionsForSpeed, sanitizeTranscript, type EditorCommand, type ProjectState, type TranscriptWord } from "@/lib/editor";
import { rememberProject } from "@/lib/local-projects";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type CommandInput = DistributiveOmit<EditorCommand, "expectedVersion">;
export type ProjectPayload = {
  id: string; name: string; status: string; version: number; sourceName: string; sourceType: string; sourceSize: number;
  state: ProjectState | null; transcript: TranscriptWord[]; updatedAt: string; error?: string;
};

type HistoryEntry = { state: ProjectState; transcript: TranscriptWord[] };

export function useEditor(projectId: string) {
  const [project, setProject] = useState<ProjectPayload | null>(null);
  const [state, setState] = useState<ProjectState | null>(null);
  const [transcript, setTranscriptState] = useState<TranscriptWord[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const stateRef = useRef<ProjectState | null>(null);
  const transcriptRef = useRef<TranscriptWord[]>([]);
  const past = useRef<HistoryEntry[]>([]);
  const future = useRef<HistoryEntry[]>([]);
  const saveChain = useRef(Promise.resolve());
  const pending = useRef(0);

  const install = useCallback((next: ProjectState | null) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const load = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}`, { cache: "no-store" });
    const payload = await response.json() as ProjectPayload;
    if (!response.ok) throw new Error(payload.error || "Could not load project");
    setProject(payload);
    rememberProject(projectId);
    setLastSavedAt(new Date(payload.updatedAt).getTime());
    install(payload.state);
    transcriptRef.current = payload.transcript;
    setTranscriptState(payload.transcript);
    return payload;
  }, [install, projectId]);

  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load project")); }, [load]);

  const persist = useCallback((previousVersion: number, next: ProjectState, summary: string, actor: "human" | "agent" | "system", nextTranscript?: TranscriptWord[]) => {
    pending.current += 1;
    setSaving(true);
    saveChain.current = saveChain.current.then(async () => {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: previousVersion, state: next, transcript: nextTranscript, actor, summary }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Could not save project");
      setLastSavedAt(Date.now());
    }).catch(async (cause) => {
      setError(cause instanceof Error ? cause.message : "Could not save project");
      await load().catch(() => undefined);
      past.current = [];
      future.current = [];
    }).finally(() => {
      pending.current -= 1;
      if (pending.current === 0) setSaving(false);
    });
  }, [load, projectId]);

  const previewClip = useCallback((clipId: string, patch: Partial<ProjectState["clips"][number]>) => {
    setState((current) => {
      if (!current) return current;
      const clip = current.clips.find((item) => item.id === clipId);
      return { ...current, clips: current.clips.map((item) => item.id === clipId ? { ...item, ...patch } : item), captions: clip && patch.speed !== undefined ? retimeCaptionsForSpeed(current.captions, clip, patch.speed) : current.captions };
    });
  }, []);

  const dispatch = useCallback((input: CommandInput) => {
    const current = stateRef.current;
    if (!current) throw new Error("Project is not ready");
    const command = { ...input, expectedVersion: current.version } as EditorCommand;
    const previousTranscript = transcriptRef.current;
    const captionToSplit = input.type === "split_text" && input.kind === "caption" ? current.captions.find((caption) => caption.id === input.id) : undefined;
    const captionSplit = captionToSplit?.sourceWordIds?.length ? partitionCaptionWords(current, previousTranscript, captionToSplit, input.type === "split_text" ? input.timelineMs : 0) : null;
    const next = applyCommand(current, command);
    if (captionSplit && captionToSplit) {
      const index = next.captions.findIndex((caption) => caption.id === captionToSplit.id);
      Object.assign(next.captions[index], captionSplit.left);
      Object.assign(next.captions[index + 1], captionSplit.right);
    }
    let nextTranscript: TranscriptWord[] | undefined;
    if (input.type === "update_caption") {
      const caption = current.captions.find((item) => item.id === input.id);
      const updated = next.captions.find((item) => item.id === input.id);
      const correction = input.patch.text !== undefined && caption?.sourceWordIds?.length ? correctTranscriptWords(previousTranscript, caption.sourceWordIds, input.patch.text) : null;
      if (correction) {
        nextTranscript = correction.words;
        if (updated) updated.sourceWordIds = [correction.anchorId];
      }
    }
    const transformsCaptions = input.type === "remove_segments" || input.type === "delete_clip" || input.type === "trim_clip" || input.type === "reorder_clips" || input.type === "move_clip" || input.type === "set_transition" || input.type === "adjust_clip" && input.patch.speed !== undefined;
    if (transformsCaptions && previousTranscript.length && current.captions.some((caption) => caption.sourceWordIds?.length)) next.captions = reconcileAnchoredCaptions(current, next, previousTranscript);
    past.current.push({ state: current, transcript: structuredClone(previousTranscript) });
    future.current = [];
    if (nextTranscript) { transcriptRef.current = nextTranscript; setTranscriptState(nextTranscript); }
    install(next);
    setError("");
    persist(current.version, next, next.activity[0]?.summary ?? input.type, input.actor, nextTranscript);
    return next;
  }, [install, persist]);

  const initialize = useCallback((durationMs: number) => {
    if (stateRef.current || !project) return;
    const base = createProjectState(project.id, project.name, durationMs);
    const next = { ...base, version: 1 };
    install(next);
    persist(0, next, "Initialized timeline", "system");
  }, [install, persist, project]);

  const undo = useCallback((actor: "human" | "agent" = "human") => {
    const current = stateRef.current;
    const previous = past.current.pop();
    if (!current || !previous) return null;
    future.current.push({ state: current, transcript: structuredClone(transcriptRef.current) });
    const next: ProjectState = {
      ...structuredClone(previous.state), version: current.version + 1,
      activity: [{ id: crypto.randomUUID(), at: new Date().toISOString(), actor, summary: "undo" }, ...current.activity].slice(0, 100),
    };
    transcriptRef.current = previous.transcript;
    setTranscriptState(previous.transcript);
    install(next);
    persist(current.version, next, "Undo", actor, previous.transcript);
    return next;
  }, [install, persist]);

  const redo = useCallback((actor: "human" | "agent" = "human") => {
    const current = stateRef.current;
    const following = future.current.pop();
    if (!current || !following) return null;
    past.current.push({ state: current, transcript: structuredClone(transcriptRef.current) });
    const next: ProjectState = {
      ...structuredClone(following.state), version: current.version + 1,
      activity: [{ id: crypto.randomUUID(), at: new Date().toISOString(), actor, summary: "redo" }, ...current.activity].slice(0, 100),
    };
    transcriptRef.current = following.transcript;
    setTranscriptState(following.transcript);
    install(next);
    persist(current.version, next, "Redo", actor, following.transcript);
    return next;
  }, [install, persist]);

  const saveTranscript = useCallback((words: TranscriptWord[], actor: "human" | "agent" | "system" = "system") => {
    const current = stateRef.current;
    if (!current) throw new Error("Project is not ready");
    words = sanitizeTranscript(words);
    past.current.push({ state: current, transcript: structuredClone(transcriptRef.current) });
    future.current = [];
    const next: ProjectState = {
      ...current, version: current.version + 1,
      activity: [{ id: crypto.randomUUID(), at: new Date().toISOString(), actor, summary: "transcribed video" }, ...current.activity].slice(0, 100),
    };
    transcriptRef.current = words;
    setTranscriptState(words);
    install(next);
    persist(current.version, next, "Transcribed video", actor, words);
    return next;
  }, [install, persist]);

  return {
    project, state, stateRef, transcript, transcriptRef, error, setError, saving, lastSavedAt,
    initialize, dispatch, previewClip, undo, redo, saveTranscript, reload: load,
    canUndo: past.current.length > 0, canRedo: future.current.length > 0,
  };
}
