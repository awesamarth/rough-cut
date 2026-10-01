"use client";
import { useConfirmation } from "./modal";
import { useCallback, useEffect, useRef, useState } from "react";
import { takeAutoTranscription } from "@/lib/auto-transcription";
import { prepareAudioChunk } from "@/lib/browser-audio";
import { sanitizeTranscript, type ProjectState, type TranscriptWord } from "@/lib/editor";
import { transcribeRanges, transcriptionRanges } from "@/lib/transcription-plan";
import type { MediaSource } from "@/lib/video-renderer";

const cancelled = () => new DOMException("Cancelled.", "AbortError");
export function useTranscription(projectId: string, source: MediaSource | undefined, stateRef: { current: ProjectState | null }, transcriptRef: { current: TranscriptWord[] }, save: (words: TranscriptWord[], actor: "human" | "agent" | "system") => ProjectState, durability: () => Promise<void>, ready: boolean, onError: (message: string) => void) {
  const { confirm, confirmation } = useConfirmation();
  const active = useRef<AbortController | null>(null);
  const [status, setStatus] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    setStatus(""); setNotice("");
    return () => { active.current?.abort(cancelled()); active.current = null; };
  }, [projectId, source]);
  const run = useCallback(async (actor: "human" | "agent" | "system" = "human", provider: "cloudflare" | "openai" = "cloudflare", apiKey = "", onProgress?: (message: string) => void, expectedVersion?: number, uploadConsent = false) => {
    if (active.current) throw new Error("Transcription is already running");
    const initial = stateRef.current;
    if (!initial || !source) throw new Error("Select the source media before transcribing");
    if (!navigator.locks) throw new Error("This browser cannot coordinate transcription safely across tabs");
    const ranges = transcriptionRanges(initial);
    if (!ranges.length) throw new Error("There are no video clips to transcribe.");
    const controller = new AbortController(); active.current = controller;
    let saved = 0;
    setNotice("");
    const progress = (message: string) => { if (active.current === controller) { setStatus(message); onProgress?.(message); } };
    progress("Preparing transcription…");
    try {
      if (!uploadConsent && !await confirm(`Send audio from the clips kept in your current edit to ${provider === "openai" ? "OpenAI using your key" : "Cloudflare Workers AI"} for transcription? Removed sections and source video will not be uploaded. Completed results are saved as each part finishes.`, "Transcribe video?", "Transcribe")) throw cancelled();
      controller.signal.throwIfAborted();
      await durability();
      controller.signal.throwIfAborted();
      if (stateRef.current?.version !== (expectedVersion ?? initial.version)) throw new Error("Project changed before transcription started. Please try again.");
      const result = await navigator.locks.request(`rough-cut-transcription:${projectId}`, { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error("This project is already being transcribed in another tab");
        let cache: Cache | undefined;
        try { cache = await caches.open("rough-cut-transcription-v3"); } catch {}
        return transcribeRanges({
          ranges, signal: controller.signal, expectedVersion: initial.version,
          state: () => { if (!stateRef.current || stateRef.current.id !== projectId) throw cancelled(); return stateRef.current; },
          transcript: () => transcriptRef.current,
          save: (words) => save(words, actor), durability, saved: () => { saved++; },
          read: async ({ startMs, endMs }, index) => {
            const key = new URL(`/__rough_cut_transcript_v3/${projectId}/${provider}/${startMs}-${endMs}`, location.origin).href;
            let result: { words?: TranscriptWord[]; error?: string } | undefined;
            try { const checkpoint = await cache?.match(key); if (checkpoint) result = await checkpoint.json(); } catch {}
            // Reuse already-paid v2 source chunks when they fully cover this retained range.
            const bucket = Math.floor(startMs / 300_000), offset = bucket * 300_000;
            if (!Array.isArray(result?.words) && endMs <= offset + 300_000) {
              try {
                const old = await caches.open("rough-cut-transcription-v2");
                const response = await old.match(new URL(`/__rough_cut_transcript_v2/${projectId}/${provider}/${bucket}`, location.origin).href);
                const checkpoint = (response ? await response.json() : undefined) as { words?: TranscriptWord[] } | undefined;
                if (Array.isArray(checkpoint?.words)) result = { words: sanitizeTranscript(checkpoint.words).filter((word) => word.endMs + offset > startMs && word.startMs + offset < endMs).map((word) => ({ ...word, startMs: Math.max(0, word.startMs + offset - startMs), endMs: Math.min(endMs, word.endMs + offset) - startMs })) };
              } catch {}
            }
            controller.signal.throwIfAborted();
            if (!Array.isArray(result?.words)) {
              progress(`Preparing audio locally ${index + 1}/${ranges.length}…`);
              const chunk = await prepareAudioChunk(source, startMs, endMs, controller.signal);
              controller.signal.throwIfAborted();
              if (!chunk.hasSamples) result = { words: [] };
              else {
                const form = new FormData(); form.set("audio", chunk.audio, `chunk-${index}.wav`); form.set("provider", provider);
                progress(`Transcribing ${index + 1}/${ranges.length}…`);
                const response = await fetch("/api/transcribe", { method: "POST", headers: provider === "openai" ? { "x-openai-key": apiKey } : undefined, body: form, signal: controller.signal });
                result = await response.json();
                if (!response.ok || !Array.isArray(result?.words)) throw new Error(result?.error || "Transcription failed");
                result.words = sanitizeTranscript(result.words);
              }
              try { await cache?.put(key, Response.json(result)); } catch {}
            }
            progress(`Saving transcript ${index + 1}/${ranges.length}…`);
            return result!.words!;
          },
        });
      });
      if (active.current === controller) setNotice(saved ? "Transcription saved." : "No speech found. Existing transcript kept.");
      return result;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        const message = saved ? "Cancelled. Completed transcription saved." : "Cancelled.";
        if (active.current === controller) setNotice(message);
        throw new DOMException(message, "AbortError");
      }
      if (saved && active.current === controller) setNotice("Completed transcription saved.");
      throw error;
    } finally {
      if (active.current === controller) { progress(""); active.current = null; }
    }
  }, [projectId, source, stateRef, transcriptRef, save, durability, confirm]);
  useEffect(() => {
    if (!ready || !source || !stateRef.current || !takeAutoTranscription(projectId)) return;
    void run("system", "cloudflare", "", undefined, stateRef.current.version, true).catch((error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) onError(error instanceof Error ? error.message : "Automatic transcription failed");
    });
  }, [ready, source, stateRef, projectId, run, onError]);
  return { run, status, notice, confirmation, cancel: () => active.current?.abort(cancelled()) };
}
