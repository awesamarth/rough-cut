"use client";

import Link from "next/link";
import { Link2, Magnet, RotateCcw, Unlink2, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { clipDuration, timelineClips, timelineDuration, timelineToSource, type Clip, type ProjectState, type SourceRange, type TimedText, type TranscriptWord } from "@/lib/editor";
import { exportEdl } from "@/lib/edl";
import { type CommandInput, useEditor } from "./use-editor";
import { useWebMCP } from "./use-webmcp";

const MEDIA_URL = "/api/media";
const formatTime = (ms: number) => {
  const seconds = Math.max(0, ms) / 1000;
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}.${String(Math.floor((seconds % 1) * 10))}`;
};
const cssFilter = (clip?: Clip) => clip ? `brightness(${1 + clip.brightness}) contrast(${clip.contrast}) saturate(${clip.saturation}) hue-rotate(${clip.hue}deg)` : undefined;
const cssTransform = (clip?: Clip) => clip ? `translate(${clip.positionX}%, ${clip.positionY}%) scale(${clip.scaleX}, ${clip.scaleY})` : undefined;

function downloadText(name: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click();
  URL.revokeObjectURL(url);
}

export function Editor({ projectId }: { projectId: string }) {
  const editor = useEditor(projectId);
  const { project, state, transcript, dispatch, previewClip, initialize, undo, redo, saveTranscript, saving, lastSavedAt, error, setError, canUndo, canRedo } = editor;
  const videoRef = useRef<HTMLVideoElement>(null);
  const nextVideoRef = useRef<HTMLVideoElement>(null);
  const transitionStarted = useRef(false);
  const initialSeekDone = useRef(false);
  const gapFrame = useRef<number | null>(null);
  const [selectedClipId, setSelectedClipId] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [secondaryOpacity, setSecondaryOpacity] = useState(0);
  const [blackOpacity, setBlackOpacity] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [tab, setTab] = useState<"transcript" | "text" | "silence" | "activity">("transcript");
  const [webmcpStatus, setWebmcpStatus] = useState("Unavailable");
  const [exportStatus, setExportStatus] = useState("");
  const [frame, setFrame] = useState<string | null>(null);
  const [waveform, setWaveform] = useState<number[]>([]);
  const [timelineHeight, setTimelineHeight] = useState(180);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [optionHeld, setOptionHeld] = useState(false);
  const [lowerHeight, setLowerHeight] = useState(210);

  const startResize = (kind: "preview" | "timeline", event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startTimeline = timelineHeight;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    const startLower = lowerHeight;
    const move = (pointer: PointerEvent) => {
      if (kind === "preview") {
        const maximum = Math.max(180, window.innerHeight - startLower - 58 - (error ? 34 : 0) - 160);
        setTimelineHeight(Math.max(180, Math.min(maximum, startTimeline + startY - pointer.clientY)));
      } else {
        const total = startTimeline + startLower;
        const nextTimeline = Math.max(180, Math.min(total - 120, startTimeline + pointer.clientY - startY));
        setTimelineHeight(nextTimeline);
        setLowerHeight(total - nextTimeline);
      }
    };
    const finish = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); document.body.style.cursor = ""; document.body.style.userSelect = ""; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${MEDIA_URL}/waveform`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId }), signal: controller.signal })
      .then(async (response) => { const result = await response.json() as { peaks?: number[] }; if (response.ok && result.peaks) setWaveform(result.peaks); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [projectId]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Alt") setOptionHeld(event.type === "keydown"); };
    const release = () => setOptionHeld(false);
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    window.addEventListener("blur", release);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("keyup", key); window.removeEventListener("blur", release); };
  }, []);

  const effectiveSnapEnabled = optionHeld ? !snapEnabled : snapEnabled;
  const totalMs = state ? timelineDuration(state) : 0;
  const selectedClip = state?.clips.find((clip) => clip.id === selectedClipId) ?? state?.clips[0];
  const activeClip = state?.clips[activeIndex];
  const nextClip = state?.clips[activeIndex + 1];

  useEffect(() => {
    if (state && !state.clips.some((clip) => clip.id === selectedClipId)) setSelectedClipId(state.clips[0]?.id ?? "");
    if (state && activeIndex >= state.clips.length) setActiveIndex(Math.max(0, state.clips.length - 1));
  }, [activeIndex, selectedClipId, state]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeClip) return;
    video.playbackRate = activeClip.speed;
    video.volume = activeClip.muted ? 0 : Math.min(1, activeClip.volume);
  }, [activeClip]);

  const stopGapPlayback = useCallback(() => {
    if (gapFrame.current !== null) cancelAnimationFrame(gapFrame.current);
    gapFrame.current = null;
  }, []);

  const seekTimeline = useCallback((targetMs: number) => {
    if (!state || !videoRef.current) return;
    stopGapPlayback();
    const clamped = Math.max(0, Math.min(totalMs, targetMs));
    const all = timelineClips(state);
    const index = all.findIndex((entry) => clamped >= entry.startMs && clamped < entry.endMs);
    setPlayheadMs(clamped);
    if (index < 0) {
      setActiveIndex(-1);
      videoRef.current.pause();
      setSecondaryOpacity(0); setBlackOpacity(1);
      return;
    }
    const entry = all[index];
    const sourceMs = entry.clip.sourceInMs + (clamped - entry.startMs) * entry.clip.speed;
    setActiveIndex(index);
    videoRef.current.currentTime = Math.min(entry.clip.sourceOutMs - 1, sourceMs) / 1000;
    videoRef.current.playbackRate = entry.clip.speed;
    transitionStarted.current = false;
    setSecondaryOpacity(0); setBlackOpacity(0);
  }, [state, stopGapPlayback, totalMs]);

  const ensureInitialSeek = useCallback(() => {
    if (initialSeekDone.current || !state || !videoRef.current || videoRef.current.readyState < 1) return;
    initialSeekDone.current = true;
    seekTimeline(0);
  }, [seekTimeline, state]);
  useEffect(() => ensureInitialSeek(), [ensureInitialSeek]);

  const startGapPlayback = useCallback((startMs: number) => {
    if (!state || !videoRef.current) return;
    stopGapPlayback();
    const clips = timelineClips(state);
    const nextIndex = clips.findIndex((entry) => entry.startMs >= startMs);
    const endMs = nextIndex < 0 ? totalMs : clips[nextIndex].startMs;
    const startedAt = performance.now();
    setIsPlaying(true);
    setBlackOpacity(1);
    const tick = (now: number) => {
      const current = Math.min(endMs, startMs + now - startedAt);
      setPlayheadMs(current);
      if (current < endMs) { gapFrame.current = requestAnimationFrame(tick); return; }
      gapFrame.current = null;
      if (nextIndex < 0) { setIsPlaying(false); return; }
      const entry = clips[nextIndex];
      setActiveIndex(nextIndex);
      setBlackOpacity(0);
      videoRef.current!.currentTime = entry.clip.sourceInMs / 1000;
      videoRef.current!.playbackRate = entry.clip.speed;
      void videoRef.current!.play();
    };
    gapFrame.current = requestAnimationFrame(tick);
  }, [state, stopGapPlayback, totalMs]);

  const updatePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video || !state || !activeClip) return;
    const entry = timelineClips(state)[activeIndex];
    const sourceMs = video.currentTime * 1000;
    const currentTimelineMs = entry.startMs + (sourceMs - activeClip.sourceInMs) / activeClip.speed;
    setPlayheadMs(Math.max(0, Math.min(currentTimelineMs, totalMs)));

    const remainingMs = (activeClip.sourceOutMs - sourceMs) / activeClip.speed;
    const transitionMs = activeClip.transition.durationMs;
    if (nextClip && activeClip.transition.type !== "cut" && transitionMs > 0 && remainingMs <= transitionMs) {
      const progress = Math.max(0, Math.min(1, 1 - remainingMs / transitionMs));
      if (activeClip.transition.type === "crossfade") {
        const secondary = nextVideoRef.current;
        if (secondary && !transitionStarted.current) {
          secondary.currentTime = nextClip.sourceInMs / 1000;
          secondary.playbackRate = nextClip.speed;
          secondary.volume = nextClip.muted ? 0 : Math.min(1, nextClip.volume);
          transitionStarted.current = true;
          if (!video.paused) void secondary.play();
        }
        setSecondaryOpacity(progress);
        video.volume = (activeClip.muted ? 0 : Math.min(1, activeClip.volume)) * (1 - progress);
        if (secondary) secondary.volume = (nextClip.muted ? 0 : Math.min(1, nextClip.volume)) * progress;
      } else {
        setBlackOpacity(1 - Math.abs(progress * 2 - 1));
      }
    }

    const clipElapsedMs = (sourceMs - activeClip.sourceInMs) / activeClip.speed;
    const durationMs = clipDuration(activeClip);
    const edgeFade = Math.max(
      activeClip.fadeInMs ? 1 - clipElapsedMs / activeClip.fadeInMs : 0,
      activeClip.fadeOutMs ? 1 - (durationMs - clipElapsedMs) / activeClip.fadeOutMs : 0,
    );
    if (edgeFade > 0) setBlackOpacity((current) => Math.max(current, Math.min(1, edgeFade)));

    if (sourceMs >= activeClip.sourceOutMs - 15) {
      if (!nextClip) { video.pause(); setPlayheadMs(totalMs); return; }
      const nextEntry = timelineClips(state)[activeIndex + 1];
      if (nextEntry.startMs > entry.endMs + 1) { video.pause(); startGapPlayback(entry.endMs); return; }
      const overlapMs = activeClip.transition.type === "cut" ? 0 : activeClip.transition.durationMs;
      setActiveIndex(activeIndex + 1);
      video.currentTime = (nextClip.sourceInMs + overlapMs * nextClip.speed) / 1000;
      video.playbackRate = nextClip.speed;
      video.volume = nextClip.muted ? 0 : Math.min(1, nextClip.volume);
      transitionStarted.current = false;
      nextVideoRef.current?.pause();
      setSecondaryOpacity(0); setBlackOpacity(0);
      if (!video.paused) void video.play();
    }
  }, [activeClip, activeIndex, nextClip, startGapPlayback, state, totalMs]);

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (gapFrame.current !== null || activeIndex < 0 && isPlaying) { stopGapPlayback(); setIsPlaying(false); return; }
    if (activeIndex < 0) { startGapPlayback(playheadMs); return; }
    if (video.paused) {
      if (playheadMs >= totalMs - 10) { seekTimeline(0); void video.play(); return; }
      void video.play();
    } else {
      video.pause(); nextVideoRef.current?.pause();
    }
  }, [activeIndex, isPlaying, playheadMs, seekTimeline, startGapPlayback, stopGapPlayback, totalMs]);

  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const input = target instanceof HTMLInputElement ? target : null;
      const textField = !!target?.closest("textarea, [contenteditable='true']") || !!input && ["text", "search", "password", "email", "url", "tel"].includes(input.type);
      const textEditing = textField || input?.type === "number";
      const blur = () => (document.activeElement as HTMLElement | null)?.blur();
      if (event.code === "Space" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (textField) return;
        event.preventDefault(); blur();
        if (!event.repeat) togglePlayback();
        return;
      }
      if ((event.key === "Backspace" || event.key === "Delete") && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (textEditing) return;
        event.preventDefault(); blur();
        if (!event.repeat && selectedClip) {
          try { dispatch({ type: "delete_clip", actor: "human", clipId: selectedClip.id, ripple: event.key === "Delete" }); }
          catch (cause) { setError(cause instanceof Error ? cause.message : "Could not delete clip"); }
        }
        return;
      }
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier || textField) return;
      if (event.key.toLowerCase() === "z") {
        event.preventDefault(); blur();
        if (!event.repeat) { if (event.shiftKey) redo(); else undo(); }
      } else if (event.key.toLowerCase() === "y") {
        event.preventDefault(); blur();
        if (!event.repeat) redo();
      }
    };
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, [dispatch, redo, selectedClip, setError, togglePlayback, undo]);

  const splitAtPlayhead = () => {
    if (!state) return;
    const point = timelineToSource(state, playheadMs);
    if (!point) return;
    try { dispatch({ type: "split_clip", actor: "human", clipId: point.clipId, sourceMs: Math.round(point.sourceMs) }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not split clip"); }
  };

  const inspectFrame = useCallback((targetMs?: number) => {
    if (targetMs !== undefined) seekTimeline(targetMs);
    const video = videoRef.current;
    if (!video?.videoWidth) throw new Error("Frame is not ready");
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 960 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", 0.82);
    setFrame(data);
    return { timelineMs: targetMs ?? playheadMs, image: data };
  }, [playheadMs, seekTimeline]);

  const exportMp4 = useCallback(async () => {
    const current = editor.stateRef.current;
    if (!current) throw new Error("Project is not ready");
    setExportStatus("Starting export…");
    const response = await fetch(`${MEDIA_URL}/exports`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: current }) });
    const job = await response.json() as { id?: string; error?: string };
    if (!response.ok || !job.id) throw new Error(job.error || "Could not start export");
    for (let attempt = 0; attempt < 900; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const status = await fetch(`${MEDIA_URL}/jobs/${job.id}`).then((result) => result.json()) as { status: string; output?: string; error?: string };
      setExportStatus(status.status === "running" ? "Rendering MP4…" : status.status);
      if (status.status === "failed") throw new Error(status.error || "Export failed");
      if (status.status === "complete") {
        const downloadUrl = `${MEDIA_URL}/jobs/${job.id}/output`;
        setExportStatus("Export complete");
        const anchor = document.createElement("a");
        anchor.href = downloadUrl; anchor.download = "rough-cut.mp4"; anchor.click();
        return { jobId: job.id, downloadUrl };
      }
    }
    throw new Error("Export timed out");
  }, [editor.stateRef]);

  const exportEdlFile = useCallback(() => {
    const current = editor.stateRef.current;
    if (!current) throw new Error("Project is not ready");
    const text = exportEdl(current);
    downloadText(`${current.name}.edl`, text);
    return text;
  }, [editor.stateRef]);

  const detectSilences = useCallback(async (thresholdDb = -35, minimumMs = 500) => {
    const response = await fetch(`${MEDIA_URL}/silences`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, thresholdDb, minimumMs }) });
    const result = await response.json() as { ranges?: Array<{ startMs: number; endMs: number }>; error?: string };
    if (!response.ok || !result.ranges) throw new Error(result.error || "Silence detection failed");
    return result.ranges;
  }, [projectId]);

  const transcribeVideo = useCallback(async (actor: "human" | "agent" = "human", provider: "cloudflare" | "openai" = "cloudflare", apiKey = "", onProgress?: (message: string) => void, expectedVersion?: number) => {
    onProgress?.("Extracting audio…");
    const prepResponse = await fetch(`${MEDIA_URL}/transcription/prepare`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId }) });
    const prep = await prepResponse.json() as { chunks?: Array<{ index: number; offsetMs: number; url: string }>; error?: string };
    if (!prepResponse.ok || !prep.chunks) throw new Error(prep.error || "Audio extraction failed");
    const words: TranscriptWord[] = [];
    for (let index = 0; index < prep.chunks.length; index++) {
      const chunk = prep.chunks[index];
      onProgress?.(`Transcribing ${index + 1}/${prep.chunks.length}…`);
      const audio = await fetch(`${MEDIA_URL}${chunk.url}`).then((response) => response.blob());
      const form = new FormData(); form.set("audio", audio, `chunk-${index}.mp3`); form.set("provider", provider);
      const response = await fetch("/api/transcribe", { method: "POST", headers: provider === "openai" ? { "x-openai-key": apiKey } : undefined, body: form });
      const result = await response.json() as { words?: TranscriptWord[]; error?: string };
      if (!response.ok || !result.words) throw new Error(result.error || "Transcription failed");
      words.push(...result.words.map((word) => ({ ...word, id: crypto.randomUUID(), startMs: word.startMs + chunk.offsetMs, endMs: word.endMs + chunk.offsetMs })));
    }
    const currentVersion = editor.stateRef.current?.version;
    if (expectedVersion !== undefined && currentVersion !== expectedVersion) throw new Error(`STALE_VERSION:${currentVersion ?? 0}`);
    return saveTranscript(words, actor);
  }, [editor.stateRef, projectId, saveTranscript]);

  useWebMCP({
    stateRef: editor.stateRef, transcriptRef: editor.transcriptRef, dispatch, undo, redo,
    seekTimeline, inspectFrame, detectSilences, transcribeVideo: (actor, expectedVersion) => transcribeVideo(actor, "cloudflare", "", undefined, expectedVersion), exportMp4, exportEdl: exportEdlFile,
    setStatus: setWebmcpStatus,
  });

  if (!project) return <main className="grid min-h-dvh place-content-center justify-items-center gap-[15px] text-[var(--muted)]"><div className="size-[30px] animate-spin rounded-full border-[3px] border-[#2f333a] border-t-[var(--lime)] motion-reduce:animate-none" /><p>{error || "Loading project…"}</p></main>;

  return (
    <main className="grid h-dvh min-h-0 grid-rows-[58px_auto_minmax(0,1fr)_var(--timeline-height)_var(--lower-height)] overflow-hidden bg-[var(--bg)] max-[900px]:h-auto max-[900px]:min-h-dvh max-[900px]:grid-rows-[auto_auto_auto_180px_290px] max-[900px]:overflow-visible" style={{ "--timeline-height": `${timelineHeight}px`, "--lower-height": `${lowerHeight}px` } as React.CSSProperties}>
      <header className="row-start-1 grid grid-cols-[220px_1fr_auto] items-center gap-5 border-b border-[var(--line)] bg-[#0d0f12] px-[18px] max-[900px]:min-h-[58px] max-[900px]:grid-cols-[auto_1fr] max-[900px]:p-2.5">
        <Link href="/" className="inline-flex items-center gap-[.22em] text-[17px] font-black tracking-[-.07em] text-white no-underline"><span>ROUGH</span><i className="not-italic text-[var(--orange)]">{"//"}</i><span>CUT</span></Link>
        <div className="flex min-w-0 items-baseline gap-2.5"><strong className="overflow-hidden text-[13px] text-ellipsis whitespace-nowrap">{state?.name ?? project.name}</strong><span className="text-[10px] text-[var(--muted)] max-[900px]:hidden"><SaveStatus saving={saving} savedAt={lastSavedAt} ready={!!state} /></span></div>
        <div className="flex items-center gap-2.25 max-[900px]:col-span-full max-[900px]:flex-wrap">
          <span className="inline-flex items-center gap-1.75 rounded-full border border-[#323740] px-2.5 py-1.5 text-[11px] tracking-[.08em] text-[var(--muted)] uppercase"><b className={`size-1.75 rounded-full ${webmcpStatus === "Ready" ? "bg-[var(--lime)] shadow-[0_0_8px_var(--lime)]" : "bg-[#666]"}`} /> WebMCP {webmcpStatus}</span>
          <button className="cursor-pointer rounded-[7px] border border-[var(--line)] bg-transparent px-3 py-1.75" onClick={() => state && downloadText(`${state.name}.edl`, exportEdl(state))}>EDL</button>
          <button className="cursor-pointer rounded-[7px] border-0 bg-[var(--lime)] px-[13px] py-2 text-xs font-extrabold text-[#10120d] shadow-[0_8px_30px_#d9ff6324] hover:bg-[#e5ff93]" disabled={!state || !!exportStatus && exportStatus !== "Export complete"} onClick={() => void exportMp4().catch((cause) => { setError(cause.message); setExportStatus(""); })}>{exportStatus || "Export MP4"}</button>
        </div>
      </header>

      {error && <div className="row-start-2 flex justify-between border-b border-[#7c3024] bg-[#401c17] px-[18px] py-2 text-xs text-[#ff9781]" role="alert">{error}<button className="cursor-pointer border-0 bg-transparent" aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}

      <section className="row-start-3 grid min-h-0 grid-cols-[minmax(0,1fr)_280px] max-[900px]:grid-cols-1">
        <div className="flex min-h-0 min-w-0 flex-col items-center justify-center overflow-hidden bg-[radial-gradient(circle,_#1b1e24_0,_#0e1013_70%)] p-3 max-[900px]:overflow-visible max-[900px]:p-2.5">
          <div className="preview-stage relative aspect-video h-[min(calc(100%_-_42px),506px)] w-auto max-w-full flex-none overflow-hidden rounded-[5px] bg-black shadow-[0_20px_60px_#0009] max-[900px]:h-auto max-[900px]:w-full">
            <video
              ref={videoRef} src={`/api/projects/${projectId}/media`} playsInline preload="metadata" aria-label="Video preview" className="block size-full object-contain"
              style={{ filter: cssFilter(activeClip), transform: cssTransform(activeClip) }}
              onLoadedMetadata={(event) => { initialize(event.currentTarget.duration * 1000); requestAnimationFrame(ensureInitialSeek); }}
              onTimeUpdate={updatePlayback}
              onPlay={() => { setIsPlaying(true); if (transitionStarted.current) void nextVideoRef.current?.play(); }}
              onPause={() => { if (gapFrame.current === null) setIsPlaying(false); nextVideoRef.current?.pause(); }}
            />
            <video ref={nextVideoRef} src={`/api/projects/${projectId}/media`} playsInline preload="metadata" muted={false} aria-hidden="true" className="pointer-events-none absolute inset-0 block size-full object-contain" style={{ opacity: secondaryOpacity, filter: cssFilter(nextClip), transform: cssTransform(nextClip) }} />
            <div className="pointer-events-none absolute inset-0 bg-black" style={{ opacity: blackOpacity }} />
            {state?.overlays.filter((item) => playheadMs >= item.startMs && playheadMs <= item.endMs).map((item) => <div key={item.id} className={`absolute left-1/2 z-4 max-w-[88%] -translate-x-1/2 rounded-[5px] bg-[#000b] px-3.5 py-2 text-center text-[clamp(18px,3vw,42px)] font-extrabold text-shadow-[0_2px_3px_#000] ${item.position === "top" ? "top-[8%]" : item.position === "bottom" ? "bottom-[8%]" : "top-1/2 -translate-y-1/2"}`}>{item.text}</div>)}
            {state?.captions.filter((item) => playheadMs >= item.startMs && playheadMs <= item.endMs).map((item) => <div key={item.id} className="absolute bottom-[7%] left-1/2 z-4 max-w-[88%] -translate-x-1/2 rounded-[5px] bg-[#000b] px-3.5 py-2 text-center text-[clamp(16px,2.3vw,30px)] font-extrabold text-shadow-[0_2px_3px_#000]">{item.text}</div>)}
            <button className="absolute top-2.5 right-2.5 z-5 cursor-pointer rounded-md border border-[#ffffff38] bg-[#080808aa] px-2.25 py-1.5" aria-label="Capture current frame" onClick={() => { try { inspectFrame(); } catch (cause) { setError((cause as Error).message); } }} title="Capture current frame">▣</button>
          </div>
          <div className="flex w-[min(100%,900px)] items-center gap-2 pt-3">
            <button className="cursor-pointer rounded-[5px] border border-[var(--line)] bg-[var(--panel-2)] px-2.25 py-1.5 text-[11px]" aria-label="Seek backward 5 seconds" onClick={() => seekTimeline(Math.max(0, playheadMs - 5000))}>−5s</button>
            <button className="w-[34px] cursor-pointer rounded-[5px] border border-[var(--line)] bg-[#e8e9ea] px-2.25 py-1.5 text-[11px] text-[#111]" aria-label={isPlaying ? "Pause" : "Play"} aria-pressed={isPlaying} onClick={togglePlayback}>{isPlaying ? "Ⅱ" : "▶"}</button>
            <button className="cursor-pointer rounded-[5px] border border-[var(--line)] bg-[var(--panel-2)] px-2.25 py-1.5 text-[11px]" aria-label="Seek forward 5 seconds" onClick={() => seekTimeline(Math.min(totalMs, playheadMs + 5000))}>+5s</button>
            <code className="min-w-[115px] text-[11px] text-[#d7d9dd]">{formatTime(playheadMs)} <span className="text-[#686e78]">/ {formatTime(totalMs)}</span></code>
            <input className="min-w-0 flex-1 accent-[var(--lime)]" aria-label="Playhead" type="range" min={0} max={Math.max(1, totalMs)} value={playheadMs} onChange={(event) => seekTimeline(Number(event.target.value))} />
          </div>
        </div>

        <aside className="min-h-0 overflow-auto border-l border-[var(--line)] bg-[var(--panel)] max-[900px]:max-h-[330px] max-[900px]:border-t max-[900px]:border-l-0" aria-label="Clip inspector">
          <div className="sticky top-0 z-2 flex justify-between border-b border-[var(--line)] bg-[#14161b] px-[13px] py-[11px] text-[10px] tracking-[.14em] text-[#c7cad0] uppercase"><span>Inspector</span>{selectedClip && <code className="text-[var(--muted)]">{formatTime(clipDuration(selectedClip))}</code>}</div>
          {state && selectedClip ? <ClipInspector state={state} clip={selectedClip} dispatch={dispatch} previewClip={previewClip} setError={setError} /> : <p className="p-8 text-center text-xs text-[var(--muted)]">Select a clip to adjust it.</p>}
        </aside>
      </section>

      <section className="relative row-start-4 grid min-h-0 min-w-0 grid-rows-[39px_minmax(0,1fr)] overflow-hidden border-y border-[var(--line)] bg-[#0e1014]">
        <button type="button" aria-label="Resize preview and timeline" title="Drag to resize preview and timeline" className="group absolute top-0 left-0 z-20 hidden h-2 w-full touch-none cursor-row-resize border-0 bg-transparent p-0 min-[901px]:block" onPointerDown={(event) => startResize("preview", event)}><span className="absolute top-0 left-1/2 h-px w-12 -translate-x-1/2 bg-[#3a4049] transition-colors group-hover:bg-[var(--lime)]" /></button>
        <div className="flex h-[39px] items-center justify-between border-b border-[var(--line)] px-3">
          <div className="flex items-center gap-1.5">
            <button aria-label={isPlaying ? "Pause" : "Play"} aria-pressed={isPlaying} title={isPlaying ? "Pause" : "Play"} className="inline-flex w-8 cursor-pointer justify-center rounded-[5px] border border-[var(--line)] bg-[var(--panel-2)] px-2.25 py-1.5 text-[11px]" onClick={togglePlayback}>{isPlaying ? "Ⅱ" : "▶"}</button>
            <button className="cursor-pointer rounded-[5px] border border-[var(--line)] bg-[var(--panel-2)] px-2.25 py-1.5 text-[11px]" onClick={splitAtPlayhead}>⌁ Split</button>
            <button className="cursor-pointer rounded-[5px] border border-[var(--line)] bg-[var(--panel-2)] px-2.25 py-1.5 text-[11px]" disabled={!selectedClip} title="Delete selected clip and leave its gap (Backspace)" onClick={() => selectedClip && dispatch({ type: "delete_clip", actor: "human", clipId: selectedClip.id })}>⌫ Delete</button>
            <button aria-pressed={effectiveSnapEnabled} title="Toggle timeline snapping (hold Option/Alt to temporarily invert)" className={`inline-flex cursor-pointer items-center gap-1.5 rounded-[5px] border border-[var(--line)] bg-[var(--panel-2)] px-2.25 py-1.5 text-[11px] ${effectiveSnapEnabled ? "!border-[var(--lime)] !text-[var(--lime)]" : ""}`} onClick={() => setSnapEnabled((enabled) => !enabled)}><Magnet className="size-3" aria-hidden="true" /> Snap</button>
          </div>
          <div className="flex items-center gap-1.5">
            <button className="cursor-pointer rounded-[5px] border border-[var(--line)] bg-[var(--panel-2)] px-2.25 py-1.5 text-[11px]" disabled={!canUndo} aria-label="Undo last edit" onClick={() => undo()}>↶ Undo</button>
            <button className="cursor-pointer rounded-[5px] border border-[var(--line)] bg-[var(--panel-2)] px-2.25 py-1.5 text-[11px]" disabled={!canRedo} aria-label="Redo last edit" onClick={() => redo()}>↷ Redo</button>
            <span className="ml-2 text-[10px] text-[var(--muted)]">{state?.clips.length ?? 0} clips · {formatTime(totalMs)}</span>
          </div>
        </div>
        {state && <Timeline state={state} waveform={waveform} snapEnabled={snapEnabled} isPlaying={isPlaying} playheadMs={playheadMs} selectedClipId={selectedClip?.id ?? ""} onSelect={setSelectedClipId} onSeek={seekTimeline} dispatch={dispatch} setError={setError} />}
      </section>

      <section className="relative row-start-5 grid min-h-0 grid-rows-[36px_1fr] overflow-hidden bg-[var(--panel)]">
        <button type="button" aria-label="Resize timeline and transcript" title="Drag to resize timeline and transcript" className="group absolute top-0 left-0 z-20 hidden h-2 w-full touch-none cursor-row-resize border-0 bg-transparent p-0 min-[901px]:block" onPointerDown={(event) => startResize("timeline", event)}><span className="absolute top-0 left-1/2 h-px w-12 -translate-x-1/2 bg-[#3a4049] transition-colors group-hover:bg-[var(--lime)]" /></button>
        <div className="flex gap-[18px] border-b border-[var(--line)] px-3" role="tablist" aria-label="Editor panels">
          {(["transcript", "text", "silence", "activity"] as const).map((name) => <button key={name} role="tab" aria-selected={tab === name} className={`cursor-pointer border-0 border-b-2 bg-transparent text-[9px] tracking-[.12em] uppercase ${tab === name ? "border-[var(--lime)] text-white" : "border-transparent text-[#777e89]"}`} onClick={() => setTab(name)}>{name}</button>)}
        </div>
        <div className="min-h-0 overflow-auto" role="tabpanel">
          {tab === "transcript" && state && <TranscriptPanel state={state} transcript={transcript} playheadMs={playheadMs} dispatch={dispatch} transcribeVideo={transcribeVideo} seekTimeline={seekTimeline} setError={setError} />}
          {tab === "text" && state && <TextPanel state={state} playheadMs={playheadMs} dispatch={dispatch} />}
          {tab === "silence" && state && <SilencePanel transcript={transcript} detect={detectSilences} dispatch={dispatch} setError={setError} />}
          {tab === "activity" && state && <ActivityPanel state={state} />}
        </div>
      </section>

      {frame && <div className="fixed inset-0 z-30 grid place-items-center bg-[#000d] p-5" role="dialog" aria-modal="true" aria-label="Captured frame" onClick={() => setFrame(null)}><div className="relative max-w-[960px] rounded-lg border border-[#444] bg-[#111] p-2" onClick={(event) => event.stopPropagation()}><button className="absolute top-3 right-3 size-[30px] cursor-pointer rounded-full border-0 bg-[#000c]" aria-label="Close captured frame" onClick={() => setFrame(null)}>×</button><img className="block max-w-full" src={frame} alt={`Captured frame at ${formatTime(playheadMs)}`} /><p className="mx-1 mt-2 mb-0.5 font-mono text-[10px] text-[var(--muted)]">Frame at {formatTime(playheadMs)}</p></div></div>}
    </main>
  );
}

function SaveStatus({ saving, savedAt, ready }: { saving: boolean; savedAt: number | null; ready: boolean }) {
  const [now, setNow] = useState(savedAt ?? 0);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 10_000); return () => window.clearInterval(timer); }, []);
  if (saving) return <span>Saving…</span>;
  if (!ready || !savedAt) return <span>Preparing timeline</span>;
  const seconds = Math.max(0, Math.floor((now - savedAt) / 1000));
  const elapsed = seconds < 5 ? "just now" : seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`;
  return <span>Saved · {elapsed}</span>;
}

function RangeControl({ label, value, resetValue, min, max, step, suffix = "", onPreview, onCommit }: { label: string; value: number; resetValue: number; min: number; max: number; step: number; suffix?: string; onPreview?(value: number): void; onCommit(value: number): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const reset = () => { const next = Math.max(min, Math.min(max, resetValue)); setDraft(next); onPreview?.(next); onCommit(next); };
  return <label className="my-2.5 block"><span className="flex items-center justify-between text-[10px] leading-none text-[#a6abb4]">{label}<span className="flex h-4 items-center gap-1"><output className="inline-flex h-4 items-center font-mono leading-none text-[#f3f3f4]">{draft}{suffix}</output><button type="button" className="inline-flex size-4 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-[#858b96] hover:text-(--lime) focus-visible:text-(--lime)" title={`Reset ${label}`} aria-label={`Reset ${label}`} onClick={(event) => { event.preventDefault(); reset(); }}><RotateCcw className="size-2.5 -translate-y-[0.5px] shrink-0" strokeWidth={2} aria-hidden="true" /></button></span></span><input className="h-0.75 w-full accent-(--lime)" type="range" min={min} max={max} step={step} value={draft} onChange={(event) => { const next = Number(event.target.value); setDraft(next); onPreview?.(next); }} onPointerUp={() => onCommit(draft)} onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) onCommit(draft); }} /></label>;
}

function ClipInspector({ state, clip, dispatch, previewClip, setError }: { state: ProjectState; clip: Clip; dispatch(command: CommandInput): ProjectState; previewClip(clipId: string, patch: Partial<Clip>): void; setError(message: string): void }) {
  const [scaleLocked, setScaleLocked] = useState(true);
  const preview = (patch: Partial<Clip>) => previewClip(clip.id, patch);
  const adjust = (patch: Partial<Clip>) => { try { dispatch({ type: "adjust_clip", actor: "human", clipId: clip.id, patch }); } catch (cause) { setError((cause as Error).message); } };
  const scalePatch = (axis: "scaleX" | "scaleY", value: number) => scaleLocked ? { scaleX: value, scaleY: value } : { [axis]: value };
  const next = state.clips[state.clips.findIndex((item) => item.id === clip.id) + 1];
  const trim = (sourceInMs: number, sourceOutMs: number) => { try { dispatch({ type: "trim_clip", actor: "human", clipId: clip.id, sourceInMs, sourceOutMs }); } catch (cause) { setError((cause as Error).message); } };
  return <div className="px-3.5 pt-3 pb-[30px]">
    <div className="grid grid-cols-2 gap-1.75">
      <label className="text-[9px] text-[var(--muted)] uppercase">In<input className="mt-1 w-full rounded-[5px] border border-[var(--line)] bg-[#0c0e11] p-1.5 text-white" key={`${clip.id}-in-${clip.sourceInMs}`} type="number" min={0} max={clip.sourceOutMs - 50} defaultValue={Math.round(clip.sourceInMs)} onBlur={(event) => { const value = Number(event.target.value); if (value < clip.sourceOutMs && value !== clip.sourceInMs) trim(value, clip.sourceOutMs); }} /></label>
      <label className="text-[9px] text-[var(--muted)] uppercase">Out<input className="mt-1 w-full rounded-[5px] border border-[var(--line)] bg-[#0c0e11] p-1.5 text-white" key={`${clip.id}-out-${clip.sourceOutMs}`} type="number" min={clip.sourceInMs + 50} max={state.durationMs} defaultValue={Math.round(clip.sourceOutMs)} onBlur={(event) => { const value = Number(event.target.value); if (value > clip.sourceInMs && value !== clip.sourceOutMs) trim(clip.sourceInMs, value); }} /></label>
    </div>
    <h3 className="mx-[-14px] mt-[18px] mb-2.5 border-b border-[#242830] px-3.5 pb-2 text-[9px] tracking-[.12em] text-[#7f8590] uppercase">Color</h3>
    <RangeControl label="Brightness" value={clip.brightness} resetValue={0} min={-1} max={1} step={0.05} onPreview={(brightness) => preview({ brightness })} onCommit={(brightness) => adjust({ brightness })} />
    <RangeControl label="Contrast" value={clip.contrast} resetValue={1} min={0} max={2} step={0.05} onPreview={(contrast) => preview({ contrast })} onCommit={(contrast) => adjust({ contrast })} />
    <RangeControl label="Saturation" value={clip.saturation} resetValue={1} min={0} max={3} step={0.05} onPreview={(saturation) => preview({ saturation })} onCommit={(saturation) => adjust({ saturation })} />
    <RangeControl label="Hue" value={clip.hue} resetValue={0} min={-180} max={180} step={1} suffix="°" onPreview={(hue) => preview({ hue })} onCommit={(hue) => adjust({ hue })} />
    <h3 className="mx-[-14px] mt-[18px] mb-2.5 border-b border-[#242830] px-3.5 pb-2 text-[9px] tracking-[.12em] text-[#7f8590] uppercase">Transform</h3>
    <div className="grid grid-cols-[1fr_18px_1fr] items-center gap-x-1.5">
      <RangeControl label="Zoom X" value={clip.scaleX} resetValue={1} min={0.25} max={4} step={0.05} suffix="×" onPreview={(scaleX) => preview(scalePatch("scaleX", scaleX))} onCommit={(scaleX) => adjust(scalePatch("scaleX", scaleX))} />
      <button type="button" className={`mt-4 grid size-[18px] cursor-pointer place-items-center rounded border bg-transparent p-0 ${scaleLocked ? "border-[var(--lime)] text-[var(--lime)]" : "border-[var(--line)] text-[var(--muted)]"}`} aria-label={scaleLocked ? "Unlock zoom aspect ratio" : "Lock zoom aspect ratio"} aria-pressed={scaleLocked} title={scaleLocked ? "Zoom X and Y linked" : "Zoom X and Y independent"} onClick={() => setScaleLocked((locked) => !locked)}>{scaleLocked ? <Link2 className="size-2.5" aria-hidden="true" /> : <Unlink2 className="size-2.5" aria-hidden="true" />}</button>
      <RangeControl label="Zoom Y" value={clip.scaleY} resetValue={1} min={0.25} max={4} step={0.05} suffix="×" onPreview={(scaleY) => preview(scalePatch("scaleY", scaleY))} onCommit={(scaleY) => adjust(scalePatch("scaleY", scaleY))} />
    </div>
    <div className="grid grid-cols-2 gap-x-3">
      <RangeControl label="Pan X" value={clip.positionX} resetValue={0} min={-100} max={100} step={1} suffix="%" onPreview={(positionX) => preview({ positionX })} onCommit={(positionX) => adjust({ positionX })} />
      <RangeControl label="Pan Y" value={clip.positionY} resetValue={0} min={-100} max={100} step={1} suffix="%" onPreview={(positionY) => preview({ positionY })} onCommit={(positionY) => adjust({ positionY })} />
    </div>
    <h3 className="mx-[-14px] mt-[18px] mb-2.5 border-b border-[#242830] px-3.5 pb-2 text-[9px] tracking-[.12em] text-[#7f8590] uppercase">Playback</h3>
    <RangeControl label="Volume" value={clip.volume} resetValue={1} min={0} max={2} step={0.05} onPreview={(volume) => preview({ volume })} onCommit={(volume) => adjust({ volume })} />
    <RangeControl label="Speed" value={clip.speed} resetValue={1} min={0.5} max={2} step={0.05} suffix="×" onPreview={(speed) => preview({ speed })} onCommit={(speed) => adjust({ speed })} />
    <label className="flex items-center gap-1.75 text-[11px] text-[#a6abb4]"><input type="checkbox" checked={clip.muted} onChange={(event) => adjust({ muted: event.target.checked })} /> Mute clip</label>
    <h3 className="mx-[-14px] mt-[18px] mb-2.5 border-b border-[#242830] px-3.5 pb-2 text-[9px] tracking-[.12em] text-[#7f8590] uppercase">Fades</h3>
    <RangeControl label="Fade in" value={clip.fadeInMs} resetValue={0} min={0} max={Math.min(3000, clipDuration(clip) / 2)} step={50} suffix="ms" onPreview={(fadeInMs) => preview({ fadeInMs })} onCommit={(fadeInMs) => adjust({ fadeInMs })} />
    <RangeControl label="Fade out" value={clip.fadeOutMs} resetValue={0} min={0} max={Math.min(3000, clipDuration(clip) / 2)} step={50} suffix="ms" onPreview={(fadeOutMs) => preview({ fadeOutMs })} onCommit={(fadeOutMs) => adjust({ fadeOutMs })} />
    <h3 className="mx-[-14px] mt-[18px] mb-2.5 border-b border-[#242830] px-3.5 pb-2 text-[9px] tracking-[.12em] text-[#7f8590] uppercase">Transition</h3>
    <select className="w-full rounded-[5px] border border-[var(--line)] bg-[#0e1014] p-1.75 text-[11px]" aria-label="Transition type" disabled={!next} value={clip.transition.type} onChange={(event) => dispatch({ type: "set_transition", actor: "human", clipId: clip.id, transition: { type: event.target.value as Clip["transition"]["type"], durationMs: event.target.value === "cut" ? 0 : Math.max(300, clip.transition.durationMs) } })}>
      <option value="cut">Hard cut</option><option value="crossfade">Crossfade</option><option value="fade-black">Fade through black</option>
    </select>
    {clip.transition.type !== "cut" && next && <RangeControl label="Duration" value={clip.transition.durationMs} resetValue={500} min={100} max={Math.min(3000, clipDuration(clip) / 2, clipDuration(next) / 2)} step={50} suffix="ms" onPreview={(durationMs) => preview({ transition: { ...clip.transition, durationMs } })} onCommit={(durationMs) => dispatch({ type: "set_transition", actor: "human", clipId: clip.id, transition: { ...clip.transition, durationMs } })} />}
  </div>;
}

function AudioWaveform({ peaks, clip, durationMs }: { peaks: number[]; clip: Clip; durationMs: number }) {
  if (peaks.length < 2 || durationMs <= 0) return null;
  const start = Math.floor((clip.sourceInMs / durationMs) * peaks.length);
  const end = Math.max(start + 2, Math.ceil((clip.sourceOutMs / durationMs) * peaks.length));
  const values = peaks.slice(start, end);
  if (values.length < 2) return null;
  const gain = clip.muted ? 0.08 : clip.volume;
  const amplitude = (peak: number) => Math.min(1, peak * gain) * 0.42;
  const top = values.map((peak, index) => `${index},${0.5 - amplitude(peak)}`).join(" L");
  const bottom = values.map((peak, index) => `${values.length - index - 1},${0.5 + amplitude(values[values.length - index - 1])}`).join(" L");
  return <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${values.length - 1} 1`} preserveAspectRatio="none" aria-hidden="true"><path d={`M${top} L${bottom} Z`} fill={clip.muted ? "#829b9620" : "#57b7a43d"} /></svg>;
}

function formatTimelineTime(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((part) => String(part).padStart(2, "0")).join(":");
}

type TimelineProps = { state: ProjectState; waveform: number[]; snapEnabled: boolean; isPlaying: boolean; playheadMs: number; selectedClipId: string; onSelect(id: string): void; onSeek(ms: number): void; dispatch(command: CommandInput): ProjectState; setError(message: string): void };
function Timeline({ state, waveform, snapEnabled, isPlaying, playheadMs, selectedClipId, onSelect, onSeek, dispatch, setError }: TimelineProps) {
  const [moving, setMoving] = useState<{ clipId: string; startMs: number } | null>(null);
  const [trimming, setTrimming] = useState<{ clipId: string; startMs: number; durationMs: number; sourceInMs: number; sourceOutMs: number } | null>(null);
  const [trackWidth, setTrackWidth] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const entries = timelineClips(state);
  const total = timelineDuration(state);
  const naturalWidth = total / 1000 * 14;
  const width = Math.max(viewportWidth, naturalWidth * zoom);
  const majorSeconds = ([1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600] as const).find((seconds) => seconds * 1000 / total * width >= 72) ?? 600;
  const majorMs = majorSeconds * 1000;
  const minorWidth = majorMs / 4 / total * width;
  const rulerMarks = Array.from({ length: Math.floor(total / majorMs) + 1 }, (_, index) => index * majorMs);
  useEffect(() => {
    const track = trackRef.current;
    const viewport = scrollRef.current;
    if (!track || !viewport) return;
    const observer = new ResizeObserver(() => { setTrackWidth(track.clientWidth); setViewportWidth(Math.max(1, viewport.clientWidth - 20)); });
    observer.observe(track);
    observer.observe(viewport);
    setTrackWidth(track.clientWidth);
    setViewportWidth(Math.max(1, viewport.clientWidth - 20));
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const zoomTimeline = (event: WheelEvent) => {
      if (!event.altKey || naturalWidth <= 0) return;
      event.preventDefault();
      const rect = container.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const timelineRatio = (container.scrollLeft + pointerX) / Math.max(1, trackWidth);
      const availableWidth = Math.max(1, container.clientWidth - 20);
      const minimum = Math.min(1, availableWidth / naturalWidth);
      const next = Math.max(minimum, Math.min(12, zoom * Math.exp(-event.deltaY * 0.003)));
      const nextWidth = Math.max(availableWidth, naturalWidth * next);
      setZoom(next);
      requestAnimationFrame(() => { container.scrollLeft = Math.max(0, timelineRatio * nextWidth - pointerX); });
    };
    container.addEventListener("wheel", zoomTimeline, { passive: false });
    return () => container.removeEventListener("wheel", zoomTimeline);
  }, [naturalWidth, trackWidth, zoom]);
  useEffect(() => {
    const container = scrollRef.current;
    if (!isPlaying || !container || !trackWidth || !total) return;
    const playheadX = playheadMs / total * trackWidth;
    const left = container.scrollLeft;
    const right = left + container.clientWidth - 20;
    if (playheadX < left || playheadX > right) container.scrollLeft = Math.max(0, playheadX - 10);
  }, [isPlaying, playheadMs, total, trackWidth]);
  const seekAt = (clientX: number, element: HTMLElement) => {
    const rect = element.closest(".timeline-track")!.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(total, ((clientX - rect.left) / rect.width) * total)));
  };
  const trackDrag = (event: React.PointerEvent, update: (point: { clientX: number; altKey: boolean }) => void, finish: (point: { clientX: number; altKey: boolean }) => void) => {
    const originX = event.clientX;
    let point = { clientX: event.clientX, altKey: event.altKey };
    let dragging = false;
    let frame = 0;
    const move = (pointer: PointerEvent) => { point = { clientX: pointer.clientX, altKey: pointer.altKey }; dragging ||= Math.abs(pointer.clientX - originX) > 2; update(point); };
    const scroll = () => {
      const container = scrollRef.current;
      if (container && dragging) {
        const rect = container.getBoundingClientRect();
        const edge = 56;
        const speed = point.clientX < rect.left + edge
          ? -20 * Math.min(1, (rect.left + edge - point.clientX) / edge)
          : point.clientX > rect.right - edge
            ? 20 * Math.min(1, (point.clientX - rect.right + edge) / edge)
            : 0;
        if (speed) {
          const before = container.scrollLeft;
          container.scrollLeft += speed;
          if (container.scrollLeft !== before) update(point);
        }
      }
      frame = requestAnimationFrame(scroll);
    };
    const up = (pointer: PointerEvent) => {
      point = { clientX: pointer.clientX, altKey: pointer.altKey };
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      cancelAnimationFrame(frame);
      finish(point);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    frame = requestAnimationFrame(scroll);
  };
  const moveClip = (event: React.PointerEvent<HTMLElement>, clip: Clip) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("[data-trim-handle]")) return;
    event.preventDefault();
    const startX = event.clientX;
    const startScroll = scrollRef.current?.scrollLeft ?? 0;
    const originalStart = clip.timelineStartMs;
    const durationMs = clipDuration(clip);
    let destination = originalStart;
    let moved = false;
    const move = (pointer: { clientX: number; altKey: boolean }) => {
      const scrollDelta = (scrollRef.current?.scrollLeft ?? 0) - startScroll;
      const raw = Math.max(0, originalStart + (pointer.clientX - startX + scrollDelta) / Math.max(1, trackWidth) * total);
      destination = raw;
      if (snapEnabled !== pointer.altKey) {
        const threshold = 8 / Math.max(1, trackWidth) * total;
        const targets = [0, playheadMs, ...entries.filter((entry) => entry.clip.id !== clip.id).flatMap((entry) => [entry.startMs, entry.endMs])];
        let closest = threshold + 1;
        for (const target of targets) for (const edge of [raw, raw + durationMs]) {
          const distance = Math.abs(target - edge);
          if (distance < closest) { closest = distance; destination = Math.max(0, raw + target - edge); }
        }
      }
      moved ||= Math.abs(pointer.clientX - startX) > 2 || Math.abs((scrollRef.current?.scrollLeft ?? 0) - startScroll) > 2;
      setMoving({ clipId: clip.id, startMs: destination });
    };
    const finish = (pointer: { clientX: number; altKey: boolean }) => {
      move(pointer);
      setMoving(null);
      if (moved && Math.abs(destination - originalStart) >= 1) {
        try { dispatch({ type: "move_clip", actor: "human", clipId: clip.id, timelineStartMs: Math.round(destination) }); }
        catch (cause) { setError((cause as Error).message); }
      }
    };
    trackDrag(event, move, finish);
  };
  const trim = (event: React.PointerEvent, clip: Clip, edge: "in" | "out") => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startScroll = scrollRef.current?.scrollLeft ?? 0;
    const startIn = clip.sourceInMs; const startOut = clip.sourceOutMs;
    const timelineWidth = (event.currentTarget.closest(".timeline-track") as HTMLElement).offsetWidth;
    const calculate = (pointer: { clientX: number; altKey: boolean }) => {
      const scrollDelta = (scrollRef.current?.scrollLeft ?? 0) - startScroll;
      let timelineDelta = ((pointer.clientX - startX + scrollDelta) / timelineWidth) * total;
      if (snapEnabled !== pointer.altKey) {
        const movingEdge = clip.timelineStartMs + (edge === "out" ? clipDuration(clip) : 0) + timelineDelta;
        const threshold = 8 / timelineWidth * total;
        const targets = [0, playheadMs, ...entries.filter((entry) => entry.clip.id !== clip.id).flatMap((entry) => [entry.startMs, entry.endMs])];
        const closest = targets.reduce<{ target: number; distance: number } | null>((best, target) => {
          const distance = Math.abs(target - movingEdge);
          return distance <= threshold && (!best || distance < best.distance) ? { target, distance } : best;
        }, null);
        if (closest) timelineDelta += closest.target - movingEdge;
      }
      const sourceDelta = timelineDelta * clip.speed;
      const sourceInMs = edge === "in" ? Math.max(0, Math.min(startOut - 50, startIn + sourceDelta)) : startIn;
      const sourceOutMs = edge === "out" ? Math.min(state.durationMs, Math.max(startIn + 50, startOut + sourceDelta)) : startOut;
      return { clipId: clip.id, startMs: clip.timelineStartMs + (sourceInMs - startIn) / clip.speed, durationMs: (sourceOutMs - sourceInMs) / clip.speed, sourceInMs, sourceOutMs };
    };
    const move = (pointer: { clientX: number; altKey: boolean }) => setTrimming(calculate(pointer));
    const finish = (up: { clientX: number; altKey: boolean }) => {
      const result = calculate(up);
      setTrimming(null);
      if (Math.abs(result.sourceInMs - startIn) < 1 && Math.abs(result.sourceOutMs - startOut) < 1) return;
      try { dispatch({ type: "trim_clip", actor: "human", clipId: clip.id, sourceInMs: result.sourceInMs, sourceOutMs: result.sourceOutMs }); } catch (cause) { setError((cause as Error).message); }
    };
    trackDrag(event, move, finish);
  };
  const dragPlayhead = (event: React.PointerEvent) => {
    if (event.button !== 0 || !trackRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const update = (point: { clientX: number }) => { if (trackRef.current) seekAt(point.clientX, trackRef.current); };
    update(event);
    trackDrag(event, update, update);
  };
  return <div ref={scrollRef} className="relative min-h-0 select-none overflow-auto px-2.5 pt-[21px] pb-2"><div ref={trackRef} className="timeline-track relative h-full min-h-[60px] min-w-full rounded-[5px] [background:repeating-linear-gradient(90deg,#16191e_0,#16191e_139px,#1c2026_140px)]" style={{ width }} onClick={(event) => seekAt(event.clientX, event.currentTarget)}>
    <div className="absolute -top-[21px] left-0 z-[6] h-[21px] w-full overflow-hidden text-[8px] font-mono text-[#7f8590]" style={{ backgroundImage: "linear-gradient(to right, #3a4049 1px, transparent 1px)", backgroundSize: `${minorWidth}px 6px`, backgroundPosition: "left bottom", backgroundRepeat: "repeat-x" }}>
      {rulerMarks.map((time) => <span key={time} className="pointer-events-none absolute bottom-1 h-[17px] border-l border-[#68707c] pl-1 leading-none" style={{ left: `${time / total * 100}%` }}>{formatTimelineTime(time)}</span>)}
      <button type="button" aria-label="Scrub timeline" title="Click or drag to scrub" tabIndex={-1} className="absolute inset-0 size-full touch-none cursor-ew-resize select-none border-0 bg-transparent p-0 outline-none" onPointerDown={dragPlayhead} />
    </div>
    <div className="pointer-events-none absolute -top-[18px] -bottom-2.5 z-[7] w-0" style={{ left: Math.round((Math.max(0, Math.min(total, playheadMs)) / Math.max(1, total)) * (trackWidth || width)) }}><svg className="absolute -left-2.5 top-0 h-full w-5 overflow-visible" aria-hidden="true"><line x1="10" x2="10" y1="0" y2="100%" stroke="var(--orange)" strokeWidth="1" shapeRendering="crispEdges" /><path d="M10 0 L17 7 L10 14 L3 7 Z" fill="var(--orange)" /></svg><button
      type="button" aria-label="Drag playhead" title="Drag playhead"
      tabIndex={-1} className="pointer-events-auto absolute left-0 top-0 inline-flex size-5 -translate-x-1/2 touch-none cursor-ew-resize select-none border-0 bg-transparent p-0 outline-none"
      onPointerDown={dragPlayhead}
    /></div>
    {entries.map(({ clip, startMs, durationMs }, index) => <div
      key={clip.id} className="group absolute top-1 bottom-1 touch-none cursor-grab active:cursor-grabbing"
      style={{ left: `${((moving?.clipId === clip.id ? moving.startMs : trimming?.clipId === clip.id ? trimming.startMs : startMs) / total) * 100}%`, width: `${((trimming?.clipId === clip.id ? trimming.durationMs : durationMs) / total) * 100}%` }}
      onPointerDown={(event) => { onSelect(clip.id); moveClip(event, clip); }}
      onClick={(event) => { event.stopPropagation(); if (!moving) seekAt(event.clientX, event.currentTarget); }}
    >
      <button data-trim-handle className={`absolute top-0 left-0 z-[3] h-full w-[9px] cursor-ew-resize rounded-l border-0 bg-[var(--lime)] ${selectedClipId === clip.id ? "opacity-[.85]" : "opacity-0 group-hover:opacity-[.85]"}`} aria-label="Trim clip start" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => trim(event, clip, "in")} />
      <div className={`relative flex size-full items-center gap-2 overflow-hidden bg-gradient-to-br from-[#293341] to-[#1d252f] px-2.5 ${index === 0 ? "rounded-l-[5px]" : ""} ${index === entries.length - 1 ? "rounded-r-[5px]" : ""} ${selectedClipId === clip.id ? "shadow-[inset_0_0_0_2px_var(--lime)]" : ""}`}><AudioWaveform peaks={waveform} clip={trimming?.clipId === clip.id ? { ...clip, sourceInMs: trimming.sourceInMs, sourceOutMs: trimming.sourceOutMs } : clip} durationMs={state.durationMs} /><span className="relative z-[1] font-mono text-[10px] text-[#c0c6cf]">{formatTime(trimming?.clipId === clip.id ? trimming.durationMs : durationMs)}</span>{clip.muted ? <VolumeX className="relative z-[1] ml-auto size-3 shrink-0 text-[#829b96]" aria-hidden="true" /> : <Volume2 className="relative z-[1] ml-auto size-3 shrink-0 text-[#76c7b7]" aria-hidden="true" />}{clip.transition.type !== "cut" && <i className="relative z-[1] whitespace-nowrap text-[8px] not-italic text-[var(--orange)]">{clip.transition.type}</i>}</div>
      <button data-trim-handle className={`absolute top-0 right-0 z-[3] h-full w-[9px] cursor-ew-resize rounded-r border-0 bg-[var(--lime)] ${selectedClipId === clip.id ? "opacity-[.85]" : "opacity-0 group-hover:opacity-[.85]"}`} aria-label="Trim clip end" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => trim(event, clip, "out")} />
    </div>)}
  </div></div>;
}

function TranscriptPanel({ state, transcript, playheadMs, dispatch, transcribeVideo, seekTimeline, setError }: { state: ProjectState; transcript: TranscriptWord[]; playheadMs: number; dispatch(command: CommandInput): ProjectState; transcribeVideo(actor?: "human" | "agent", provider?: "cloudflare" | "openai", apiKey?: string, onProgress?: (message: string) => void): Promise<ProjectState>; seekTimeline(ms: number): void; setError(message: string): void }) {
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<[number, number] | null>(null);
  const [provider, setProvider] = useState<"cloudflare" | "openai">("cloudflare");
  const [apiKey, setApiKey] = useState("");
  const [processing, setProcessing] = useState("");
  const visible = transcript.filter((word) => !query || word.word.toLowerCase().includes(query.toLowerCase()));

  async function transcribe() {
    setError("");
    try { await transcribeVideo("human", provider, apiKey, setProcessing); setProcessing(""); }
    catch (cause) { setProcessing(""); setError(cause instanceof Error ? cause.message : "Transcription failed"); }
  }

  const selectedRange = selection && transcript.length ? { startMs: transcript[Math.min(...selection)].startMs, endMs: transcript[Math.max(...selection)].endMs } : null;
  function generateCaptions() {
    const items: Array<Omit<TimedText, "id">> = [];
    for (const entry of timelineClips(state)) {
      const words = transcript.filter((word) => word.startMs >= entry.clip.sourceInMs && word.endMs <= entry.clip.sourceOutMs);
      for (let index = 0; index < words.length; index += 8) {
        const group = words.slice(index, index + 8);
        if (!group.length) continue;
        items.push({ text: group.map((word) => word.word).join(" "), startMs: entry.startMs + (group[0].startMs - entry.clip.sourceInMs) / entry.clip.speed, endMs: entry.startMs + (group.at(-1)!.endMs - entry.clip.sourceInMs) / entry.clip.speed, position: "bottom" });
      }
    }
    dispatch({ type: "set_captions", actor: "human", items });
  }

  return <div>
    <div className="sticky top-0 z-2 flex min-h-12 items-center gap-1.75 overflow-x-auto border-b border-[var(--line)] bg-[#13161bef] px-3 py-1.75 max-[900px]:flex-wrap">
      <input className="min-w-[180px] rounded-md border border-[var(--line)] bg-[#0b0d10] px-2.25 py-1.75 text-[11px] text-white" aria-label="Search transcript" placeholder="Search transcript" value={query} onChange={(event) => setQuery(event.target.value)} />
      {transcript.length ? <>
        <button className="cursor-pointer whitespace-nowrap rounded-md border border-[#333944] bg-[#20242b] px-2.5 py-1.75 text-[10px]" disabled={!selectedRange} onClick={() => selectedRange && dispatch({ type: "protect_segment", actor: "human", ...selectedRange, label: "Protected by human" })}>Protect selection</button>
        <button className="cursor-pointer whitespace-nowrap rounded-md border border-[#333944] bg-[#20242b] px-2.5 py-1.75 text-[10px]" disabled={!selectedRange} onClick={() => selectedRange && dispatch({ type: "remove_segments", actor: "human", ranges: [selectedRange] })}>Cut selection</button>
        <button className="cursor-pointer whitespace-nowrap rounded-md border border-[#333944] bg-[#20242b] px-2.5 py-1.75 text-[10px]" onClick={generateCaptions}>Generate captions</button>
      </> : <>
        <select className="w-auto rounded-[5px] border border-[var(--line)] bg-[#0e1014] p-1.75 text-[11px]" aria-label="Transcription provider" value={provider} onChange={(event) => setProvider(event.target.value as typeof provider)}><option value="cloudflare">Cloudflare Whisper Large v3</option><option value="openai">OpenAI whisper-1 (your key)</option></select>
        {provider === "openai" && <input className="min-w-[180px] rounded-md border border-[var(--line)] bg-[#0b0d10] px-2.25 py-1.75 text-[11px] text-white" aria-label="Session-only OpenAI API key" type="password" autoComplete="off" placeholder="Session-only OpenAI key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />}
        <button className="cursor-pointer whitespace-nowrap rounded-[7px] border-0 bg-[var(--lime)] px-[13px] py-2 text-xs font-extrabold text-[#10120d] hover:bg-[#e5ff93]" disabled={!!processing || provider === "openai" && !apiKey} onClick={() => void transcribe()} aria-live="polite">{processing || "Transcribe video"}</button>
      </>}
    </div>
    {transcript.length ? <div className="p-3.5 leading-[2.05]">{visible.map((word) => {
      const index = transcript.indexOf(word); const selected = selection && index >= Math.min(...selection) && index <= Math.max(...selection);
      const current = word.startMs <= playheadMs && word.endMs >= playheadMs;
      return <button key={word.id} aria-pressed={!!selected} className={`cursor-pointer rounded-[3px] border-0 px-1 py-0.75 hover:bg-[#2c3139] ${selected ? "bg-[#5d681f] text-white" : "bg-transparent text-[#c7cad0]"} ${current ? "!text-[var(--lime)]" : ""}`} onClick={(event) => { if (event.shiftKey && selection) setSelection([selection[0], index]); else setSelection([index, index]); const clip = timelineClips(state).find((entry) => word.startMs >= entry.clip.sourceInMs && word.startMs <= entry.clip.sourceOutMs); if (clip) seekTimeline(clip.startMs + (word.startMs - clip.clip.sourceInMs) / clip.clip.speed); }}>{word.word}</button>;
    })}</div> : <div className="p-8 text-center text-xs text-[var(--muted)]">Transcribe to unlock text search, transcript cuts, and automatic captions.</div>}
  </div>;
}

function TextPanel({ state, playheadMs, dispatch }: { state: ProjectState; playheadMs: number; dispatch(command: CommandInput): ProjectState }) {
  const [kind, setKind] = useState<"caption" | "overlay" | "broll" | "protect">("overlay");
  const [text, setText] = useState("");
  const [duration, setDuration] = useState(3000);
  const [position, setPosition] = useState<TimedText["position"]>("center");
  const add = () => {
    if (!text.trim()) return;
    if (kind === "caption" || kind === "overlay") dispatch({ type: kind === "caption" ? "add_caption" : "add_overlay", actor: "human", item: { text, startMs: playheadMs, endMs: Math.min(timelineDuration(state), playheadMs + duration), position } });
    else {
      const point = timelineToSource(state, playheadMs); if (!point) return;
      const range = { startMs: point.sourceMs, endMs: Math.min(state.durationMs, point.sourceMs + duration), label: text };
      dispatch(kind === "broll" ? { type: "mark_broll", actor: "human", ...range } : { type: "protect_segment", actor: "human", ...range });
    }
    setText("");
  };
  return <div>
    <div className="sticky top-0 z-2 flex min-h-12 items-center gap-1.75 overflow-x-auto border-b border-[var(--line)] bg-[#13161bef] px-3 py-1.75 max-[900px]:flex-wrap">
      <select className="w-auto rounded-[5px] border border-[var(--line)] bg-[#0e1014] p-1.75 text-[11px]" aria-label="Marker type" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="overlay">Text overlay</option><option value="caption">Caption</option><option value="broll">B-roll marker</option><option value="protect">Protected range</option></select>
      <input className="min-w-[180px] flex-1 rounded-md border border-[var(--line)] bg-[#0b0d10] px-2.25 py-1.75 text-[11px] text-white" aria-label="Text or marker brief" placeholder="Text or marker brief" value={text} onChange={(event) => setText(event.target.value)} />
      {(kind === "caption" || kind === "overlay") && <select className="w-auto rounded-[5px] border border-[var(--line)] bg-[#0e1014] p-1.75 text-[11px]" aria-label="Text position" value={position} onChange={(event) => setPosition(event.target.value as typeof position)}><option value="top">Top</option><option value="center">Center</option><option value="bottom">Bottom</option></select>}
      <input className="min-w-[100px] rounded-md border border-[var(--line)] bg-[#0b0d10] px-2.25 py-1.75 text-[11px] text-white" aria-label="Duration in milliseconds" type="number" min={100} step={100} value={duration} onChange={(event) => setDuration(Number(event.target.value))} />
      <button className="cursor-pointer whitespace-nowrap rounded-md border border-[#333944] bg-[#20242b] px-2.5 py-1.75 text-[10px]" onClick={add}>Add at {formatTime(playheadMs)}</button>
    </div>
    <MarkerList state={state} dispatch={dispatch} />
  </div>;
}

function MarkerList({ state, dispatch }: { state: ProjectState; dispatch(command: CommandInput): ProjectState }) {
  return <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-1.75 p-3">
    {state.overlays.map((item) => <Marker key={item.id} label={`Text · ${item.text}`} range={item} onRemove={() => dispatch({ type: "remove_overlay", actor: "human", id: item.id })} />)}
    {state.captions.map((item) => <Marker key={item.id} label={`Caption · ${item.text}`} range={item} onRemove={() => dispatch({ type: "remove_caption", actor: "human", id: item.id })} />)}
    {state.broll.map((item) => <Marker key={item.id} label={`B-roll · ${item.label}`} range={item} onRemove={() => dispatch({ type: "remove_broll", actor: "human", id: item.id })} />)}
    {state.protectedRanges.map((item) => <Marker key={item.id} label={`Protected · ${item.label}`} range={item} onRemove={() => dispatch({ type: "unprotect_segment", actor: "human", rangeId: item.id })} />)}
  </div>;
}
function Marker({ label, range, onRemove }: { label: string; range: Pick<SourceRange, "startMs" | "endMs">; onRemove(): void }) { return <div className="flex justify-between rounded-md border border-[var(--line)] border-l-[3px] border-l-[var(--blue)] bg-[#171a20] p-2.25"><span className="flex min-w-0 flex-col gap-1"><b className="overflow-hidden text-[11px] text-ellipsis whitespace-nowrap">{label}</b><small className="font-mono text-[9px] text-[var(--muted)]">{formatTime(range.startMs)} → {formatTime(range.endMs)}</small></span><button className="cursor-pointer border-0 bg-transparent text-[var(--muted)]" aria-label={`Remove ${label}`} onClick={onRemove}>×</button></div>; }

function SilencePanel({ transcript, detect, dispatch, setError }: { transcript: TranscriptWord[]; detect(threshold: number, minimum: number): Promise<Array<{ startMs: number; endMs: number }>>; dispatch(command: CommandInput): ProjectState; setError(message: string): void }) {
  const [threshold, setThreshold] = useState(-35); const [minimum, setMinimum] = useState(500); const [padding, setPadding] = useState(200);
  const [ranges, setRanges] = useState<Array<{ startMs: number; endMs: number }>>([]); const [selected, setSelected] = useState<Set<number>>(new Set()); const [working, setWorking] = useState(false);
  const scan = async () => { setWorking(true); try { const found = (await detect(threshold, minimum)).filter((range) => !transcript.some((word) => word.startMs < range.endMs && range.startMs < word.endMs)); setRanges(found); setSelected(new Set(found.map((_, index) => index))); } catch (cause) { setError((cause as Error).message); } finally { setWorking(false); } };
  const apply = () => {
    const removals = ranges.filter((_, index) => selected.has(index)).map((range) => ({ startMs: range.startMs + padding, endMs: range.endMs - padding })).filter((range) => range.endMs - range.startMs >= 50);
    try { dispatch({ type: "remove_segments", actor: "human", ranges: removals }); setRanges([]); } catch (cause) { setError((cause as Error).message); }
  };
  return <div className="p-3"><div className="grid grid-cols-[repeat(3,minmax(130px,1fr))_auto] items-end gap-[18px] max-[900px]:grid-cols-2"><RangeControl label="Threshold" value={threshold} resetValue={-35} min={-60} max={-10} step={1} suffix="dB" onCommit={setThreshold} /><RangeControl label="Minimum" value={minimum} resetValue={500} min={100} max={3000} step={100} suffix="ms" onCommit={setMinimum} /><RangeControl label="Speech padding" value={padding} resetValue={200} min={0} max={500} step={25} suffix="ms" onCommit={setPadding} /><button className="cursor-pointer rounded-[7px] border-0 bg-[var(--lime)] px-[13px] py-2 text-xs font-extrabold text-[#10120d] hover:bg-[#e5ff93]" disabled={working} onClick={() => void scan()} aria-live="polite">{working ? "Scanning audio…" : "Find silences"}</button></div>{ranges.length > 0 && <><div className="my-3 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-1.5">{ranges.map((range, index) => <label className="flex items-center gap-2 rounded-[5px] border border-[var(--line)] p-2 text-[10px]" key={`${range.startMs}-${range.endMs}`}><input type="checkbox" checked={selected.has(index)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })} /><span className="flex-1 text-[#bdc1c8]">{formatTime(range.startMs)} → {formatTime(range.endMs)}</span><b className="text-[var(--lime)]">{((range.endMs - range.startMs) / 1000).toFixed(1)}s</b></label>)}</div><button className="cursor-pointer whitespace-nowrap rounded-md border border-[#333944] bg-[#20242b] px-2.5 py-1.75 text-[10px]" onClick={apply}>Remove {selected.size} selected silences</button></>}</div>;
}

function ActivityPanel({ state }: { state: ProjectState }) { return <div className="px-3.5 py-2.5">{state.activity.length ? state.activity.map((item) => <div className="flex gap-2.5 border-b border-[#20242a] py-1.75" key={item.id}><span className={`grid size-[25px] place-items-center rounded-full text-[9px] uppercase ${item.actor === "agent" ? "bg-[#3c451d] text-[var(--lime)]" : "bg-[#29303a]"}`}>{item.actor.slice(0, 1)}</span><p className="m-0 flex flex-col gap-0.75 text-[11px]"><b>{item.summary}</b><small className="text-[9px] text-[var(--muted)]">{new Date(item.at).toLocaleTimeString()}</small></p></div>) : <p className="p-8 text-center text-xs text-[var(--muted)]">Edits from you and your agent will appear here.</p>}</div>; }
