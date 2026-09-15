"use client";
import { useConfirmation } from "./modal";
import { useCallback, useEffect, useRef, useState } from "react";
import { takeAutoTranscription } from "@/lib/auto-transcription";
import { prepareAudioChunk } from "@/lib/browser-audio";
import { sanitizeTranscript, type ProjectState, type TranscriptWord } from "@/lib/editor";
import type { MediaSource } from "@/lib/video-renderer";

export function useTranscription(projectId: string, source: MediaSource | undefined, stateRef: { current: ProjectState | null }, save: (words: TranscriptWord[], actor: "human" | "agent" | "system") => ProjectState, durability: () => Promise<void>, ready: boolean, onError: (message: string) => void) {
  const { confirm, confirmation } = useConfirmation();
  const active = useRef<AbortController | null>(null);
  const [status, setStatus] = useState("");
  useEffect(() => () => active.current?.abort(), []);
  const run = useCallback(async (actor: "human" | "agent" | "system" = "human", provider: "cloudflare" | "openai" = "cloudflare", apiKey = "", onProgress?: (message: string) => void, expectedVersion?: number, uploadConsent = false) => {
    if (active.current) throw new Error("Transcription is already running");
    const initial = stateRef.current;
    if (!initial || !source) throw new Error("Select the source media before transcribing");
    if (!navigator.locks) throw new Error("This browser cannot coordinate transcription safely across tabs");
    const controller = new AbortController(); active.current = controller;
    const progress = (message: string) => { setStatus(message); onProgress?.(message); };
    try {
      if (!uploadConsent && !await confirm(`Send audio to ${provider === "openai" ? "OpenAI using your key" : "Cloudflare Workers AI"} for transcription? No source video will be uploaded.`, "Transcribe video?", "Transcribe")) throw new Error("Transcription canceled");
      controller.signal.throwIfAborted();
      await durability();
      controller.signal.throwIfAborted();
      if (expectedVersion !== undefined && stateRef.current?.version !== expectedVersion) throw new Error(`STALE_VERSION:${stateRef.current?.version}`);
      return await navigator.locks.request(`rough-cut-transcription:${projectId}`, { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error("This project is already being transcribed in another tab");
        const chunks = Math.ceil(initial.durationMs / 300_000);
        const words: TranscriptWord[] = [];
        let cache: Cache | undefined;
        try { cache = await caches.open("rough-cut-transcription-v2"); } catch {}
        for (let index = 0; index < chunks; index++) {
          controller.signal.throwIfAborted();
          const offsetMs = index * 300_000;
          const key = new URL(`/__rough_cut_transcript_v2/${projectId}/${provider}/${index}`, location.origin).href;
          let result: { words?: TranscriptWord[]; error?: string } | undefined;
          try { const checkpoint = await cache?.match(key); if (checkpoint) result = await checkpoint.json(); } catch {}
          if (!Array.isArray(result?.words)) {
            progress(`Preparing audio locally ${index + 1}/${chunks}…`);
            const chunk = await prepareAudioChunk(source, offsetMs, Math.min(initial.durationMs, offsetMs + 300_000), controller.signal);
            if (!chunk.hasSamples) result = { words: [] };
            else {
              const form = new FormData(); form.set("audio", chunk.audio, `chunk-${index}.wav`); form.set("provider", provider);
              progress(`Transcribing ${index + 1}/${chunks}…`);
              const response = await fetch("/api/transcribe", { method: "POST", headers: provider === "openai" ? { "x-openai-key": apiKey } : undefined, body: form, signal: controller.signal });
              result = await response.json();
              if (!response.ok || !Array.isArray(result?.words)) throw new Error(result?.error || "Transcription failed");
              result.words = sanitizeTranscript(result.words);
            }
            try { await cache?.put(key, Response.json(result)); } catch {}
          }
          words.push(...sanitizeTranscript(result!.words!).map((word) => ({ ...word, startMs: word.startMs + offsetMs, endMs: word.endMs + offsetMs })));
        }
        controller.signal.throwIfAborted();
        if (expectedVersion !== undefined && stateRef.current?.version !== expectedVersion) throw new Error(`STALE_VERSION:${stateRef.current?.version}`);
        return save(words, actor);
      });
    } finally { active.current = null; progress(""); }
  }, [projectId, source, stateRef, save, durability, confirm]);
  useEffect(() => {
    if (!ready || !source || !stateRef.current || !takeAutoTranscription(projectId)) return;
    void run("system", "cloudflare", "", undefined, stateRef.current.version, true).catch((error) => onError(error instanceof Error ? error.message : "Automatic transcription failed"));
  }, [ready, source, stateRef, projectId, run, onError]);
  return { run, status, confirmation, cancel: () => active.current?.abort() };
}
