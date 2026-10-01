"use client";
import { useConfirmation } from "./modal";

import { useCallback, useEffect, useRef, useState } from "react";
import { applyEdit, createProjectState, replaceTranscript, sanitizeTranscript, validateState, type EditorCommand, type ProjectState, type TranscriptWord } from "@/lib/editor";
import { rememberProject } from "@/lib/local-projects";
import { SaveQueue } from "@/lib/save-queue";
import { claimRecoveryKey } from "@/lib/recovery";
import { advanceHistory, boundHistory, getLocalProject, saveLocalProject, type LocalDocument } from "@/lib/local-store";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type CommandInput = DistributiveOmit<EditorCommand, "expectedVersion">;
export type ProjectPayload = {
  id: string; name: string; status: string; version: number; sourceName: string; sourceType: string; sourceSize: number;
  state: ProjectState | null; transcript: TranscriptWord[]; updatedAt: string; error?: string; local?: boolean;
};

type HistoryEntry = { state: ProjectState; transcript: TranscriptWord[] };

export function useEditor(projectId: string) {
  const { confirm, confirmation } = useConfirmation();
  const [project, setProject] = useState<ProjectPayload | null>(null);
  const [state, setState] = useState<ProjectState | null>(null);
  const [localDocument, setLocalDocument] = useState<LocalDocument | null>(null);
  const isLocal = useRef(false);
  const [transcript, setTranscriptState] = useState<TranscriptWord[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const stateRef = useRef<ProjectState | null>(null);
  const transcriptRef = useRef<TranscriptWord[]>([]);
  const past = useRef<HistoryEntry[]>([]);
  const future = useRef<HistoryEntry[]>([]);
  const saveQueue = useRef(new SaveQueue());
  const pending = useRef(0);
  const failed = useRef(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [recoveryRaw, setRecoveryRaw] = useState<string | null>(null);
  const recoveryKey = useRef("");
  const durability = useCallback(() => saveQueue.current.flush(), []);

  const install = useCallback((next: ProjectState | null) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const load = useCallback(async (signal: AbortSignal) => {
    const key = await claimRecoveryKey(projectId, signal);
    signal.throwIfAborted();
    recoveryKey.current = key;
    const local = await getLocalProject(projectId);
    signal.throwIfAborted();
    let payload: ProjectPayload;
    if (local) {
      validateState(local.state);
      isLocal.current = true;
      const history = boundHistory(local.past, local.future);
      setLocalDocument({ ...local, ...history });
      past.current = history.past;
      future.current = history.future;
      payload = { id: local.id, name: local.state.name, status: "ready", version: local.state.version, sourceName: local.source.name, sourceType: local.source.type, sourceSize: local.source.size, state: local.state, transcript: local.transcript, updatedAt: local.updatedAt, local: true };
    } else {
      const response = await fetch(`/api/projects/${projectId}`, { cache: "no-store", signal });
      payload = await response.json() as ProjectPayload;
      if (!response.ok) throw new Error(payload.error || "Could not load project");
    }
    signal?.throwIfAborted();
    setProject(payload);
    rememberProject(projectId);
    setLastSavedAt(new Date(payload.updatedAt).getTime());
    let recovered: HistoryEntry | null = null;
    {
      const saved = localStorage.getItem(recoveryKey.current);
      if (saved) {
        let unreadable = false;
        try {
          recovered = JSON.parse(saved) as HistoryEntry;
          validateState(recovered.state);
          if (recovered.state.id !== projectId) throw new Error("Invalid recovery project");
          const words = sanitizeTranscript(recovered.transcript);
          if (words.length !== recovered.transcript.length || words.some((word) => typeof word.id !== "string" || !word.id) || new Set(words.map((word) => word.id)).size !== words.length) throw new Error("Invalid recovery transcript");
          recovered.transcript = words;
        } catch {
          recovered = null; unreadable = true; setRecoveryRaw(saved);
        }
        saveQueue.current.block(new Error("Recovered uncommitted edits"));
        failed.current = true;
        setSaveFailed(true);
        setError(unreadable ? "Pending recovery data is unreadable. The saved project is shown, but edits are blocked. Download the raw recovery data before discarding it." : "Recovered pending edits. Back them up before reloading the saved version; they have not been committed.");
      }
    }
    install(recovered?.state ?? payload.state);
    transcriptRef.current = recovered?.transcript ?? payload.transcript;
    setTranscriptState(transcriptRef.current);
    return payload;
  }, [install, projectId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load project"); });
    return () => controller.abort();
  }, [load]);

  const persist = useCallback((previousVersion: number, next: ProjectState, summary: string, actor: "human" | "agent" | "system", nextTranscript?: TranscriptWord[], mode: "edit" | "undo" | "redo" = "edit") => {
    saveQueue.current.assertWritable();
    // Journal before installing optimistic state. Storage failure must reject the edit.
    const document = { state: next, transcript: nextTranscript ?? transcriptRef.current };
    const journalKey = recoveryKey.current;
    localStorage.setItem(journalKey, JSON.stringify(document));
    pending.current += 1;
    setSaving(true);
    void saveQueue.current.enqueue(async () => {
      if (isLocal.current) {
        await saveLocalProject(projectId, previousVersion, document, mode);
        setLastSavedAt(Date.now());
        return;
      }
      const response = await fetch(`/api/projects/${projectId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: previousVersion, state: next, transcript: nextTranscript, actor, summary }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Could not save project");
      setLastSavedAt(Date.now());
    }).catch((cause) => {
      failed.current = true;
      setSaveFailed(true);
      setError(`${cause instanceof Error ? cause.message : "Could not save project"}. Pending edits are preserved locally; back them up before reloading.`);
    }).finally(() => {
      pending.current -= 1;
      if (pending.current === 0) {
        setSaving(false);
        if (!failed.current) {
          try { localStorage.removeItem(journalKey); } catch { /* A leftover journal is recoverable. */ }
        }
      }
    });
  }, [projectId]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (pending.current || failed.current) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const discardRecovery = useCallback(async () => {
    if (!await confirm("Discard the locally preserved pending edits and reload the saved version? Download a backup first if you need these edits.", "Discard pending edits?", "Discard")) return;
    localStorage.removeItem(recoveryKey.current);
    failed.current = false;
    window.location.reload();
  }, [confirm]);

  const previewClip = useCallback((clipId: string, patch: Partial<ProjectState["clips"][number]>) => {
    const current = stateRef.current;
    if (!current) return;
    try {
      const command: EditorCommand = patch.transition
        ? { type: "set_transition", actor: "human", expectedVersion: current.version, clipId, transition: patch.transition }
        : { type: "adjust_clip", actor: "human", expectedVersion: current.version, clipId, patch };
      const preview = applyEdit({ state: current, transcript: transcriptRef.current }, command).state;
      setState({ ...preview, version: current.version, activity: current.activity });
    } catch (cause) { setState(current); setError(cause instanceof Error ? cause.message : "Preview failed"); }
  }, []);

  const dispatch = useCallback((input: CommandInput) => {
    const current = stateRef.current;
    if (!current) throw new Error("Project is not ready");
    try {
    saveQueue.current.assertWritable();
    const command = { ...input, expectedVersion: current.version } as EditorCommand;
    const previousTranscript = transcriptRef.current;
    const result = applyEdit({ state: current, transcript: previousTranscript }, command);
    const next = result.state;
    const nextTranscript = result.transcript === previousTranscript ? undefined : result.transcript;
    const history = advanceHistory(past.current, future.current, { state: current, transcript: structuredClone(previousTranscript) }, "edit");
    persist(current.version, next, next.activity[0]?.summary ?? input.type, input.actor, nextTranscript);
    past.current = history.past; future.current = history.future;
    if (nextTranscript) { transcriptRef.current = nextTranscript; setTranscriptState(nextTranscript); }
    install(next);
    setError("");
    return next;
    } catch (cause) {
      install(current); // Roll back a slider preview when its committed edit is rejected.
      setError(cause instanceof Error ? cause.message : "Could not apply edit");
      throw cause;
    }
  }, [install, persist]);

  const initialize = useCallback((durationMs: number) => {
    if (stateRef.current || !project) return;
    const base = createProjectState(project.id, project.name, durationMs);
    const next = { ...base, version: 1 };
    persist(0, next, "Initialized timeline", "system");
    install(next);
  }, [install, persist, project]);

  const undo = useCallback((actor: "human" | "agent" = "human") => {
    const current = stateRef.current;
    if (failed.current) return null;
    const previous = past.current.at(-1);
    if (!current || !previous) return null;
    const next: ProjectState = {
      ...structuredClone(previous.state), version: current.version + 1,
      activity: [{ id: crypto.randomUUID(), at: new Date().toISOString(), actor, summary: "undo" }, ...current.activity].slice(0, 100),
    };
    const history = advanceHistory(past.current, future.current, { state: current, transcript: structuredClone(transcriptRef.current) }, "undo");
    persist(current.version, next, "Undo", actor, previous.transcript, "undo");
    past.current = history.past; future.current = history.future;
    transcriptRef.current = previous.transcript;
    setTranscriptState(previous.transcript);
    install(next);
    return next;
  }, [install, persist]);

  const redo = useCallback((actor: "human" | "agent" = "human") => {
    const current = stateRef.current;
    if (failed.current) return null;
    const following = future.current.at(-1);
    if (!current || !following) return null;
    const next: ProjectState = {
      ...structuredClone(following.state), version: current.version + 1,
      activity: [{ id: crypto.randomUUID(), at: new Date().toISOString(), actor, summary: "redo" }, ...current.activity].slice(0, 100),
    };
    const history = advanceHistory(past.current, future.current, { state: current, transcript: structuredClone(transcriptRef.current) }, "redo");
    persist(current.version, next, "Redo", actor, following.transcript, "redo");
    past.current = history.past; future.current = history.future;
    transcriptRef.current = following.transcript;
    setTranscriptState(following.transcript);
    install(next);
    return next;
  }, [install, persist]);

  const saveTranscript = useCallback((words: TranscriptWord[], actor: "human" | "agent" | "system" = "system") => {
    const current = stateRef.current;
    if (!current) throw new Error("Project is not ready");
    const result = replaceTranscript({ state: current, transcript: transcriptRef.current }, words, actor);
    const next = result.state;
    words = result.transcript;
    const history = advanceHistory(past.current, future.current, { state: current, transcript: structuredClone(transcriptRef.current) }, "edit");
    persist(current.version, next, next.activity[0].summary, actor, words);
    past.current = history.past; future.current = history.future;
    transcriptRef.current = words;
    setTranscriptState(words);
    install(next);
    return next;
  }, [install, persist]);

  return {
    project, localDocument, state, stateRef, transcript, transcriptRef, error, setError, saving, lastSavedAt,
    initialize, dispatch, previewClip, undo, redo, saveTranscript, durability, saveFailed, recoveryRaw, discardRecovery, confirmation,
    canUndo: !saveFailed && past.current.length > 0, canRedo: !saveFailed && future.current.length > 0,
  };
}
