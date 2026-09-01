"use client";

import Link from "next/link";
import { Link2, Magnet, RotateCcw, Unlink2, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { clipDuration, exportSrt, musicClipEnd, timelineClips, timelineDuration, timelineToSource, type Clip, type MusicClip, type ProjectState, type TimedText, type TranscriptWord } from "@/lib/editor";
import { exportEdl } from "@/lib/edl";
import { type CommandInput, useEditor } from "./use-editor";
import { useWebMCP } from "./use-webmcp";

const MEDIA_URL = "/api/media";
type SaveFileHandle = { createWritable(): Promise<WritableStream<Uint8Array>> };
const formatTime = (ms: number) => {
  const seconds = Math.max(0, ms) / 1000;
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}.${String(Math.floor((seconds % 1) * 10))}`;
};
const cssFilter = (clip?: Clip) => clip ? `brightness(${1 + clip.brightness}) contrast(${clip.contrast}) saturate(${clip.saturation}) hue-rotate(${clip.hue}deg)` : undefined;
const cssTransform = (clip?: Clip) => clip ? `translate(${clip.positionX}%, ${clip.positionY}%) scale(${clip.scaleX}, ${clip.scaleY})` : undefined;
const textColor = (color?: "white" | "yellow" | "lime") => color === "yellow" ? "#ffe066" : color === "lime" ? "#d9ff63" : "white";

function PreviewTextLayer({ state, playheadMs, preview }: { state: ProjectState; playheadMs: number; preview: { kind: "caption" | "overlay"; id: string; patch: Partial<TimedText> } | null }) {
  const items = [
    ...state.overlays.filter((item) => playheadMs >= item.startMs && playheadMs <= item.endMs).map((item) => ({ ...item, ...(preview?.kind === "overlay" && preview.id === item.id ? preview.patch : {}), fontSize: preview?.kind === "overlay" && preview.id === item.id && preview.patch.fontSize !== undefined ? preview.patch.fontSize : item.fontSize ?? 54, color: textColor(item.color), background: item.background !== false, padding: 10 })),
    ...state.captions.filter((item) => playheadMs >= item.startMs && playheadMs <= item.endMs).map((item) => ({ ...item, fontSize: { small: 38, medium: 48, large: 58 }[state.captionStyle.size], color: textColor(state.captionStyle.color), background: state.captionStyle.background, padding: 3 })),
  ];
  return <svg className="pointer-events-none absolute inset-0 z-4 size-full" viewBox="0 0 1920 1080" preserveAspectRatio="none" aria-hidden="true"><foreignObject width="1920" height="1080"><div className="relative size-full overflow-hidden font-[RoughCutText] font-bold">{items.map((item) => <div key={item.id} className="absolute flex justify-center text-center" style={{ left: 60 - (item.background ? item.padding : 0), right: 60 - (item.background ? item.padding : 0), ...(item.position === "top" ? { top: 60 - (item.background ? item.padding : 0) } : item.position === "bottom" ? { bottom: 60 - (item.background ? item.padding : 0) } : { top: "50%", transform: "translateY(-50%)" }) }}><span style={{ display: "inline-block", maxWidth: "100%", padding: item.background ? item.padding : 0, background: item.background ? "#0007" : "transparent", color: item.color, fontSize: item.fontSize, lineHeight: 1.2, whiteSpace: "pre-wrap", overflowWrap: "break-word", textShadow: "0 2px 3px #000" }}>{item.text}</span></div>)}</div></foreignObject></svg>;
}

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
  const musicRef = useRef<HTMLAudioElement>(null);
  const transitionStarted = useRef(false);
  const initialSeekDone = useRef(false);
  const reconciledVersion = useRef<number | null>(null);
  const reconciledClipId = useRef<string | null>(null);
  const gapFrame = useRef<number | null>(null);
  const exportResetTimer = useRef<number | null>(null);
  const autoTranscribeStarted = useRef(false);
  const [selectedClipId, setSelectedClipId] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [secondaryOpacity, setSecondaryOpacity] = useState(0);
  const [blackOpacity, setBlackOpacity] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [tab, setTab] = useState<"transcript" | "text" | "music" | "silence" | "activity">("transcript");
  const [webmcpStatus, setWebmcpStatus] = useState("Unavailable");
  const [exportStatus, setExportStatus] = useState("");
  const [exportDialog, setExportDialog] = useState(false);
  const [exportName, setExportName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [autoTranscriptionStatus, setAutoTranscriptionStatus] = useState("");
  const [frame, setFrame] = useState<string | null>(null);
  const [waveform, setWaveform] = useState<number[]>([]);
  const [musicWaveform, setMusicWaveform] = useState<number[]>([]);
  const [timelineHeight, setTimelineHeight] = useState(265);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [optionHeld, setOptionHeld] = useState(false);
  const [lowerHeight, setLowerHeight] = useState(210);
  const [selectedText, setSelectedText] = useState<{ kind: "caption" | "overlay"; id: string } | null>(null);
  const [selectedMusicId, setSelectedMusicId] = useState("");
  const [musicPreview, setMusicPreview] = useState<{ clipId: string; patch: Partial<MusicClip> } | null>(null);
  const [textPreview, setTextPreview] = useState<{ kind: "caption" | "overlay"; id: string; patch: Partial<TimedText> } | null>(null);

  useEffect(() => () => { if (exportResetTimer.current !== null) window.clearTimeout(exportResetTimer.current); }, []);

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

  const musicId = state?.music[0]?.assetId;
  useEffect(() => {
    if (!musicId) { setMusicWaveform([]); return; }
    const controller = new AbortController();
    fetch(`${MEDIA_URL}/waveform`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, asset: "music", assetVersion: musicId }), signal: controller.signal })
      .then(async (response) => { const result = await response.json() as { peaks?: number[] }; if (response.ok && result.peaks) setMusicWaveform(result.peaks); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [musicId, projectId]);

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
  const selectedClip = state?.clips.find((clip) => clip.id === selectedClipId);
  const selectedTextItem = selectedText && state ? (selectedText.kind === "caption" ? state.captions : state.overlays).find((item) => item.id === selectedText.id) : undefined;
  const selectedMusic = state?.music.find((music) => music.id === selectedMusicId);
  const orderedClips = state ? timelineClips(state) : [];
  const activeClip = orderedClips[activeIndex]?.clip;
  const nextClip = orderedClips[activeIndex + 1]?.clip;

  useEffect(() => {
    if (state && selectedClipId && !state.clips.some((clip) => clip.id === selectedClipId)) setSelectedClipId("");
    if (state && activeIndex >= state.clips.length) setActiveIndex(Math.max(0, state.clips.length - 1));
    if (state && selectedMusicId && !state.music.some((music) => music.id === selectedMusicId)) setSelectedMusicId(state.music[0]?.id ?? "");
    if (state && selectedText && !(selectedText.kind === "caption" ? state.captions : state.overlays).some((item) => item.id === selectedText.id)) setSelectedText(null);
  }, [activeIndex, selectedClipId, selectedMusicId, selectedText, state]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeClip) return;
    video.playbackRate = activeClip.speed;
    video.volume = activeClip.muted ? 0 : Math.min(1, activeClip.volume);
  }, [activeClip]);

  const playVideo = useCallback((video: HTMLVideoElement) => {
    void video.play().catch((cause) => {
      if (video.paused) setIsPlaying(false);
      if (!(cause instanceof DOMException) || cause.name !== "AbortError") setError(cause instanceof Error ? cause.message : "Video playback failed");
    });
  }, [setError]);

  const syncMusic = useCallback((targetMs: number, play = false) => {
    const audio = musicRef.current;
    const music = state?.music.find((item) => targetMs >= item.timelineStartMs && targetMs < musicClipEnd(state, item));
    if (!audio || !music || !state) { audio?.pause(); return; }
    const endMs = musicClipEnd(state, music);
    const span = music.sourceOutMs - music.sourceInMs;
    const elapsed = targetMs - music.timelineStartMs;
    const sourceMs = music.sourceInMs + (music.loop ? elapsed % span : elapsed);
    if (Math.abs(audio.currentTime * 1000 - sourceMs) > 250) audio.currentTime = sourceMs / 1000;
    const remaining = endMs - targetMs;
    const fade = Math.min(music.fadeInMs ? elapsed / music.fadeInMs : 1, music.fadeOutMs ? remaining / music.fadeOutMs : 1, 1);
    audio.volume = music.muted ? 0 : Math.min(1, music.volume * Math.max(0, fade));
    if (play && audio.paused) void audio.play().catch(() => undefined);
  }, [state]);

  const stopGapPlayback = useCallback(() => {
    if (gapFrame.current !== null) cancelAnimationFrame(gapFrame.current);
    gapFrame.current = null;
  }, []);

  const startGapPlayback = useCallback((startMs: number) => {
    if (!state || !videoRef.current) return;
    stopGapPlayback();
    const clips = timelineClips(state);
    const nextIndex = clips.findIndex((entry) => entry.startMs >= startMs);
    const endMs = nextIndex < 0 ? totalMs : clips[nextIndex].startMs;
    const startedAt = performance.now();
    setIsPlaying(true);
    setBlackOpacity(1);
    syncMusic(startMs, true);
    const tick = (now: number) => {
      const current = Math.min(endMs, startMs + now - startedAt);
      setPlayheadMs(current);
      syncMusic(current, true);
      if (current < endMs) { gapFrame.current = requestAnimationFrame(tick); return; }
      gapFrame.current = null;
      if (nextIndex < 0) { setIsPlaying(false); return; }
      const entry = clips[nextIndex];
      setActiveIndex(nextIndex);
      setBlackOpacity(0);
      videoRef.current!.currentTime = entry.clip.sourceInMs / 1000;
      videoRef.current!.playbackRate = entry.clip.speed;
      playVideo(videoRef.current!);
    };
    gapFrame.current = requestAnimationFrame(tick);
  }, [playVideo, state, stopGapPlayback, syncMusic, totalMs]);

  const seekTimeline = useCallback((targetMs: number) => {
    const video = videoRef.current;
    if (!state || !video) return;
    const resume = isPlaying || gapFrame.current !== null || !video.paused;
    stopGapPlayback();
    const clamped = Math.max(0, Math.min(totalMs, targetMs));
    const all = timelineClips(state);
    const index = all.findIndex((entry) => clamped >= entry.startMs && clamped < entry.endMs);
    setPlayheadMs(clamped);
    syncMusic(clamped, resume);
    if (index < 0) {
      setActiveIndex(-1);
      video.pause();
      setSecondaryOpacity(0); setBlackOpacity(1);
      if (resume) startGapPlayback(clamped);
      return;
    }
    const entry = all[index];
    const sourceMs = entry.clip.sourceInMs + (clamped - entry.startMs) * entry.clip.speed;
    setActiveIndex(index);
    video.currentTime = Math.min(entry.clip.sourceOutMs - 1, sourceMs) / 1000;
    video.playbackRate = entry.clip.speed;
    transitionStarted.current = false;
    setSecondaryOpacity(0); setBlackOpacity(0);
    if (resume && video.paused) playVideo(video);
  }, [isPlaying, playVideo, startGapPlayback, state, stopGapPlayback, syncMusic, totalMs]);

  const ensureInitialSeek = useCallback(() => {
    if (initialSeekDone.current || !state || !videoRef.current || videoRef.current.readyState < 1) return;
    initialSeekDone.current = true;
    seekTimeline(0);
  }, [seekTimeline, state]);
  useEffect(() => ensureInitialSeek(), [ensureInitialSeek]);

  useEffect(() => {
    if (!state) return;
    const previousVersion = reconciledVersion.current;
    const previousClipId = reconciledClipId.current;
    reconciledVersion.current = state.version;
    reconciledClipId.current = activeClip?.id ?? null;
    const video = videoRef.current;
    if (previousVersion === null || previousVersion === state.version || !video || video.readyState < 1) return;
    const entry = timelineClips(state).find(({ startMs, endMs }) => playheadMs >= startMs && playheadMs < endMs);
    if (entry?.clip.id === previousClipId) return;
    const resume = isPlaying;
    seekTimeline(playheadMs);
    if (!resume) return;
    if (entry) playVideo(video);
    else startGapPlayback(playheadMs);
  }, [activeClip?.id, isPlaying, playVideo, playheadMs, seekTimeline, startGapPlayback, state]);

  const updatePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.paused || !state || !activeClip) return;
    const entry = timelineClips(state)[activeIndex];
    const sourceMs = video.currentTime * 1000;
    const currentTimelineMs = entry.startMs + (sourceMs - activeClip.sourceInMs) / activeClip.speed;
    setPlayheadMs(Math.max(0, Math.min(currentTimelineMs, totalMs)));
    syncMusic(currentTimelineMs, !video.paused);

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
      if (!nextClip) { video.pause(); if (entry.endMs < totalMs - 1) startGapPlayback(entry.endMs); else setPlayheadMs(totalMs); return; }
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
      if (!video.paused) playVideo(video);
    }
  }, [activeClip, activeIndex, nextClip, playVideo, startGapPlayback, state, syncMusic, totalMs]);

  const handleVideoEnded = useCallback(() => {
    const video = videoRef.current;
    if (!video || !state || activeIndex < 0) return;
    const clips = timelineClips(state);
    const current = clips[activeIndex];
    const next = clips[activeIndex + 1];
    if (next && next.startMs <= current.endMs + 1) {
      setActiveIndex(activeIndex + 1);
      video.currentTime = next.clip.sourceInMs / 1000;
      video.playbackRate = next.clip.speed;
      setSecondaryOpacity(0); setBlackOpacity(0);
      playVideo(video);
    } else if (current.endMs < totalMs - 1) {
      startGapPlayback(current.endMs);
    } else {
      setPlayheadMs(totalMs);
      setIsPlaying(false);
    }
  }, [activeIndex, playVideo, startGapPlayback, state, totalMs]);

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video || !state) return;
    if (gapFrame.current !== null || activeIndex < 0 && isPlaying) { stopGapPlayback(); musicRef.current?.pause(); setIsPlaying(false); return; }
    if (activeIndex < 0) { startGapPlayback(playheadMs); return; }
    if (video.paused) {
      if (playheadMs >= totalMs - 10) { seekTimeline(0); playVideo(video); return; }
      const entry = timelineClips(state)[activeIndex];
      if (entry && (video.currentTime * 1000 < entry.clip.sourceInMs || video.currentTime * 1000 >= entry.clip.sourceOutMs - 1)) {
        video.currentTime = (entry.clip.sourceInMs + (playheadMs - entry.startMs) * entry.clip.speed) / 1000;
      }
      playVideo(video);
    } else {
      video.pause(); nextVideoRef.current?.pause();
    }
  }, [activeIndex, isPlaying, playVideo, playheadMs, seekTimeline, startGapPlayback, state, stopGapPlayback, totalMs]);

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
        if (!event.repeat) {
          try {
            if (selectedText) dispatch({ type: selectedText.kind === "caption" ? "remove_caption" : "remove_overlay", actor: "human", id: selectedText.id });
            else if (selectedMusicId) dispatch({ type: "remove_music", actor: "human", clipId: selectedMusicId, ripple: event.key === "Delete" });
            else if (selectedClip) dispatch({ type: "delete_clip", actor: "human", clipId: selectedClip.id, ripple: event.key === "Delete" });
          } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not delete selection"); }
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
  }, [dispatch, redo, selectedClip, selectedMusicId, selectedText, setError, togglePlayback, undo]);

  const splitAtPlayhead = () => {
    if (!state) return;
    try {
      if (selectedText) dispatch({ type: "split_text", actor: "human", kind: selectedText.kind, id: selectedText.id, timelineMs: Math.round(playheadMs) });
      else if (selectedMusicId) dispatch({ type: "split_music", actor: "human", clipId: selectedMusicId, timelineMs: Math.round(playheadMs) });
      else {
        const point = timelineToSource(state, playheadMs);
        if (!point || point.clipId !== selectedClip?.id) throw new Error("Place the playhead inside the selected clip");
        dispatch({ type: "split_clip", actor: "human", clipId: point.clipId, sourceMs: Math.round(point.sourceMs) });
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not split clip"); }
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

  const exportMp4 = useCallback(async (baseName?: string, fileHandle?: SaveFileHandle) => {
    const current = editor.stateRef.current;
    if (!current) throw new Error("Project is not ready");
    if (exportResetTimer.current !== null) window.clearTimeout(exportResetTimer.current);
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
        exportResetTimer.current = window.setTimeout(() => { setExportStatus(""); exportResetTimer.current = null; }, 5000);
        const name = (baseName?.trim() || current.name) + ".mp4";
        if (fileHandle) {
          const response = await fetch(downloadUrl);
          if (!response.ok || !response.body) throw new Error("Could not download export");
          await response.body.pipeTo(await fileHandle.createWritable());
        } else {
          const anchor = document.createElement("a");
          anchor.href = `${downloadUrl}?filename=${encodeURIComponent(name)}`; anchor.download = name; anchor.click();
        }
        return { jobId: job.id, downloadUrl };
      }
    }
    throw new Error("Export timed out");
  }, [editor.stateRef]);

  const startHumanExport = useCallback(async () => {
    const name = exportName.trim();
    if (!name || /[\\/]/.test(name)) return;
    let handle: SaveFileHandle | undefined;
    const picker = (window as Window & { showSaveFilePicker?: (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<SaveFileHandle> }).showSaveFilePicker;
    if (picker) {
      try { handle = await picker.call(window, { suggestedName: `${name}.mp4`, types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }] }); }
      catch (cause) { if (cause instanceof DOMException && cause.name === "AbortError") return; throw cause; }
    }
    setExportDialog(false);
    await exportMp4(name, handle);
  }, [exportMp4, exportName]);

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

  const transcribeVideo = useCallback(async (actor: "human" | "agent" | "system" = "human", provider: "cloudflare" | "openai" = "cloudflare", apiKey = "", onProgress?: (message: string) => void, expectedVersion?: number) => {
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

  useEffect(() => {
    if (!state || transcript.length || autoTranscribeStarted.current || state.activity.some((item) => item.summary === "transcribed video")) return;
    autoTranscribeStarted.current = true;
    void transcribeVideo("system", "cloudflare", "", setAutoTranscriptionStatus)
      .then(() => setAutoTranscriptionStatus(""))
      .catch((cause) => { setAutoTranscriptionStatus(""); setError(cause instanceof Error ? cause.message : "Automatic transcription failed"); });
  }, [setError, state, transcript.length, transcribeVideo]);

  useWebMCP({
    stateRef: editor.stateRef, transcriptRef: editor.transcriptRef, dispatch, undo, redo,
    seekTimeline, inspectFrame, detectSilences, transcribeVideo: (actor, expectedVersion) => transcribeVideo(actor, "cloudflare", "", undefined, expectedVersion), exportMp4, exportEdl: exportEdlFile,
    exportSrt: () => { const current = editor.stateRef.current; if (!current) throw new Error("Project is not ready"); const text = exportSrt(current); downloadText(`${current.name}.srt`, text, "application/x-subrip"); return text; },
    setStatus: setWebmcpStatus,
  });

  if (!project) return <main className="grid min-h-dvh place-content-center justify-items-center gap-[15px] text-[var(--muted)]"><div className="size-[30px] animate-spin rounded-full border-[3px] border-[#2f333a] border-t-[var(--lime)] motion-reduce:animate-none" /><p>{error || "Loading project…"}</p></main>;

  return (
    <main className="grid h-dvh min-h-0 grid-rows-[58px_auto_minmax(0,1fr)_var(--timeline-height)_var(--lower-height)] overflow-hidden bg-[var(--bg)] max-[900px]:h-auto max-[900px]:min-h-dvh max-[900px]:grid-rows-[auto_auto_auto_180px_290px] max-[900px]:overflow-visible" style={{ "--timeline-height": `${timelineHeight}px`, "--lower-height": `${lowerHeight}px` } as React.CSSProperties}>
      <header className="row-start-1 grid grid-cols-[220px_1fr_auto] items-center gap-5 border-b border-[var(--line)] bg-[#0d0f12] px-[18px] max-[900px]:min-h-[58px] max-[900px]:grid-cols-[auto_1fr] max-[900px]:p-2.5">
        <Link href="/" className="inline-flex items-center gap-[.22em] text-[17px] font-black tracking-[-.07em] text-white no-underline"><span>ROUGH</span><i className="not-italic text-[var(--orange)]">{"//"}</i><span>CUT</span></Link>
        <div className="flex min-w-0 items-center gap-2.5">{renaming && state ? <form className="flex min-w-0 items-center gap-1.5" onSubmit={(event) => { event.preventDefault(); const name = projectNameDraft.trim(); if (!name) return; dispatch({ type: "rename_project", actor: "human", name }); setRenaming(false); }}><input autoFocus maxLength={120} className="min-w-0 rounded border border-[var(--lime)] bg-[#0b0d10] px-2 py-1 text-[12px] text-white" aria-label="Project name" value={projectNameDraft} onChange={(event) => setProjectNameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setRenaming(false); }} /><button className="cursor-pointer rounded border border-[var(--line)] bg-[#20242b] px-2 py-1 text-[9px]">Save</button></form> : <button className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden border-0 bg-transparent p-0 text-left text-[13px] font-bold text-white whitespace-nowrap" title="Rename project" onClick={() => { setProjectNameDraft(state?.name ?? project.name); setRenaming(true); }}><span className="overflow-hidden text-ellipsis">{state?.name ?? project.name}</span><span className="text-[10px] text-[var(--muted)]" aria-hidden="true">✎</span></button>}<span className="text-[10px] text-[var(--muted)] max-[900px]:hidden"><SaveStatus saving={saving} savedAt={lastSavedAt} ready={!!state} /></span></div>
        <div className="flex items-center gap-2.25 max-[900px]:col-span-full max-[900px]:flex-wrap">
          <span className="inline-flex items-center gap-1.75 rounded-full border border-[#323740] px-2.5 py-1.5 text-[9px] tracking-[.08em] text-[var(--muted)] uppercase"><b className={`size-1.75 rounded-full ${webmcpStatus === "Ready" ? "bg-[var(--lime)] shadow-[0_0_8px_var(--lime)]" : "bg-[#666]"}`} /> WebMCP {webmcpStatus}</span>
          <button className="cursor-pointer rounded-[7px] border border-[var(--line)] bg-transparent px-3 py-1.75 text-[10px]" onClick={() => state && downloadText(`${state.name}.edl`, exportEdl(state))}>EDL</button>
          <button className="cursor-pointer rounded-[7px] border border-[var(--line)] bg-transparent px-3 py-1.75 text-[10px]" disabled={!state?.captions.length} onClick={() => state && downloadText(`${state.name}.srt`, exportSrt(state), "application/x-subrip")}>SRT</button>
          <button className="cursor-pointer rounded-[7px] border-0 bg-[var(--lime)] px-[13px] py-2 text-[10px] font-extrabold text-[#10120d] shadow-[0_8px_30px_#d9ff6324] hover:bg-[#e5ff93]" disabled={!state || !!exportStatus && exportStatus !== "Export complete"} onClick={() => { setExportName(state?.name ?? "rough-cut"); setExportDialog(true); }}>{exportStatus || "Export MP4"}</button>
        </div>
      </header>

      {error && <div className="row-start-2 flex justify-between border-b border-[#7c3024] bg-[#401c17] px-[18px] py-2 text-xs text-[#ff9781]" role="alert">{error}<button className="cursor-pointer border-0 bg-transparent" aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}

      <section className="row-start-3 grid min-h-0 grid-cols-[minmax(0,1fr)_280px] max-[900px]:grid-cols-1">
        <div className="flex min-h-0 min-w-0 flex-col items-center justify-center overflow-hidden bg-[radial-gradient(circle,_#1b1e24_0,_#0e1013_70%)] p-3 max-[900px]:overflow-visible max-[900px]:p-2.5">
          <div className="preview-stage relative aspect-video h-[calc(100%_-_42px)] w-auto max-w-full flex-none overflow-hidden rounded-[5px] bg-black shadow-[0_20px_60px_#0009] max-[900px]:h-auto max-[900px]:w-full">
            <video
              ref={videoRef} src={`/api/projects/${projectId}/media`} playsInline preload="metadata" aria-label="Video preview" className="block size-full object-contain"
              style={{ filter: cssFilter(activeClip), transform: cssTransform(activeClip) }}
              onLoadedMetadata={(event) => { initialize(event.currentTarget.duration * 1000); requestAnimationFrame(ensureInitialSeek); }}
              onTimeUpdate={updatePlayback}
              onEnded={handleVideoEnded}
              onPlay={() => { setIsPlaying(true); syncMusic(playheadMs, true); if (transitionStarted.current) void nextVideoRef.current?.play(); }}
              onPause={() => { if (gapFrame.current === null) { setIsPlaying(false); musicRef.current?.pause(); } nextVideoRef.current?.pause(); }}
            />
            {!!state?.music.length && <audio ref={musicRef} src={`/api/projects/${projectId}/music?asset=${state.music[0].assetId}`} preload="auto" aria-label="Background music" onTimeUpdate={(event) => { const music = state.music.find((item) => playheadMs >= item.timelineStartMs && playheadMs < musicClipEnd(state, item)); if (!music) return; if (event.currentTarget.currentTime * 1000 >= music.sourceOutMs - 15) { if (music.loop) event.currentTarget.currentTime = music.sourceInMs / 1000; else event.currentTarget.pause(); } }} />}
            <video ref={nextVideoRef} src={`/api/projects/${projectId}/media`} playsInline preload="metadata" muted={false} aria-hidden="true" className="pointer-events-none absolute inset-0 block size-full object-contain" style={{ opacity: secondaryOpacity, filter: cssFilter(nextClip), transform: cssTransform(nextClip) }} />
            <div className="pointer-events-none absolute inset-0 bg-black" style={{ opacity: blackOpacity }} />
            {state && <PreviewTextLayer state={state} playheadMs={playheadMs} preview={textPreview} />}
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
          <div className="sticky top-0 z-2 flex justify-between border-b border-[var(--line)] bg-[#14161b] px-[13px] py-[11px] text-[9px] tracking-[.14em] text-[#c7cad0] uppercase"><span>Inspector</span>{selectedClip && <code className="text-[var(--muted)]">{formatTime(clipDuration(selectedClip))}</code>}</div>
          {state && selectedText && selectedTextItem ? <TextInspector state={state} kind={selectedText.kind} item={selectedTextItem} onPreview={(patch) => setTextPreview({ kind: selectedText.kind, id: selectedText.id, patch })} onCommit={() => setTextPreview(null)} dispatch={dispatch} /> : state && selectedMusic ? <MusicInspector state={state} music={selectedMusic} onPreview={(patch) => setMusicPreview({ clipId: selectedMusic.id, patch })} onCommit={() => setMusicPreview(null)} dispatch={dispatch} /> : state && selectedClip ? <ClipInspector state={state} clip={selectedClip} dispatch={dispatch} previewClip={previewClip} setError={setError} /> : <p className="p-8 text-center text-xs text-[var(--muted)]">Select a clip to adjust it.</p>}
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
        {state && <Timeline state={state} waveform={waveform} musicWaveform={musicWaveform} musicPreview={musicPreview} snapEnabled={snapEnabled} playheadMs={playheadMs} selectedClipId={selectedClip?.id ?? ""} selectedMusicId={selectedMusicId} selectedText={selectedText} onSelect={(id) => { setSelectedClipId(id); setSelectedText(null); setSelectedMusicId(""); }} onEditText={(kind, id) => { setSelectedText({ kind, id }); setSelectedClipId(""); setSelectedMusicId(""); setTab("text"); }} onEditMusic={(id) => { setSelectedMusicId(id); setSelectedClipId(""); setSelectedText(null); setTab("music"); }} onClearSelection={() => { setSelectedClipId(""); setSelectedMusicId(""); setSelectedText(null); }} onSeek={seekTimeline} dispatch={dispatch} setError={setError} />}
      </section>

      <section className="relative row-start-5 grid min-h-0 grid-rows-[36px_1fr] overflow-hidden bg-[var(--panel)]">
        <button type="button" aria-label="Resize timeline and transcript" title="Drag to resize timeline and transcript" className="group absolute top-0 left-0 z-20 hidden h-2 w-full touch-none cursor-row-resize border-0 bg-transparent p-0 min-[901px]:block" onPointerDown={(event) => startResize("timeline", event)}><span className="absolute top-0 left-1/2 h-px w-12 -translate-x-1/2 bg-[#3a4049] transition-colors group-hover:bg-[var(--lime)]" /></button>
        <div className="flex gap-[18px] border-b border-[var(--line)] px-3" role="tablist" aria-label="Editor panels">
          {(["transcript", "text", "music", "silence", "activity"] as const).map((name) => <button key={name} role="tab" aria-selected={tab === name} className={`cursor-pointer border-0 border-b-2 bg-transparent text-[9px] tracking-[.12em] uppercase ${tab === name ? "border-[var(--lime)] text-white" : "border-transparent text-[#777e89]"}`} onClick={() => setTab(name)}>{name}</button>)}
        </div>
        <div className="min-h-0 overflow-auto" role="tabpanel">
          {tab === "transcript" && state && <TranscriptPanel state={state} transcript={transcript} playheadMs={playheadMs} dispatch={dispatch} transcribeVideo={transcribeVideo} automaticStatus={autoTranscriptionStatus} seekTimeline={seekTimeline} setError={setError} />}
          {tab === "text" && state && <TextPanel state={state} playheadMs={playheadMs} dispatch={dispatch} />}
          {tab === "music" && state && <MusicPanel projectId={projectId} state={state} dispatch={dispatch} setError={setError} />}
          {tab === "silence" && state && <SilencePanel transcript={transcript} detect={detectSilences} dispatch={dispatch} setError={setError} />}
          {tab === "activity" && state && <ActivityPanel state={state} />}
        </div>
      </section>

      {exportDialog && <div className="fixed inset-0 z-30 grid place-items-center bg-[#000c] p-5" role="dialog" aria-modal="true" aria-labelledby="export-title" onClick={() => setExportDialog(false)}><form className="w-[min(440px,100%)] rounded-xl border border-[#3a4049] bg-[#14171b] p-5 shadow-2xl" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void startHumanExport().catch((cause) => { setError(cause instanceof Error ? cause.message : "Export failed"); setExportStatus(""); setExportDialog(false); }); }}><h2 id="export-title" className="mt-0 mb-1 text-lg">Export MP4</h2><p className="mt-0 mb-5 text-[11px] text-[var(--muted)]">{typeof window !== "undefined" && "showSaveFilePicker" in window ? "Choose the file name, then select where to save it." : "Choose the file name. This browser will save it to its configured Downloads folder."}</p><label className="grid gap-1.5 text-[10px] text-[var(--muted)] uppercase">File name<span className="flex overflow-hidden rounded-md border border-[var(--line)] bg-[#0b0d10]"><input autoFocus className="min-w-0 flex-1 border-0 bg-transparent px-3 py-2 text-[12px] text-white outline-none" value={exportName} onChange={(event) => setExportName(event.target.value)} /><b className="border-l border-[var(--line)] px-3 py-2 text-[12px] font-normal text-[#888f99] normal-case">.mp4</b></span></label>{/[\\/]/.test(exportName) && <p className="mb-0 text-[10px] text-[#ff9781]">File name cannot contain slashes.</p>}<div className="mt-5 flex justify-end gap-2"><button type="button" className="cursor-pointer rounded-md border border-[var(--line)] bg-transparent px-3 py-2 text-[10px]" onClick={() => setExportDialog(false)}>Cancel</button><button type="submit" disabled={!exportName.trim() || /[\\/]/.test(exportName)} className="cursor-pointer rounded-md border-0 bg-[var(--lime)] px-3 py-2 text-[10px] font-bold text-[#10120d]">Export</button></div></form></div>}
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

function TextInspector({ state, kind, item, onPreview, onCommit, dispatch }: { state: ProjectState; kind: "caption" | "overlay"; item: TimedText; onPreview(patch: Partial<TimedText>): void; onCommit(): void; dispatch(command: CommandInput): ProjectState }) {
  const adjust = (patch: Partial<TimedText>) => { onCommit(); return dispatch({ type: kind === "caption" ? "update_caption" : "update_overlay", actor: "human", id: item.id, patch }); };
  return <div className="px-3.5 pt-3 pb-[30px]">
    <label className="text-[9px] text-[var(--muted)] uppercase">Text<textarea key={`${item.id}-${item.text}`} className="mt-1 min-h-16 w-full resize-y rounded-[5px] border border-[var(--line)] bg-[#0c0e11] p-2 text-[11px] text-white" defaultValue={item.text} onBlur={(event) => { const text = event.target.value.trim(); if (text && text !== item.text) adjust({ text }); }} /></label>
    <div className="mt-3 grid grid-cols-2 gap-2"><label className="text-[9px] text-[var(--muted)] uppercase">Start (ms)<input key={`${item.id}-start-${item.startMs}`} className="mt-1 w-full rounded border border-[var(--line)] bg-[#0c0e11] p-1.5 text-white" type="number" min={0} max={item.endMs - 50} defaultValue={Math.round(item.startMs)} onBlur={(event) => adjust({ startMs: Number(event.target.value) })} /></label><label className="text-[9px] text-[var(--muted)] uppercase">End (ms)<input key={`${item.id}-end-${item.endMs}`} className="mt-1 w-full rounded border border-[var(--line)] bg-[#0c0e11] p-1.5 text-white" type="number" min={item.startMs + 50} max={timelineDuration(state)} defaultValue={Math.round(item.endMs)} onBlur={(event) => adjust({ endMs: Number(event.target.value) })} /></label></div>
    <label className="mt-3 grid gap-1 text-[9px] text-[var(--muted)] uppercase">Position<select className="rounded border border-[var(--line)] bg-[#0e1014] p-1.5 text-[11px] text-white" value={item.position} onChange={(event) => adjust({ position: event.target.value as TimedText["position"] })}><option value="top">Top</option><option value="center">Center</option><option value="bottom">Bottom</option></select></label>
    {kind === "overlay" ? <><RangeControl label="Size" value={item.fontSize ?? 54} resetValue={54} min={16} max={160} step={2} onPreview={(fontSize) => onPreview({ fontSize })} onCommit={(fontSize) => adjust({ fontSize })} /><label className="mt-3 grid gap-1 text-[9px] text-[var(--muted)] uppercase">Color<select className="rounded border border-[var(--line)] bg-[#0e1014] p-1.5 text-[11px] text-white" value={item.color ?? "white"} onChange={(event) => adjust({ color: event.target.value as TimedText["color"] })}><option value="white">White</option><option value="yellow">Yellow</option><option value="lime">Lime</option></select></label><label className="mt-3 flex items-center gap-2 text-[11px] text-[#a6abb4]"><input type="checkbox" checked={item.background !== false} onChange={(event) => adjust({ background: event.target.checked })} /> Background</label></> : <><label className="mt-3 grid gap-1 text-[9px] text-[var(--muted)] uppercase">Subtitle size<select className="rounded border border-[var(--line)] bg-[#0e1014] p-1.5 text-[11px] text-white" value={state.captionStyle.size} onChange={(event) => dispatch({ type: "set_caption_style", actor: "human", patch: { size: event.target.value as typeof state.captionStyle.size } })}><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option></select></label><label className="mt-3 flex items-center gap-2 text-[11px] text-[#a6abb4]"><input type="checkbox" checked={state.captionStyle.background} onChange={(event) => dispatch({ type: "set_caption_style", actor: "human", patch: { background: event.target.checked } })} /> Background</label></>}
    <button className="mt-5 w-full cursor-pointer rounded border border-[#713d47] bg-transparent px-2 py-1.5 text-[10px] text-[#ff9aa9]" onClick={() => dispatch({ type: kind === "caption" ? "remove_caption" : "remove_overlay", actor: "human", id: item.id })}>Remove {kind}</button>
  </div>;
}

function MusicInspector({ state, music, onPreview, onCommit, dispatch }: { state: ProjectState; music: MusicClip; onPreview(patch: Partial<MusicClip>): void; onCommit(): void; dispatch(command: CommandInput): ProjectState }) {
  const adjust = (patch: Partial<Pick<MusicClip, "timelineStartMs" | "sourceInMs" | "sourceOutMs" | "volume" | "muted" | "fadeInMs" | "fadeOutMs" | "loop">>) => { onCommit(); return dispatch({ type: "adjust_music", actor: "human", clipId: music.id, patch }); };
  return <div className="px-3.5 pt-3 pb-[30px]"><b className="block overflow-hidden text-xs text-ellipsis whitespace-nowrap">{music.name}</b><small className="text-[9px] text-[var(--muted)]">{formatTime(music.durationMs)} source</small><RangeControl label="Volume" value={music.volume} resetValue={0.3} min={0} max={2} step={0.05} onPreview={(volume) => onPreview({ volume })} onCommit={(volume) => adjust({ volume })} /><RangeControl label="Fade in" value={music.fadeInMs} resetValue={0} min={0} max={Math.min(5000, (music.sourceOutMs - music.sourceInMs) / 2)} step={50} suffix="ms" onCommit={(fadeInMs) => adjust({ fadeInMs })} /><RangeControl label="Fade out" value={music.fadeOutMs} resetValue={0} min={0} max={Math.min(5000, (music.sourceOutMs - music.sourceInMs) / 2)} step={50} suffix="ms" onCommit={(fadeOutMs) => adjust({ fadeOutMs })} /><div className="grid grid-cols-3 gap-1"><label className="text-[9px] text-[var(--muted)]">Start<input className="mt-1 w-full rounded border border-[var(--line)] bg-[#0b0d10] p-1 text-white" type="number" min={0} max={timelineDuration(state) - 50} defaultValue={Math.round(music.timelineStartMs)} key={`start-${music.timelineStartMs}`} onBlur={(event) => adjust({ timelineStartMs: Number(event.target.value) })} /></label><label className="text-[9px] text-[var(--muted)]">In<input className="mt-1 w-full rounded border border-[var(--line)] bg-[#0b0d10] p-1 text-white" type="number" min={0} max={music.sourceOutMs - 50} defaultValue={Math.round(music.sourceInMs)} key={`in-${music.sourceInMs}`} onBlur={(event) => adjust({ sourceInMs: Number(event.target.value) })} /></label><label className="text-[9px] text-[var(--muted)]">Out<input className="mt-1 w-full rounded border border-[var(--line)] bg-[#0b0d10] p-1 text-white" type="number" min={music.sourceInMs + 50} max={music.durationMs} defaultValue={Math.round(music.sourceOutMs)} key={`out-${music.sourceOutMs}`} onBlur={(event) => adjust({ sourceOutMs: Number(event.target.value) })} /></label></div><div className="mt-4 flex items-center gap-3"><label className="flex items-center gap-1 text-[10px]"><input type="checkbox" checked={music.loop} onChange={(event) => adjust({ loop: event.target.checked })} /> Loop</label><label className="flex items-center gap-1 text-[10px]"><input type="checkbox" checked={music.muted} onChange={(event) => adjust({ muted: event.target.checked })} /> Mute</label></div><button className="mt-5 w-full cursor-pointer rounded border border-[#713d47] bg-transparent px-2 py-1.5 text-[10px] text-[#ff9aa9]" onClick={() => dispatch({ type: "remove_music", actor: "human", clipId: music.id })}>Remove music clip</button></div>;
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
  const last = peaks.length - 1;
  const viewStart = clip.sourceInMs / durationMs * last;
  const viewEnd = clip.sourceOutMs / durationMs * last;
  const start = Math.max(0, Math.floor(viewStart) - 1);
  const end = Math.min(peaks.length, Math.ceil(viewEnd) + 2);
  const values = peaks.slice(start, end);
  if (values.length < 2) return null;
  const gain = clip.muted ? 0.08 : clip.volume;
  const amplitude = (peak: number) => Math.min(1, peak * gain) * 0.42;
  const top = values.map((peak, index) => `${start + index},${0.5 - amplitude(peak)}`).join(" L");
  const bottom = values.map((peak, index) => `${start + values.length - index - 1},${0.5 + amplitude(values[values.length - index - 1])}`).join(" L");
  return <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`${viewStart} 0 ${Math.max(0.001, viewEnd - viewStart)} 1`} preserveAspectRatio="none" aria-hidden="true"><path d={`M${top} L${bottom} Z`} fill={clip.muted ? "#829b9620" : "#57b7a43d"} /></svg>;
}

function MusicWaveform({ peaks, music, timelineDurationMs }: { peaks: number[]; music: Pick<MusicClip, "durationMs" | "sourceInMs" | "sourceOutMs" | "volume" | "muted" | "loop">; timelineDurationMs: number }) {
  const sourceDuration = music.sourceOutMs - music.sourceInMs;
  if (peaks.length < 2 || music.durationMs <= 0 || sourceDuration <= 0 || timelineDurationMs <= 0) return null;
  const segments = Array.from({ length: music.loop ? Math.min(500, Math.ceil(timelineDurationMs / sourceDuration)) : 1 }, (_, index) => ({ offsetMs: index * sourceDuration, durationMs: Math.min(sourceDuration, timelineDurationMs - index * sourceDuration) }));
  const last = peaks.length - 1;
  const amplitude = (peak: number) => Math.min(1, peak * (music.muted ? 0.08 : music.volume)) * 0.42;
  return <div className="pointer-events-none absolute inset-0" aria-hidden="true">{segments.map((segment) => {
    const viewStart = music.sourceInMs / music.durationMs * last;
    const viewEnd = (music.sourceInMs + segment.durationMs) / music.durationMs * last;
    const start = Math.max(0, Math.floor(viewStart) - 1);
    const values = peaks.slice(start, Math.min(peaks.length, Math.ceil(viewEnd) + 2));
    const top = values.map((peak, index) => `${start + index},${0.5 - amplitude(peak)}`).join(" L");
    const bottom = values.map((peak, index) => `${start + values.length - index - 1},${0.5 + amplitude(values[values.length - index - 1])}`).join(" L");
    return <svg key={segment.offsetMs} className="absolute top-0 h-full" style={{ left: `${segment.offsetMs / timelineDurationMs * 100}%`, width: `${segment.durationMs / timelineDurationMs * 100}%` }} viewBox={`${viewStart} 0 ${Math.max(0.001, viewEnd - viewStart)} 1`} preserveAspectRatio="none"><path d={`M${top} L${bottom} Z`} fill="#b38cff55" /></svg>;
  })}</div>;
}

function formatTimelineTime(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((part) => String(part).padStart(2, "0")).join(":");
}

type TimelineProps = { state: ProjectState; waveform: number[]; musicWaveform: number[]; musicPreview: { clipId: string; patch: Partial<MusicClip> } | null; snapEnabled: boolean; playheadMs: number; selectedClipId: string; selectedMusicId: string; selectedText: { kind: "caption" | "overlay"; id: string } | null; onSelect(id: string): void; onEditText(kind: "caption" | "overlay", id: string): void; onEditMusic(id: string): void; onClearSelection(): void; onSeek(ms: number): void; dispatch(command: CommandInput): ProjectState; setError(message: string): void };
function Timeline({ state, waveform, musicWaveform, musicPreview, snapEnabled, playheadMs, selectedClipId, selectedMusicId, selectedText, onSelect, onEditText, onEditMusic, onClearSelection, onSeek, dispatch, setError }: TimelineProps) {
  const [moving, setMoving] = useState<{ clipId: string; startMs: number } | null>(null);
  const [trimming, setTrimming] = useState<{ clipId: string; startMs: number; durationMs: number; sourceInMs: number; sourceOutMs: number } | null>(null);
  const [movingText, setMovingText] = useState<{ kind: "caption" | "overlay"; id: string; startMs: number; endMs: number } | null>(null);
  const [movingMusic, setMovingMusic] = useState<{ clipId: string; timelineStartMs: number; sourceInMs: number; sourceOutMs: number } | null>(null);
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
    const observer = new ResizeObserver(() => { setTrackWidth(track.clientWidth); setViewportWidth(Math.max(1, viewport.clientWidth - 10)); });
    observer.observe(track);
    observer.observe(viewport);
    setTrackWidth(track.clientWidth);
    setViewportWidth(Math.max(1, viewport.clientWidth - 10));
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const zoomTimeline = (event: WheelEvent) => {
      if (!event.altKey) {
        if (container.scrollWidth <= container.clientWidth) return;
        event.preventDefault();
        container.scrollLeft += Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        return;
      }
      if (naturalWidth <= 0) return;
      event.preventDefault();
      const rect = container.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const timelineRatio = Math.max(0, Math.min(1, (container.scrollLeft + pointerX) / Math.max(1, trackWidth)));
      const availableWidth = Math.max(1, container.clientWidth - 10);
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
    if (!container || !trackWidth || !total) return;
    const playheadX = playheadMs / total * trackWidth;
    const left = container.scrollLeft;
    const right = left + container.clientWidth - 20;
    if (playheadX < left || playheadX > right) container.scrollLeft = Math.max(0, playheadX - 10);
  }, [playheadMs, total, trackWidth]);
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
  const dragText = (event: React.PointerEvent, kind: "caption" | "overlay", item: TimedText, edge: "move" | "in" | "out") => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const startX = event.clientX;
    const startScroll = scrollRef.current?.scrollLeft ?? 0;
    let result = { kind, id: item.id, startMs: item.startMs, endMs: item.endMs };
    const calculate = (point: { clientX: number }) => {
      const scrollDelta = (scrollRef.current?.scrollLeft ?? 0) - startScroll;
      const delta = (point.clientX - startX + scrollDelta) / Math.max(1, trackWidth) * total;
      const duration = item.endMs - item.startMs;
      if (edge === "move") {
        const startMs = Math.max(0, Math.min(total - duration, item.startMs + delta));
        result = { kind, id: item.id, startMs, endMs: startMs + duration };
      } else if (edge === "in") result = { kind, id: item.id, startMs: Math.max(0, Math.min(item.endMs - 50, item.startMs + delta)), endMs: item.endMs };
      else result = { kind, id: item.id, startMs: item.startMs, endMs: Math.min(total, Math.max(item.startMs + 50, item.endMs + delta)) };
      setMovingText(result);
    };
    const finish = (point: { clientX: number }) => {
      calculate(point); setMovingText(null);
      if (Math.abs(result.startMs - item.startMs) < 1 && Math.abs(result.endMs - item.endMs) < 1) return;
      try { dispatch({ type: kind === "caption" ? "update_caption" : "update_overlay", actor: "human", id: item.id, patch: { startMs: Math.round(result.startMs), endMs: Math.round(result.endMs) } }); }
      catch (cause) { setError((cause as Error).message); }
    };
    trackDrag(event, calculate, finish);
  };
  const dragMusic = (event: React.PointerEvent, music: MusicClip, edge: "move" | "in" | "out") => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const startX = event.clientX;
    const startScroll = scrollRef.current?.scrollLeft ?? 0;
    const result = { timelineStartMs: music.timelineStartMs, sourceInMs: music.sourceInMs, sourceOutMs: music.sourceOutMs };
    const calculate = (point: { clientX: number }) => {
      const scrollDelta = (scrollRef.current?.scrollLeft ?? 0) - startScroll;
      const delta = (point.clientX - startX + scrollDelta) / Math.max(1, trackWidth) * total;
      if (edge === "move") result.timelineStartMs = Math.max(0, Math.min(total - 50, music.timelineStartMs + delta));
      else if (edge === "in") { const change = Math.max(-music.sourceInMs, Math.min(music.sourceOutMs - music.sourceInMs - 50, delta)); result.sourceInMs = music.sourceInMs + change; result.timelineStartMs = Math.max(0, music.timelineStartMs + change); }
      else result.sourceOutMs = Math.min(music.durationMs, Math.max(music.sourceInMs + 50, music.sourceOutMs + delta));
      setMovingMusic({ clipId: music.id, ...result });
    };
    const finish = (point: { clientX: number }) => {
      calculate(point); setMovingMusic(null);
      if (Math.abs(result.timelineStartMs - music.timelineStartMs) < 1 && Math.abs(result.sourceInMs - music.sourceInMs) < 1 && Math.abs(result.sourceOutMs - music.sourceOutMs) < 1) return;
      try { dispatch({ type: "adjust_music", actor: "human", clipId: music.id, patch: { timelineStartMs: Math.round(result.timelineStartMs), sourceInMs: Math.round(result.sourceInMs), sourceOutMs: Math.round(result.sourceOutMs), ...(edge === "out" ? { loop: false } : {}) } }); }
      catch (cause) { setError((cause as Error).message); }
    };
    trackDrag(event, calculate, finish);
  };
  const dragPlayhead = (event: React.PointerEvent) => {
    if (event.button !== 0 || !trackRef.current) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const update = (point: { clientX: number; altKey: boolean }) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      let target = Math.max(0, Math.min(total, (point.clientX - rect.left) / rect.width * total));
      if (snapEnabled !== point.altKey) {
        const threshold = 8 / rect.width * total;
        const targets = [0, total, ...entries.flatMap((entry) => [entry.startMs, entry.endMs]), ...state.captions.flatMap((item) => [item.startMs, item.endMs]), ...state.overlays.flatMap((item) => [item.startMs, item.endMs]), ...state.music.flatMap((item) => [item.timelineStartMs, musicClipEnd(state, item)])];
        const closest = targets.reduce((best, value) => Math.abs(value - target) < Math.abs(best - target) ? value : best, targets[0]);
        if (Math.abs(closest - target) <= threshold) target = closest;
      }
      onSeek(target);
    };
    update(event);
    trackDrag(event, update, update);
  };
  const lanes = { S1: { top: 0, height: 14 }, V2: { top: 14, height: 16 }, V1: { top: 30, height: 24 }, A1: { top: 54, height: 24 }, A2: { top: 78, height: 22 } } as const;
  return <div className="relative min-h-0 min-w-0 w-full overflow-hidden"><div className="pointer-events-none absolute top-[21px] bottom-[18px] left-0 z-[8] w-[46px] overflow-hidden rounded-l-[5px]">{(Object.entries(lanes) as Array<[keyof typeof lanes, { top: number; height: number }]>).map(([label, lane]) => <div key={label} className="absolute left-0 grid w-full place-items-center border-r border-[#343a44] bg-[#111419] font-mono text-[8px] text-[#8a919c]" style={{ top: `${lane.top}%`, height: `${lane.height}%` }}>{label}</div>)}</div><div ref={scrollRef} className="relative ml-[46px] h-full min-h-0 w-[calc(100%_-_46px)] min-w-0 select-none overflow-auto pt-[21px] pr-2.5 pb-2"><div ref={trackRef} className="timeline-track relative h-full min-h-[90px] min-w-full rounded-[5px] [background:repeating-linear-gradient(90deg,#15181d_0,#15181d_139px,#1d2127_140px)]" style={{ width }} onClick={onClearSelection}>
    <div className="absolute -top-[21px] left-0 z-[6] h-[21px] w-full overflow-hidden text-[8px] font-mono text-[#7f8590]" style={{ backgroundImage: "linear-gradient(to right, #3a4049 1px, transparent 1px)", backgroundSize: `${minorWidth}px 6px`, backgroundPosition: "left bottom", backgroundRepeat: "repeat-x" }}>
      {rulerMarks.map((time) => <span key={time} className="pointer-events-none absolute bottom-1 h-[17px] border-l border-[#68707c] pl-1 leading-none" style={{ left: `${time / total * 100}%` }}>{formatTimelineTime(time)}</span>)}
      <button type="button" aria-label="Scrub timeline" title="Click or drag to scrub" tabIndex={-1} className="absolute inset-0 size-full touch-none cursor-ew-resize select-none border-0 bg-transparent p-0 outline-none" onClick={(event) => event.stopPropagation()} onPointerDown={dragPlayhead} />
    </div>
    <div className="pointer-events-none absolute -top-[18px] -bottom-2.5 z-[7] w-0" style={{ left: `${Math.max(0, Math.min(total, playheadMs)) / Math.max(1, total) * 100}%` }}><svg className="absolute -left-2.5 top-0 h-full w-5 overflow-visible" aria-hidden="true"><line x1="10" x2="10" y1="0" y2="100%" stroke="var(--orange)" strokeWidth="1" shapeRendering="crispEdges" /><path d="M10 0 L17 7 L10 14 L3 7 Z" fill="var(--orange)" /></svg><button type="button" aria-label="Drag playhead" title="Drag playhead" tabIndex={-1} className="pointer-events-auto absolute top-0 left-0 inline-flex size-5 -translate-x-1/2 touch-none cursor-ew-resize select-none border-0 bg-transparent p-0 outline-none" onClick={(event) => event.stopPropagation()} onPointerDown={dragPlayhead} /></div>
    {state.captions.map((item) => { const draft = movingText?.kind === "caption" && movingText.id === item.id ? movingText : item; return <div key={item.id} className={`group absolute z-[2] flex touch-none items-end overflow-hidden rounded border bg-[#6d5d1dcc] px-2 pb-1 text-[9px] leading-none text-[#fff2b3] ${selectedText?.kind === "caption" && selectedText.id === item.id ? "border-[var(--lime)] ring-1 ring-[var(--lime)]" : "border-[#d5b84a]"}`} style={{ top: `${lanes.S1.top}%`, height: `${lanes.S1.height}%`, left: `${draft.startMs / total * 100}%`, width: `${(draft.endMs - draft.startMs) / total * 100}%` }} onPointerDown={(event) => { onEditText("caption", item.id); dragText(event, "caption", item, "move"); }} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => { event.stopPropagation(); onEditText("caption", item.id); }}><button className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize border-0 bg-[#ffe066aa] p-0 opacity-0 group-hover:opacity-100" aria-label="Trim caption start" onPointerDown={(event) => dragText(event, "caption", item, "in")} /><span className="block overflow-hidden text-ellipsis whitespace-nowrap">{item.text}</span><button className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize border-0 bg-[#ffe066aa] p-0 opacity-0 group-hover:opacity-100" aria-label="Trim caption end" onPointerDown={(event) => dragText(event, "caption", item, "out")} /></div>; })}
    {state.overlays.map((item) => { const draft = movingText?.kind === "overlay" && movingText.id === item.id ? movingText : item; return <div key={item.id} className={`group absolute z-[2] flex touch-none items-end overflow-hidden rounded border bg-[#243f69dd] px-2 pb-1 text-[9px] leading-none text-[#cde0ff] ${selectedText?.kind === "overlay" && selectedText.id === item.id ? "border-[var(--lime)] ring-1 ring-[var(--lime)]" : "border-[#5b8bd9]"}`} style={{ top: `${lanes.V2.top}%`, height: `${lanes.V2.height}%`, left: `${draft.startMs / total * 100}%`, width: `${(draft.endMs - draft.startMs) / total * 100}%` }} onPointerDown={(event) => { onEditText("overlay", item.id); dragText(event, "overlay", item, "move"); }} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => { event.stopPropagation(); onEditText("overlay", item.id); }}><button className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize border-0 bg-[#7aa8ffaa] p-0 opacity-0 group-hover:opacity-100" aria-label="Trim text start" onPointerDown={(event) => dragText(event, "overlay", item, "in")} /><span className="block overflow-hidden text-ellipsis whitespace-nowrap">{item.text}</span><button className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize border-0 bg-[#7aa8ffaa] p-0 opacity-0 group-hover:opacity-100" aria-label="Trim text end" onPointerDown={(event) => dragText(event, "overlay", item, "out")} /></div>; })}
    {entries.map(({ clip, startMs, durationMs }, index) => <div key={clip.id} className="group absolute z-[2] touch-none cursor-grab active:cursor-grabbing" style={{ top: `${lanes.V1.top}%`, height: `${lanes.V1.height}%`, left: `${((moving?.clipId === clip.id ? moving.startMs : trimming?.clipId === clip.id ? trimming.startMs : startMs) / total) * 100}%`, width: `${((trimming?.clipId === clip.id ? trimming.durationMs : durationMs) / total) * 100}%` }} onPointerDown={(event) => { onSelect(clip.id); moveClip(event, clip); }} onClick={(event) => event.stopPropagation()}>
      <button data-trim-handle className={`absolute top-0 left-0 z-[3] h-full w-[9px] cursor-ew-resize rounded-l border-0 bg-[var(--lime)] ${selectedClipId === clip.id ? "opacity-[.85]" : "opacity-0 group-hover:opacity-[.85]"}`} aria-label="Trim linked clip start" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => trim(event, clip, "in")} />
      <div className={`relative flex size-full items-end gap-2 overflow-hidden bg-gradient-to-br from-[#293341] to-[#1d252f] px-2.5 pb-1.5 ${index === 0 ? "rounded-l-[5px]" : ""} ${index === entries.length - 1 ? "rounded-r-[5px]" : ""} ${selectedClipId === clip.id ? "shadow-[inset_0_0_0_1px_var(--lime)]" : ""}`}><span className="font-mono text-[10px] text-[#c0c6cf]">{formatTime(trimming?.clipId === clip.id ? trimming.durationMs : durationMs)}</span>{clip.transition.type !== "cut" && <i className="ml-auto whitespace-nowrap text-[8px] not-italic text-[var(--orange)]">{clip.transition.type}</i>}</div>
      <button data-trim-handle className={`absolute top-0 right-0 z-[3] h-full w-[9px] cursor-ew-resize rounded-r border-0 bg-[var(--lime)] ${selectedClipId === clip.id ? "opacity-[.85]" : "opacity-0 group-hover:opacity-[.85]"}`} aria-label="Trim linked clip end" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => trim(event, clip, "out")} />
    </div>)}
    {entries.map(({ clip, startMs, durationMs }) => <div key={`audio-${clip.id}`} className={`absolute z-[1] overflow-hidden rounded bg-[#18302f] ${selectedClipId === clip.id ? "shadow-[inset_0_0_0_1px_var(--lime)]" : ""}`} style={{ top: `${lanes.A1.top}%`, height: `${lanes.A1.height}%`, left: `${((moving?.clipId === clip.id ? moving.startMs : trimming?.clipId === clip.id ? trimming.startMs : startMs) / total) * 100}%`, width: `${((trimming?.clipId === clip.id ? trimming.durationMs : durationMs) / total) * 100}%` }} onClick={(event) => { event.stopPropagation(); onSelect(clip.id); }}><AudioWaveform peaks={waveform} clip={trimming?.clipId === clip.id ? { ...clip, sourceInMs: trimming.sourceInMs, sourceOutMs: trimming.sourceOutMs } : clip} durationMs={state.durationMs} />{clip.muted ? <VolumeX className="absolute top-1/2 right-2 size-3 -translate-y-1/2 text-[#829b96]" aria-hidden="true" /> : <Volume2 className="absolute top-1/2 right-2 size-3 -translate-y-1/2 text-[#76c7b7]" aria-hidden="true" />}</div>)}
    {state.music.map((music) => { const previewed = musicPreview?.clipId === music.id ? { ...music, ...musicPreview.patch } : music; const draft = movingMusic?.clipId === music.id ? { ...previewed, ...movingMusic } : previewed; const end = musicClipEnd(state, draft); return <div key={music.id} className={`group absolute z-[2] flex touch-none cursor-grab items-end overflow-hidden rounded border bg-[#342450dd] ${selectedMusicId === music.id ? "border-[var(--lime)]" : "border-[#805fc0]"}`} style={{ top: `${lanes.A2.top}%`, height: `${lanes.A2.height}%`, left: `${draft.timelineStartMs / total * 100}%`, width: `${Math.max(0, end - draft.timelineStartMs) / total * 100}%` }} onPointerDown={(event) => { onEditMusic(music.id); dragMusic(event, music, "move"); }} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => { event.stopPropagation(); onEditMusic(music.id); }}><button className="absolute inset-y-0 left-0 z-[2] w-2 cursor-ew-resize border-0 bg-[#b38cffaa] p-0 opacity-0 group-hover:opacity-100" aria-label="Trim music start" onPointerDown={(event) => dragMusic(event, music, "in")} /><MusicWaveform peaks={musicWaveform} music={draft} timelineDurationMs={Math.max(0, end - draft.timelineStartMs)} /><span className="relative z-[1] mb-1 px-2 text-[9px] leading-none text-[#e1d2ff] text-shadow-[0_1px_2px_#000]">{music.name}{music.loop ? " · loop" : ""}</span><button className="absolute inset-y-0 right-0 z-[2] w-2 cursor-ew-resize border-0 bg-[#b38cffaa] p-0 opacity-0 group-hover:opacity-100" aria-label="Trim music end" onPointerDown={(event) => dragMusic(event, music, "out")} /></div>; })}
  </div></div></div>;
}

function TranscriptPanel({ state, transcript, playheadMs, dispatch, transcribeVideo, automaticStatus, seekTimeline, setError }: { state: ProjectState; transcript: TranscriptWord[]; playheadMs: number; dispatch(command: CommandInput): ProjectState; transcribeVideo(actor?: "human" | "agent", provider?: "cloudflare" | "openai", apiKey?: string, onProgress?: (message: string) => void): Promise<ProjectState>; automaticStatus: string; seekTimeline(ms: number): void; setError(message: string): void }) {
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
      for (let index = 0; index < words.length; index += 5) {
        const group = words.slice(index, index + 5);
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
        <button className="cursor-pointer whitespace-nowrap rounded-[7px] border-0 bg-[var(--lime)] px-[13px] py-2 text-xs font-extrabold text-[#10120d] hover:bg-[#e5ff93]" disabled={!!processing || !!automaticStatus || provider === "openai" && !apiKey} onClick={() => void transcribe()} aria-live="polite">{automaticStatus || processing || "Transcribe video"}</button>
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
  const [text, setText] = useState("");
  const add = () => {
    if (!text.trim()) return;
    dispatch({ type: "add_overlay", actor: "human", item: { text: text.trim(), startMs: playheadMs, endMs: Math.min(timelineDuration(state), playheadMs + 3000), position: "center", fontSize: 54, color: "white", background: true } });
    setText("");
  };
  return <form className="flex min-h-12 items-center gap-2 p-3" onSubmit={(event) => { event.preventDefault(); add(); }}>
    <input autoFocus className="min-w-[180px] flex-1 rounded-md border border-[var(--line)] bg-[#0b0d10] px-3 py-2 text-[11px] text-white" aria-label="Text content" placeholder="Enter text…" value={text} onChange={(event) => setText(event.target.value)} />
    <button type="submit" disabled={!text.trim()} className="cursor-pointer whitespace-nowrap rounded-md border-0 bg-[var(--lime)] px-3 py-2 text-[10px] font-bold text-[#10120d]">Add at {formatTime(playheadMs)}</button>
  </form>;
}

function MusicPanel({ projectId, state, dispatch, setError }: { projectId: string; state: ProjectState; dispatch(command: CommandInput): ProjectState; setError(message: string): void }) {
  const [uploading, setUploading] = useState(false);
  const upload = async (file?: File) => {
    if (!file) return;
    setUploading(true); setError("");
    const url = URL.createObjectURL(file);
    try {
      const durationMs = await new Promise<number>((resolve, reject) => { const audio = new Audio(url); audio.onloadedmetadata = () => resolve(Math.round(audio.duration * 1000)); audio.onerror = () => reject(new Error("Could not read audio duration")); });
      const form = new FormData(); form.set("music", file);
      const response = await fetch(`/api/projects/${projectId}/music`, { method: "POST", body: form });
      const result = await response.json() as { id?: string; error?: string };
      if (!response.ok || !result.id) throw new Error(result.error || "Music upload failed");
      dispatch({ type: "set_music", actor: "human", music: { assetId: result.id, name: file.name, durationMs, timelineStartMs: 0, sourceInMs: 0, sourceOutMs: durationMs, volume: 0.3, muted: false, fadeInMs: 500, fadeOutMs: 500, loop: durationMs < timelineDuration(state) } });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Music upload failed"); }
    finally { URL.revokeObjectURL(url); setUploading(false); }
  };
  if (state.music.length) return <p className="m-0 p-8 text-center text-xs text-[var(--muted)]">Music is imported. Select an A2 clip on the timeline to adjust it in the Inspector.</p>;
  return <div className="grid place-items-center gap-3 p-8 text-center"><p className="m-0 text-xs text-[var(--muted)]">Import one background-music file to the A2 track.</p><label className="cursor-pointer rounded-[7px] bg-[var(--lime)] px-4 py-2 text-xs font-extrabold text-[#10120d]">{uploading ? "Uploading…" : "Choose music"}<input className="hidden" type="file" accept="audio/*" disabled={uploading} onChange={(event) => void upload(event.target.files?.[0])} /></label></div>;
}

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
