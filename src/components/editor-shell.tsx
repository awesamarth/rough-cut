"use client";

import { useTimelineSnapping } from "./use-timeline-snapping";
import { blocksEditorShortcuts } from "@/lib/editor-shortcuts";
import { Magnet, Pause, Play } from "lucide-react";

import { Modal, modalActionClass, modalCancelClass, useConfirmation } from "./modal";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { analyzeAudio } from "@/lib/browser-audio";
import { silenceCandidates, waveformPeaks, type AudioAnalysis } from "@/lib/audio-analysis";
import { exportSrt, timelineDuration, timelineToSource, type MusicClip, type ProjectState, type TimedText } from "@/lib/editor";
import { clampInspectorWidth, INSPECTOR_MIN_WIDTH, INSPECTOR_MAX_WIDTH } from "@/lib/panel-layout";
import { exportEdl } from "@/lib/edl";
import { boundHistory, getLocalProject, type MediaDescription } from "@/lib/local-store";
import { cancelCloudOutput, cloudOutputUrl, requestCloudOutput, type CloudOutputSession } from "@/lib/cloud-output-client";
import { exportByteEstimate, runExportWorker, localExport, mp4Filename, removeTemporaryExport, type ReadyExport } from "@/lib/local-export";
import { estimateExportStorage, shouldOfferCloudRetry } from "@/lib/export-destination";
import { ensureOutputEncoding, inspectInput } from "@/lib/codec-support";
import type { MediaSource } from "@/lib/video-renderer";
import { ExportLibrary } from "./export-library";
import { useEditor, type CommandInput } from "./use-editor";
import { useMediaAssets } from "./use-media-assets";
import { useTimelinePlayer } from "./use-timeline-player";
import { useTranscription } from "./use-transcription";
import { useWebMCP } from "./use-webmcp";
import { ActivityPanel, ClipInspector, MusicInspector, MusicPanel, SilencePanel, TextInspector, TextPanel, Timeline, TranscriptPanel } from "./editor";

function downloadText(name: string, value: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
const timecode = (ms: number) => `${Math.floor(ms / 60_000).toString().padStart(2, "0")}:${Math.floor(ms / 1000 % 60).toString().padStart(2, "0")}.${Math.floor(ms % 1000).toString().padStart(3, "0")}`;
const button = "cursor-pointer rounded-md border border-[var(--line)] bg-[var(--panel-2)] px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-40";

export function Editor({ projectId }: { projectId: string }) {
  const editor = useEditor(projectId);
  const { state, project, transcript, setError, durability, dispatch: editDispatch, undo, redo } = editor;
  const media = useMediaAssets(projectId, project ? !!project.local : undefined, state?.music.map((item) => item.assetId) ?? []);
  const [selectedClipId, setSelectedClip] = useState("");
  const [selectedMusicId, setSelectedMusic] = useState("");
  const [selectedText, setSelectedText] = useState<{ kind: "caption" | "overlay"; id: string } | null>(null);
  const initiallySelectedProject = useRef<string | null>(null);
  const firstClipId = state?.clips[0]?.id;
  useEffect(() => {
    if (project?.id !== projectId || !firstClipId || initiallySelectedProject.current === projectId) return;
    initiallySelectedProject.current = projectId;
    setSelectedClip(firstClipId); setSelectedMusic(""); setSelectedText(null);
  }, [project?.id, projectId, firstClipId]);
  const [textPreview, setTextPreview] = useState<{ id: string; kind: "caption" | "overlay"; patch: Partial<TimedText> } | null>(null);
  const [musicPreview, setMusicPreview] = useState<{ clipId: string; patch: Partial<MusicClip> } | null>(null);
  const [captionOpacity, setCaptionOpacity] = useState<number | null>(null);
  const [tab, setTab] = useState<"transcript" | "text" | "music" | "silence" | "activity" | "markers" | "exports">("transcript");
  const [requestedMusic, setRequestedMusic] = useState(false);
  const [webmcp, setWebmcp] = useState("Preparing");
  const [bladeMode, setBladeMode] = useState(false);
  const snapping = useTimelineSnapping();
  const snap = snapping.enabled;
  const { confirm, prompt, confirmation } = useConfirmation();
  const [exportDialog, setExportDialog] = useState(false);
  const [exportName, setExportName] = useState("");
  const [timelineHeight, setTimelineHeight] = useState(310);
  const [lowerHeight, setLowerHeight] = useState(230);
  const [inspectorWidth, setInspectorWidth] = useState(270);
  const previewPane = useRef<HTMLElement>(null);
  const resizeCleanup = useRef(() => {});
  useEffect(() => () => resizeCleanup.current(), []);
  const resizePanels = (edge: "top" | "bottom", delta: number, timeline = timelineHeight, lower = lowerHeight, previewHeight = previewPane.current?.clientHeight ?? 160) => {
    if (edge === "top") setTimelineHeight(Math.max(160, Math.min(timeline + previewHeight - 160, timeline - delta)));
    else {
      const height = Math.max(160, Math.min(timeline + lower - 120, timeline + delta));
      setTimelineHeight(height); setLowerHeight(timeline + lower - height);
    }
  };
  const resizeInspector = (width: number) => setInspectorWidth(clampInspectorWidth(width, previewPane.current?.clientWidth ?? 900));
  const startResize = (edge: "top" | "bottom" | "inspector", event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault(); resizeCleanup.current();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const x = event.clientX, y = event.clientY, inspector = inspectorWidth, timeline = timelineHeight, lower = lowerHeight, previewHeight = previewPane.current?.clientHeight ?? 160;
    const cursor = document.body.style.cursor, selection = document.body.style.userSelect;
    document.body.style.setProperty("cursor", edge === "inspector" ? "col-resize" : "row-resize"); document.body.style.setProperty("user-select", "none");
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== event.pointerId) return;
      if (edge === "inspector") resizeInspector(inspector - (pointer.clientX - x));
      else resizePanels(edge, pointer.clientY - y, timeline, lower, previewHeight);
    };
    const finish = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish); window.removeEventListener("blur", finish); window.removeEventListener("resize", finish);
      handle.removeEventListener("lostpointercapture", finish);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      document.body.style.setProperty("cursor", cursor); document.body.style.setProperty("user-select", selection);
      resizeCleanup.current = () => {};
    };
    resizeCleanup.current = finish;
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", finish); window.addEventListener("blur", finish); window.addEventListener("resize", finish);
    handle.addEventListener("lostpointercapture", finish);
  };
  const splitter = (edge: "top" | "bottom") => <button type="button" role="separator" aria-orientation="horizontal" aria-label={edge === "top" ? "Resize preview and timeline" : "Resize timeline and transcript"} aria-valuenow={Math.round(timelineHeight)} title="Drag to resize" className="group absolute -top-1 left-0 z-20 h-2 w-full touch-none cursor-row-resize border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-[var(--lime)]" onPointerDown={(event) => startResize(edge, event)} onKeyDown={(event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault(); resizePanels(edge, (event.key === "ArrowUp" ? -1 : 1) * (event.shiftKey ? 40 : 10));
  }}><span className="absolute top-1/2 left-0 h-px w-full bg-[var(--line)] group-hover:bg-[var(--lime)]" /></button>;
  const [waveform, setWaveform] = useState<number[]>([]);
  const [musicWaveform, setMusicWaveform] = useState<number[]>([]);
  const analysis = useRef<Promise<AudioAnalysis> | null>(null);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const exportController = useRef<AbortController | null>(null);
  const exportMounted = useRef(true);
  const [ready, setReady] = useState<(ReadyExport & { file: File; url: string }) | null>(null);
  const [cloudReady, setCloudReady] = useState<CloudOutputSession | null>(null);
  const readyButton = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`rough-cut.cloud-output:${projectId}`) || "null");
      setCloudReady(saved && /^[a-f0-9-]{36}$/.test(saved.id) && typeof saved.filename === "string" && saved.expiresAt > Date.now() ? saved : null);
    } catch { setCloudReady(null); }
  }, [projectId]);
  const stage = useRef<HTMLDivElement>(null);

  const preview = useMemo(() => {
    if (!state || !textPreview && !musicPreview && captionOpacity === null) return state;
    return { ...state,
      captions: state.captions.map((item) => textPreview?.kind === "caption" && item.id === textPreview.id ? { ...item, ...textPreview.patch } : item),
      overlays: state.overlays.map((item) => textPreview?.kind === "overlay" && item.id === textPreview.id ? { ...item, ...textPreview.patch } : item),
      music: state.music.map((item) => musicPreview?.clipId === item.id ? { ...item, ...musicPreview.patch } : item),
      captionStyle: captionOpacity === null ? state.captionStyle : { ...state.captionStyle, backgroundOpacity: captionOpacity },
    };
  }, [state, textPreview, musicPreview, captionOpacity]);
  const player = useTimelinePlayer(preview, media.source, media.music, setError);
  const { seekTimeline, togglePlayback, playheadMs, isPlaying } = player;
  const transcription = useTranscription(projectId, media.source, editor.stateRef, editor.transcriptRef, editor.saveTranscript, durability, !!state, setError);
  const total = state ? timelineDuration(state) : 0;
  const initialize = editor.initialize;
  useEffect(() => {
    if (!project || state || !media.source) return;
    const source = media.source;
    let canceled = false;
    const controller = new AbortController();
    let input: import("mediabunny").Input | undefined;
    void import("mediabunny").then(async ({ Input, BlobSource, UrlSource, ALL_FORMATS }) => {
      if (canceled) return;
      input = new Input({ source: typeof source === "string" ? new UrlSource(source) : new BlobSource(source), formats: ALL_FORMATS });
      const { durationMs: duration } = await inspectInput(input, "source", controller.signal);
      if (!canceled) initialize(duration);
    }).catch((cause) => { if (!canceled) setError(String(cause)); }).finally(() => input?.dispose());
    return () => { canceled = true; controller.abort(new DOMException("Editor closed", "AbortError")); input?.dispose(); };
  }, [project, state, media.source, initialize, setError]);

  useEffect(() => {
    if (!media.source) return;
    const controller = new AbortController();
    const work = analyzeAudio(media.source, `${projectId}:source`, controller.signal);
    analysis.current = work;
    void work.then((value) => { if (!controller.signal.aborted) setWaveform(waveformPeaks(value)); }).catch((error) => { if (!controller.signal.aborted) setError(String(error)); });
    return () => { analysis.current = null; controller.abort(); };
  }, [media.source, projectId, setError]);
  const musicId = state?.music[0]?.assetId;
  const musicSource = musicId ? media.music[musicId] : undefined;
  useEffect(() => {
    if (!musicSource) { setMusicWaveform([]); return; }
    const controller = new AbortController();
    void analyzeAudio(musicSource, `${projectId}:${musicId}`, controller.signal).then((value) => { if (!controller.signal.aborted) setMusicWaveform(waveformPeaks(value)); }).catch((error) => { if (!controller.signal.aborted) setError(String(error)); });
    return () => controller.abort();
  }, [musicSource, musicId, projectId, setError]);
  const detectSilences = useCallback(async (threshold = -35, minimum = 500) => {
    if (!analysis.current) throw new Error("Source analysis is not ready");
    return silenceCandidates(await analysis.current, threshold, minimum);
  }, []);
  const dispatch = editDispatch;
  const human = useCallback((command: CommandInput) => { try { dispatch(command); } catch (error) { setError(String(error)); } }, [dispatch, setError]);
  const clearSelection = () => { setSelectedClip(""); setSelectedMusic(""); setSelectedText(null); };
  const selectClip = (id: string) => { clearSelection(); setSelectedClip(id); };
  const selectMusic = (id: string) => { clearSelection(); setSelectedMusic(id); setTab("music"); };
  const selectText = (kind: "caption" | "overlay", id: string) => { clearSelection(); setSelectedText({ kind, id }); setTab("text"); };

  const assertExportSnapshot = useCallback((snapshot: ProjectState) => {
    if (snapshot !== editor.stateRef.current) throw new Error("Project changed while choosing the export destination. Please start the export again.");
  }, [editor.stateRef]);
  const renderLocalExport = useCallback(async (snapshot: ProjectState, source: MediaSource, music: Record<string, MediaSource>, filename: string, controller: AbortController, destination?: FileSystemFileHandle) => {
    controller.signal.throwIfAborted();
    assertExportSnapshot(snapshot);
    await durability();
    controller.signal.throwIfAborted();
    assertExportSnapshot(snapshot);
    const result = await localExport(snapshot, source, music, filename, controller.signal, (progress) => { if (exportMounted.current) setExportProgress(progress); }, destination);
    controller.signal.throwIfAborted();
    const file = new File([await result.handle.getFile()], filename, { type: "video/mp4" });
    controller.signal.throwIfAborted();
    if (!exportMounted.current) return { status: "canceled", project_version: snapshot.version, filename, message: "Editor closed before export handoff." };
    setReady({ ...result, file, url: URL.createObjectURL(file) });
    requestAnimationFrame(() => readyButton.current?.focus());
    return { status: result.savedDirectly ? "saved" : "human_action_required", project_version: snapshot.version, filename, message: result.savedDirectly ? "MP4 saved to the chosen file." : "MP4 rendered locally. Ask the human to click Download MP4. Nothing was uploaded." };
  }, [assertExportSnapshot, durability]);
  const renderCloudExport = useCallback(async (snapshot: ProjectState, source: MediaSource, music: Record<string, MediaSource>, filename: string, controller: AbortController) => {
    controller.signal.throwIfAborted();
    assertExportSnapshot(snapshot);
    await durability();
    controller.signal.throwIfAborted();
    assertExportSnapshot(snapshot);
    let session: CloudOutputSession | undefined;
    try {
      // Reserve cloud output only after checking the canonical local encoders.
      await ensureOutputEncoding(controller.signal);
      controller.signal.throwIfAborted();
      assertExportSnapshot(snapshot);
      session = await requestCloudOutput(filename, exportByteEstimate(snapshot), controller.signal);
      await runExportWorker(snapshot, source, music, { cloud: session }, controller.signal, (progress) => { if (exportMounted.current) setExportProgress(progress); });
      controller.signal.throwIfAborted();
      if (!exportMounted.current) throw new DOMException("Editor closed", "AbortError");
      setCloudReady(session);
      try { localStorage.setItem(`rough-cut.cloud-output:${projectId}`, JSON.stringify(session)); }
      catch { setError("Cloud MP4 is ready, but its private link could not be remembered. Download it before leaving this page."); }
    } catch (error) {
      let cleanupFailed = false;
      if (session) try { await cancelCloudOutput(session); } catch { cleanupFailed = true; }
      if (cleanupFailed) throw new Error(`${String(error)} Cloud cleanup could not be confirmed; the configured lifecycle remains the cleanup backstop.`, { cause: error });
      throw error;
    }
  }, [assertExportSnapshot, durability, projectId, setError]);
  const exportMp4 = useCallback(async () => {
    const snapshot = editor.stateRef.current, source = media.source, music = media.music;
    if (!snapshot || !source) throw new Error("Select the source file before exporting");
    if (exportController.current) throw new Error("An export is already running");
    if (Object.keys(music).length < new Set(snapshot.music.map((item) => item.assetId)).size) throw new Error("Relink music before exporting");
    const controller = new AbortController(); exportController.current = controller; setExportProgress(0);
    try { return await renderLocalExport(snapshot, source, music, mp4Filename(snapshot.name), controller); }
    finally { if (exportController.current === controller) exportController.current = null; if (exportMounted.current) setExportProgress(null); }
  }, [editor.stateRef, media.source, media.music, renderLocalExport]);
  const cloudConsent = useCallback((maxBytes: number, retry: boolean) => confirm(`Browser storage ${retry ? "could not complete the local copy; any incomplete copy was removed" : "does not have enough available space"} for this export. Continue by rendering on this device and uploading up to ${Math.ceil(maxBytes / 1024 / 1024)} MiB of encoded MP4 output to temporary cloud storage? Original media and project data stay on this device. Access lasts 24 hours on this browser (up to 10 download requests), and stored chunks expire under a two-day lifecycle, though deletion may be delayed. Daily and per-output limits apply. This does not fix unsupported codecs and will not retry automatically.`, retry ? "Retry with temporary cloud storage?" : "Use temporary cloud storage?", "Continue"), [confirm]);
  const backupProject = async (pending = false) => {
    if (!pending) await durability();
    const snapshot = editor.stateRef.current;
    const words = editor.transcriptRef.current;
    if (!snapshot || !project) throw new Error("Project is not ready");
    let document = await getLocalProject(projectId);
    if (!document) {
      const musicAssets: Record<string, MediaDescription> = {};
      for (const clip of snapshot.music) {
        if (musicAssets[clip.assetId]) continue;
        const response = await fetch(`/api/projects/${projectId}/music?asset=${encodeURIComponent(clip.assetId)}`, { method: "HEAD" });
        const size = Number(response.headers.get("content-length"));
        if (!response.ok || !Number.isSafeInteger(size) || size <= 0) throw new Error("Could not read legacy music metadata for backup");
        musicAssets[clip.assetId] = { name: clip.name, type: response.headers.get("content-type") || "audio/mpeg", size, lastModified: null };
      }
      document = { id: projectId, state: snapshot, transcript: words, source: { name: project.sourceName, type: project.sourceType, size: project.sourceSize, lastModified: null }, musicAssets, past: [], future: [], updatedAt: new Date().toISOString() };
    }
    const value = pending ? { ...document, state: snapshot, transcript: words, past: [], future: [] } : { ...document, ...boundHistory(document.past, document.future) };
    downloadText(`${snapshot.name}${pending ? "-pending" : ""}.rough-cut.json`, JSON.stringify(value), "application/json");
  };
  const startExport = async () => {
    const name = exportName.trim();
    if (!name || /[\\/]/.test(name) || exportController.current) return;
    const snapshot = editor.stateRef.current, source = media.source, music = media.music;
    if (!snapshot || !source) { setError("Select the source file before exporting"); return; }
    if (Object.keys(music).length < new Set(snapshot.music.map((item) => item.assetId)).size) { setError("Relink music before exporting"); return; }
    const filename = mp4Filename(name);
    const controller = new AbortController(); exportController.current = controller; setExportProgress(0); setExportDialog(false);
    try {
      const picker = (window as Window & { showSaveFilePicker?: (options: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
      if (picker) {
        // Keep this call in the form submit's user gesture. Canceling the picker ends the flow.
        const handle = await picker.call(window, { suggestedName: filename, types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }] });
        await renderLocalExport(snapshot, source, music, filename, controller, handle);
        return;
      }
      const maxBytes = exportByteEstimate(snapshot);
      const decision = await estimateExportStorage(maxBytes, () => navigator.storage.estimate());
      controller.signal.throwIfAborted();
      assertExportSnapshot(snapshot);
      if (decision === "cloud-consent") {
        if (await cloudConsent(maxBytes, false)) { assertExportSnapshot(snapshot); await renderCloudExport(snapshot, source, music, filename, controller); }
        return;
      }
      try { await renderLocalExport(snapshot, source, music, filename, controller); }
      catch (error) {
        if (!shouldOfferCloudRetry(error, true)) throw error;
        controller.signal.throwIfAborted();
        if (await cloudConsent(maxBytes, true)) { assertExportSnapshot(snapshot); await renderCloudExport(snapshot, source, music, filename, controller); }
      }
    } catch (error) {
      if (exportMounted.current && !(error instanceof DOMException && error.name === "AbortError")) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (exportController.current === controller) exportController.current = null;
      if (exportMounted.current) setExportProgress(null);
    }
  };
  useEffect(() => {
    exportMounted.current = true;
    return () => { exportMounted.current = false; exportController.current?.abort(new DOMException("Editor closed", "AbortError")); };
  }, []);
  useEffect(() => () => { if (ready) URL.revokeObjectURL(ready.url); }, [ready]);
  const inspectFrame = player.inspectFrame;
  const exportEdlFile = useCallback(() => { const current = editor.stateRef.current; if (!current) throw new Error("Not ready"); const text = exportEdl(current); downloadText(`${current.name}.edl`, text); return text; }, [editor.stateRef]);
  const exportSrtFile = useCallback(() => { const current = editor.stateRef.current; if (!current) throw new Error("Not ready"); const text = exportSrt(current); downloadText(`${current.name}.srt`, text, "application/x-subrip"); return text; }, [editor.stateRef]);
  useWebMCP({ ready: !!state, mediaReady: !!media.source && !!state && state.music.every((item) => !!media.music[item.assetId]), stateRef: editor.stateRef, transcriptRef: editor.transcriptRef, dispatch, durability, undo: editor.undo, redo: editor.redo, seekTimeline, inspectFrame, detectSilences,
    transcribeVideo: (actor, version) => transcription.run(actor, "cloudflare", "", undefined, version), exportMp4: () => exportMp4(), exportEdl: exportEdlFile, exportSrt: exportSrtFile,
    requestBackgroundMusicUpload: () => { setTab("music"); setRequestedMusic(true); return { status: "human_action_required", message: "Choose a local music file in the Music panel." }; }, setStatus: setWebmcp,
  });

  const split = useCallback(() => {
    if (!state) return;
    if (selectedText) human({ type: "split_text", actor: "human", kind: selectedText.kind, id: selectedText.id, timelineMs: playheadMs });
    else if (selectedMusicId) human({ type: "split_music", actor: "human", clipId: selectedMusicId, timelineMs: playheadMs });
    else { const point = timelineToSource(state, playheadMs); if (point) human({ type: "split_clip", actor: "human", clipId: point.clipId, sourceMs: point.sourceMs }); }
  }, [state, selectedText, selectedMusicId, human, playheadMs]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (blocksEditorShortcuts(event)) return;
      try {
        if (event.code === "Space" && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); event.stopPropagation(); if (!event.repeat) { (document.activeElement as HTMLElement | null)?.blur(); togglePlayback(); } }
        else if (!event.ctrlKey && !event.metaKey && !event.altKey && ["b", "a", "escape"].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); if (!event.repeat) setBladeMode((active) => event.key.toLowerCase() === "b" ? !active : false); }
        else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
        else if (event.key === "Backspace" || event.key === "Delete") {
          event.preventDefault(); if (event.repeat) return;
          if (selectedText) dispatch({ type: selectedText.kind === "caption" ? "remove_caption" : "remove_overlay", actor: "human", id: selectedText.id });
          else if (selectedMusicId) dispatch({ type: "remove_music", actor: "human", clipId: selectedMusicId, ripple: event.key === "Delete" });
          else if (selectedClipId) dispatch({ type: "delete_clip", actor: "human", clipId: selectedClipId, ripple: event.key === "Delete" });
        }
      } catch (error) { setError(String(error)); }
    };
    window.addEventListener("keydown", shortcut, true); return () => window.removeEventListener("keydown", shortcut, true);
  }, [dispatch, undo, redo, selectedText, selectedClipId, selectedMusicId, setError, togglePlayback]);
  const textItem = selectedText && state ? (selectedText.kind === "caption" ? state.captions : state.overlays).find((item) => item.id === selectedText.id) : undefined;
  const musicItem = state?.music.find((item) => item.id === selectedMusicId);
  const clipItem = state?.clips.find((item) => item.id === selectedClipId);

  if (!project || !state) return <main className="grid min-h-dvh place-content-center text-sm">{editor.error || "Opening project…"}</main>;
  return <main className="flex h-dvh flex-col overflow-auto bg-[var(--bg)] text-[var(--text)] max-[900px]:h-auto max-[900px]:min-h-dvh max-[900px]:overflow-visible">
    <header className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] p-3">
      <Link href="/" className="mr-3 font-black tracking-tight text-white no-underline">ROUGH<span className="text-[var(--orange)]">{"//"}</span>CUT</Link>
      <button className="max-w-60 truncate text-sm" onClick={async () => { const name = await prompt("Project name", state.name); if (name !== null) human({ type: "rename_project", actor: "human", name }); }}>{state.name} ✎</button>
      <span role="status" className="mr-auto text-xs text-[var(--muted)]">{editor.saveFailed ? "Not saved · recovery available" : editor.saving ? "Saving…" : project.local ? "Saved in this browser" : "Legacy cloud project"}</span>
      <span className="text-[10px] text-[var(--lime)]">WebMCP {webmcp}</span>
      <button className={button} onClick={() => void backupProject().catch((error) => setError(String(error)))}>Project backup</button>
      <button className={button} onClick={() => setTab("exports")}>Saved exports</button>
      <button className={button} onClick={exportEdlFile}>EDL</button><button className={button} disabled={!state.captions.length} onClick={exportSrtFile}>SRT</button>
      <button className={`${button} !bg-[var(--lime)] !text-black`} disabled={exportProgress !== null || !media.source} onClick={() => { setExportName(state.name); setExportDialog(true); }}>{exportProgress === null ? "Export MP4" : `Rendering ${Math.round(exportProgress * 100)}%`}</button>
      {exportProgress !== null && <button className={button} onClick={() => exportController.current?.abort(new DOMException("Export canceled", "AbortError"))}>Cancel export</button>}
    </header>
    {editor.error && <div role="alert" className="flex flex-wrap items-center gap-3 bg-[#401c17] px-4 py-2 text-xs text-[#ff9781]"><span className="mr-auto">{editor.error}</span>{editor.saveFailed && <>{editor.recoveryRaw !== null ? <button className="underline" onClick={() => downloadText(`${state.name}-raw-recovery.txt`, editor.recoveryRaw!)}>Download raw recovery</button> : <button className="underline" onClick={() => void backupProject(true).catch((error) => setError(String(error)))}>Back up pending edits</button>}<button className="underline" onClick={editor.discardRecovery}>Discard pending / reload saved</button></>}<button aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}
    {media.missing.length > 0 && <div className="flex flex-wrap gap-4 bg-[#202716] p-3 text-xs">{media.missing.map(({ id, description }) => <label key={id}>Relink {description.name}<input className="ml-5 max-w-full cursor-pointer text-[var(--muted)] file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-[var(--lime)] file:px-3 file:py-2 file:text-xs file:font-bold file:text-[#10120d] hover:file:bg-[#e5ff93] focus-visible:rounded-md focus-visible:outline-2 focus-visible:outline-[var(--lime)]" type="file" accept={id === "source" ? "video/*" : "audio/*"} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void media.relink(id, file).then(() => setError("")).catch((error) => { if (!(error instanceof DOMException && error.name === "AbortError")) setError(String(error)); }); }} /></label>)}</div>}
    {confirmation}{editor.confirmation}{transcription.confirmation}
    {exportDialog && <Modal title="Export MP4" onClose={() => setExportDialog(false)}><form onSubmit={(event) => { event.preventDefault(); void startExport(); }}>
      <p className="mt-0 mb-5 text-sm leading-relaxed text-[var(--muted)]">Choose a file name. The video is rendered on this device. It will save directly where supported, otherwise use browser storage when space is available. Temporary cloud storage is offered only with your consent when local space is insufficient.</p>
      <label className="grid gap-2 text-sm text-[var(--muted)]">File name<span className="flex overflow-hidden rounded-md border border-[var(--line)] bg-[#0b0d10]"><input autoFocus className="min-w-0 flex-1 border-0 bg-transparent px-3 py-2.5 text-sm text-white outline-none" value={exportName} onChange={(event) => setExportName(event.target.value)} /><b className="border-l border-[var(--line)] px-3 py-2.5 text-sm font-normal text-[#888f99] normal-case">.mp4</b></span></label>
      {/[\\/]/.test(exportName) && <p className="mb-0 text-sm text-[#ff9781]">File name cannot contain slashes.</p>}
      <div className="mt-6 flex justify-end gap-3"><button type="button" className={modalCancelClass} onClick={() => setExportDialog(false)}>Cancel</button><button type="submit" disabled={!exportName.trim() || /[\\/]/.test(exportName)} className={modalActionClass}>Export</button></div>
    </form></Modal>}
    {cloudReady && <div className="flex flex-wrap items-center gap-4 border-b border-[var(--line)] bg-[#202716] px-4 py-2 text-xs"><span>Cloud MP4 ready on this browser. Access expires {new Date(cloudReady.expiresAt).toLocaleString()}.</span><a className="rounded bg-[var(--lime)] px-3 py-2 font-bold text-black" href={cloudOutputUrl(cloudReady)} download={cloudReady.filename} referrerPolicy="no-referrer">Download cloud MP4</a><button className="underline" onClick={async () => { if (await confirm("Delete this cloud copy? Wait for downloads to finish first.", "Delete cloud copy?", "Delete")) void cancelCloudOutput(cloudReady).then(() => { setCloudReady(null); localStorage.removeItem(`rough-cut.cloud-output:${projectId}`); }).catch((error) => setError(String(error))); }}>Delete cloud copy</button></div>}
    {ready && <div className="flex flex-wrap items-center gap-4 border-b border-[var(--line)] bg-[#202716] px-4 py-2 text-xs"><span>{ready.savedDirectly ? "Saved to chosen file." : "Export ready locally. Download before clearing browser storage."}</span><a ref={readyButton} className="rounded bg-[var(--lime)] px-3 py-2 font-bold text-black" href={ready.url} download={ready.filename}>Download MP4</a><button className="underline" onClick={async () => { if (await confirm("Remove this browser copy? Wait until its download finishes first. Files already saved elsewhere will not be deleted.", "Remove temporary export?", "Remove")) void removeTemporaryExport(ready).then(() => setReady(null)).catch((error) => setError(String(error))); }}>Remove temporary export</button></div>}
    <section ref={previewPane} style={{ "--inspector-width": `${inspectorWidth}px` } as React.CSSProperties} className="grid min-h-[160px] flex-1 grid-cols-[minmax(0,1fr)_var(--inspector-width)] overflow-hidden max-[900px]:grid-cols-1 max-[900px]:overflow-visible">
      <div className="flex min-h-0 flex-col items-center justify-center bg-[#0e1013] p-3">
        <div ref={stage} className="relative aspect-video min-h-0 max-w-full flex-1 overflow-hidden bg-black"><canvas ref={player.canvasRef} width={1920} height={1080} aria-label="Composed video preview" className="size-full object-contain" /><button className="absolute right-2 top-2 rounded bg-black/70 p-2 text-xs" aria-label="Toggle full screen" onClick={() => void (document.fullscreenElement ? document.exitFullscreen() : stage.current?.requestFullscreen())?.catch((error) => setError(String(error)))}>⛶</button></div>
        <div className="flex w-full items-center gap-2 pt-2"><button className={button} aria-label="Seek backward five seconds" onClick={() => seekTimeline(playheadMs - 5000)}>−5s</button><button className={`${button} inline-flex size-9 shrink-0 items-center justify-center !p-0`} onClick={togglePlayback} aria-label={isPlaying ? "Pause" : "Play"} title={isPlaying ? "Pause" : "Play"}>{isPlaying ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}</button><button className={button} onClick={() => seekTimeline(playheadMs + 5000)}>+5s</button><code className="text-xs">{timecode(playheadMs)} / {timecode(total)}</code><input className="min-w-0 flex-1" aria-label="Playhead" type="range" min={0} max={total} value={playheadMs} onChange={(event) => seekTimeline(Number(event.target.value))} /></div>
      </div>
      <aside aria-label="Inspector" className="relative min-h-0 min-w-0 border-l border-[var(--line)] bg-[var(--panel)] max-[900px]:max-h-80">
        <button type="button" role="separator" aria-orientation="vertical" aria-label="Resize preview and Inspector" aria-valuemin={INSPECTOR_MIN_WIDTH} aria-valuemax={INSPECTOR_MAX_WIDTH} aria-valuenow={Math.round(inspectorWidth)} title="Drag to resize Inspector; Left/Right arrows adjust width" className="group absolute inset-y-0 -left-1 z-20 hidden w-2 touch-none cursor-col-resize border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-[var(--lime)] min-[901px]:block" onPointerDown={(event) => startResize("inspector", event)} onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault(); resizeInspector(inspectorWidth + (event.key === "ArrowLeft" ? 1 : -1) * (event.shiftKey ? 40 : 10));
        }}><span className="absolute inset-y-0 left-1/2 w-px bg-[var(--line)] group-hover:bg-[var(--lime)] group-focus-visible:bg-[var(--lime)]" /></button>
        <div className="h-full overflow-auto max-[900px]:max-h-80">
        {selectedText && textItem ? <TextInspector state={state} kind={selectedText.kind} item={textItem} onPreview={(patch) => setTextPreview({ ...selectedText, patch })} onCommit={() => setTextPreview(null)} onCaptionOpacityPreview={setCaptionOpacity} onCaptionOpacityCommit={() => setCaptionOpacity(null)} dispatch={dispatch} /> : musicItem ? <MusicInspector state={state} music={musicItem} onPreview={(patch) => setMusicPreview({ clipId: musicItem.id, patch })} onCommit={() => setMusicPreview(null)} dispatch={dispatch} /> : clipItem ? <ClipInspector state={state} clip={clipItem} dispatch={dispatch} previewClip={editor.previewClip} setError={setError} /> : <p className="p-5 text-xs text-[var(--muted)]">Select a clip, text or music to edit.</p>}
        </div>
      </aside>
    </section>
    <section className="relative flex shrink-0 flex-col border-y border-[var(--line)]" style={{ height: timelineHeight }}>
      {splitter("top")}
      <div className="flex flex-wrap items-center gap-2 p-2"><button className={button} title="Split at playhead" onClick={split}>Split</button><button className={`${button} inline-flex items-center gap-2 ${bladeMode ? "!border-[var(--lime)] !bg-[#293019] text-[var(--lime)]" : "text-[var(--muted)]"}`} aria-label="Blade mode" aria-pressed={bladeMode} aria-keyshortcuts="B" title="Toggle blade mode (B): click a clip to split here. A or Escape returns to selection." onClick={() => setBladeMode((active) => !active)}><svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true"><path d="M8 2h8v15l-8 5ZM12 5v7M8 17l8-5" /></svg>Blade</button><button className={button} disabled={!editor.canUndo} title="History: up to 100 steps / 16 MiB" onClick={() => { try { editor.undo(); } catch (error) { setError(String(error)); } }}>Undo</button><button className={button} disabled={!editor.canRedo} onClick={() => { try { editor.redo(); } catch (error) { setError(String(error)); } }}>Redo</button><button className={`${button} inline-flex items-center gap-2 ${snap ? "!border-[var(--lime)] !bg-[#293019] text-[var(--lime)]" : "text-[var(--muted)]"}`} aria-pressed={snap} title="Toggle snapping (N); changes during a drag last until that drag ends" onClick={snapping.toggle}><Magnet className="size-4" aria-hidden="true" />Snap</button></div>
      <Timeline state={state} waveform={waveform} musicWaveform={musicWaveform} musicPreview={musicPreview} snapping={snapping} bladeMode={bladeMode} playheadMs={playheadMs} selectedClipId={selectedClipId} selectedMusicId={selectedMusicId} selectedText={selectedText} onSelect={selectClip} onEditText={selectText} onEditMusic={selectMusic} onClearSelection={clearSelection} onSeek={seekTimeline} dispatch={dispatch} setError={setError} />
    </section>
    <section className="relative flex shrink-0 flex-col bg-[var(--panel)]" style={{ height: lowerHeight }}>{splitter("bottom")}<div role="tablist" aria-label="Editor panels" className="flex flex-wrap gap-2 border-b border-[var(--line)] p-2">{(["transcript", "text", "music", "silence", "markers", "activity", "exports"] as const).map((name) => <button key={name} role="tab" aria-selected={tab === name} className={`px-2 text-xs uppercase ${tab === name ? "text-[var(--lime)]" : "text-[var(--muted)]"}`} onClick={() => setTab(name)}>{name}</button>)}</div><div role="tabpanel" className="min-h-0 flex-1 overflow-auto">
      {tab === "transcript" && <TranscriptPanel state={state} transcript={transcript} playheadMs={playheadMs} dispatch={dispatch} transcribeVideo={transcription.run} automaticStatus={transcription.status} transcriptionNotice={transcription.notice} cancelTranscription={transcription.cancel} seekTimeline={seekTimeline} setError={setError} />}
      {tab === "text" && <TextPanel state={state} playheadMs={playheadMs} dispatch={dispatch} />}{tab === "music" && <MusicPanel projectId={projectId} local={!!project.local} state={state} requested={requestedMusic} onRequestComplete={() => setRequestedMusic(false)} dispatch={dispatch} setError={setError} />}{tab === "silence" && <SilencePanel transcript={transcript} detect={detectSilences} dispatch={dispatch} setError={setError} />}{tab === "activity" && <ActivityPanel state={state} />}
      {tab === "exports" && <ExportLibrary onRemoved={(name) => { if (ready?.temporaryName === name) setReady(null); }} />}
      {tab === "markers" && <div className="space-y-2 p-3 text-xs">{[...state.protectedRanges.map((item) => ({ ...item, protected: true })), ...state.broll.map((item) => ({ ...item, protected: false }))].map((item) => <div key={item.id} className="flex items-center gap-3 border-b border-[var(--line)] py-2"><span className="font-bold">{item.protected ? "Protected" : "B-roll"}</span><span className="flex-1">{item.label} · source {timecode(item.startMs)}–{timecode(item.endMs)}</span><button className={button} onClick={() => human(item.protected ? { type: "unprotect_segment", actor: "human", rangeId: item.id } : { type: "remove_broll", actor: "human", id: item.id })}>Remove</button></div>)}{!state.protectedRanges.length && !state.broll.length && <p>Select transcript words or a video clip to protect a source range or add a B-roll brief.</p>}</div>}
    </div></section>
  </main>;
}
