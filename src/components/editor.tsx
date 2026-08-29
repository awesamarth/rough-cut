"use client";

import Link from "next/link";
import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
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

function downloadText(name: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click();
  URL.revokeObjectURL(url);
}

export function Editor({ projectId }: { projectId: string }) {
  const editor = useEditor(projectId);
  const { project, state, transcript, dispatch, previewClip, initialize, undo, redo, saveTranscript, saving, error, setError } = editor;
  const videoRef = useRef<HTMLVideoElement>(null);
  const nextVideoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const transitionStarted = useRef(false);
  const [selectedClipId, setSelectedClipId] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [secondaryOpacity, setSecondaryOpacity] = useState(0);
  const [blackOpacity, setBlackOpacity] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [tab, setTab] = useState<"transcript" | "text" | "silence" | "activity">("transcript");
  const [webmcpStatus, setWebmcpStatus] = useState("Unavailable");
  const [exportStatus, setExportStatus] = useState("");
  const [frame, setFrame] = useState<string | null>(null);

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

  const seekTimeline = useCallback((targetMs: number) => {
    if (!state || !videoRef.current) return;
    const clamped = Math.max(0, Math.min(totalMs, targetMs));
    const all = timelineClips(state);
    let index = all.findIndex((entry, entryIndex) => clamped >= entry.startMs && (clamped < entry.endMs || entryIndex === all.length - 1));
    if (index < 0) index = all.length - 1;
    const entry = all[index];
    const sourceMs = entry.clip.sourceInMs + (clamped - entry.startMs) * entry.clip.speed;
    setActiveIndex(index);
    setPlayheadMs(clamped);
    videoRef.current.currentTime = Math.min(entry.clip.sourceOutMs - 1, sourceMs) / 1000;
    videoRef.current.playbackRate = entry.clip.speed;
    transitionStarted.current = false;
    setSecondaryOpacity(0); setBlackOpacity(0);
  }, [state, totalMs]);

  const updatePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video || !state || !activeClip) return;
    const entry = timelineClips(state)[activeIndex];
    const sourceMs = video.currentTime * 1000;
    const currentTimelineMs = entry.startMs + (sourceMs - activeClip.sourceInMs) / activeClip.speed;
    setPlayheadMs(Math.min(currentTimelineMs, totalMs));

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
  }, [activeClip, activeIndex, nextClip, state, totalMs]);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      if (playheadMs >= totalMs - 10) seekTimeline(0);
      void video.play();
    } else {
      video.pause(); nextVideoRef.current?.pause();
    }
  };

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

  useWebMCP({
    stateRef: editor.stateRef, transcriptRef: editor.transcriptRef, dispatch, undo, redo,
    seekTimeline, inspectFrame, detectSilences, exportMp4, exportEdl: exportEdlFile,
    setStatus: setWebmcpStatus,
  });

  if (!project) return <main className="loading-screen"><div className="spinner" /><p>{error || "Loading project…"}</p></main>;

  return (
    <main className="editor-shell">
      <header className="editor-header">
        <Link href="/" className="brand small"><span>ROUGH</span><i>{"//"}</i><span>CUT</span></Link>
        <div className="project-title"><strong>{state?.name ?? project.name}</strong><span>{saving ? "Saving…" : state ? `v${state.version} · Saved` : "Preparing timeline"}</span></div>
        <div className="header-actions">
          <span className={`webmcp-badge ${webmcpStatus === "Ready" ? "ready" : ""}`}><b /> WebMCP {webmcpStatus}</span>
          <button className="ghost-button" onClick={() => state && downloadText(`${state.name}.edl`, exportEdl(state))}>EDL</button>
          <button className="primary-button compact" disabled={!state || !!exportStatus && exportStatus !== "Export complete"} onClick={() => void exportMp4().catch((cause) => { setError(cause.message); setExportStatus(""); })}>{exportStatus || "Export MP4"}</button>
        </div>
      </header>

      {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError("")}>×</button></div>}

      <section className="editor-main">
        <div className="workspace">
          <div className="preview-stage">
            <video
              ref={videoRef} src={`/api/projects/${projectId}/media`} playsInline preload="metadata"
              style={{ filter: cssFilter(activeClip) }}
              onLoadedMetadata={(event) => initialize(event.currentTarget.duration * 1000)}
              onTimeUpdate={updatePlayback}
              onPlay={() => { setIsPlaying(true); if (transitionStarted.current) void nextVideoRef.current?.play(); }}
              onPause={() => { setIsPlaying(false); nextVideoRef.current?.pause(); }}
            />
            <video ref={nextVideoRef} src={`/api/projects/${projectId}/media`} playsInline preload="metadata" muted={false} className="transition-video" style={{ opacity: secondaryOpacity, filter: cssFilter(nextClip) }} />
            <div className="black-transition" style={{ opacity: blackOpacity }} />
            {state?.overlays.filter((item) => playheadMs >= item.startMs && playheadMs <= item.endMs).map((item) => <div key={item.id} className={`preview-text ${item.position}`}>{item.text}</div>)}
            {state?.captions.filter((item) => playheadMs >= item.startMs && playheadMs <= item.endMs).map((item) => <div key={item.id} className="preview-caption">{item.text}</div>)}
            <button className="frame-button" onClick={() => { try { inspectFrame(); } catch (cause) { setError((cause as Error).message); } }} title="Capture current frame">▣</button>
          </div>
          <div className="transport">
            <button onClick={() => seekTimeline(Math.max(0, playheadMs - 5000))}>−5s</button>
            <button className="play-button" onClick={togglePlayback}>{isPlaying ? "Ⅱ" : "▶"}</button>
            <button onClick={() => seekTimeline(Math.min(totalMs, playheadMs + 5000))}>+5s</button>
            <code>{formatTime(playheadMs)} <span>/ {formatTime(totalMs)}</span></code>
            <input aria-label="Playhead" type="range" min={0} max={Math.max(1, totalMs)} value={playheadMs} onChange={(event) => seekTimeline(Number(event.target.value))} />
          </div>
        </div>

        <aside className="inspector">
          <div className="panel-heading"><span>Inspector</span>{selectedClip && <code>{formatTime(clipDuration(selectedClip))}</code>}</div>
          {state && selectedClip ? <ClipInspector state={state} clip={selectedClip} dispatch={dispatch} previewClip={previewClip} setError={setError} /> : <p className="empty-copy">Select a clip to adjust it.</p>}
        </aside>
      </section>

      <section className="timeline-section">
        <div className="timeline-toolbar">
          <div>
            <button onClick={togglePlayback}>▶</button>
            <button onClick={splitAtPlayhead}>⌁ Split</button>
            <button disabled={!selectedClip} onClick={() => selectedClip && dispatch({ type: "delete_clip", actor: "human", clipId: selectedClip.id })}>⌫ Delete</button>
          </div>
          <div>
            <button onClick={() => undo()}>↶ Undo</button>
            <button onClick={() => redo()}>↷ Redo</button>
            <span>{state?.clips.length ?? 0} clips · {formatTime(totalMs)}</span>
          </div>
        </div>
        {state && <Timeline ref={timelineRef} state={state} playheadMs={playheadMs} selectedClipId={selectedClip?.id ?? ""} onSelect={setSelectedClipId} onSeek={seekTimeline} dispatch={dispatch} setError={setError} />}
      </section>

      <section className="lower-panel">
        <div className="lower-tabs">
          {(["transcript", "text", "silence", "activity"] as const).map((name) => <button key={name} className={tab === name ? "active" : ""} onClick={() => setTab(name)}>{name}</button>)}
        </div>
        <div className="lower-content">
          {tab === "transcript" && state && <TranscriptPanel state={state} transcript={transcript} playheadMs={playheadMs} dispatch={dispatch} saveTranscript={saveTranscript} seekTimeline={seekTimeline} projectId={projectId} setError={setError} />}
          {tab === "text" && state && <TextPanel state={state} playheadMs={playheadMs} dispatch={dispatch} />}
          {tab === "silence" && state && <SilencePanel transcript={transcript} detect={detectSilences} dispatch={dispatch} setError={setError} />}
          {tab === "activity" && state && <ActivityPanel state={state} />}
        </div>
      </section>

      {frame && <div className="frame-modal" onClick={() => setFrame(null)}><div onClick={(event) => event.stopPropagation()}><button onClick={() => setFrame(null)}>×</button><img src={frame} alt={`Captured frame at ${formatTime(playheadMs)}`} /><p>Frame at {formatTime(playheadMs)}</p></div></div>}
    </main>
  );
}

function RangeControl({ label, value, min, max, step, suffix = "", onPreview, onCommit }: { label: string; value: number; min: number; max: number; step: number; suffix?: string; onPreview?(value: number): void; onCommit(value: number): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <label className="range-control"><span>{label}<output>{draft}{suffix}</output></span><input type="range" min={min} max={max} step={step} value={draft} onChange={(event) => { const next = Number(event.target.value); setDraft(next); onPreview?.(next); }} onPointerUp={() => onCommit(draft)} onKeyUp={() => onCommit(draft)} /></label>;
}

function ClipInspector({ state, clip, dispatch, previewClip, setError }: { state: ProjectState; clip: Clip; dispatch(command: CommandInput): ProjectState; previewClip(clipId: string, patch: Partial<Clip>): void; setError(message: string): void }) {
  const preview = (patch: Partial<Clip>) => previewClip(clip.id, patch);
  const adjust = (patch: Partial<Clip>) => { try { dispatch({ type: "adjust_clip", actor: "human", clipId: clip.id, patch }); } catch (cause) { setError((cause as Error).message); } };
  const next = state.clips[state.clips.findIndex((item) => item.id === clip.id) + 1];
  return <div className="inspector-form">
    <div className="trim-fields">
      <label>In<input key={`${clip.id}-in-${clip.sourceInMs}`} type="number" defaultValue={Math.round(clip.sourceInMs)} onBlur={(event) => { const value = Number(event.target.value); if (value < clip.sourceOutMs && value !== clip.sourceInMs) dispatch({ type: "trim_clip", actor: "human", clipId: clip.id, sourceInMs: value, sourceOutMs: clip.sourceOutMs }); }} /></label>
      <label>Out<input key={`${clip.id}-out-${clip.sourceOutMs}`} type="number" defaultValue={Math.round(clip.sourceOutMs)} onBlur={(event) => { const value = Number(event.target.value); if (value > clip.sourceInMs && value !== clip.sourceOutMs) dispatch({ type: "trim_clip", actor: "human", clipId: clip.id, sourceInMs: clip.sourceInMs, sourceOutMs: value }); }} /></label>
    </div>
    <h3>Color</h3>
    <RangeControl label="Brightness" value={clip.brightness} min={-1} max={1} step={0.05} onPreview={(brightness) => preview({ brightness })} onCommit={(brightness) => adjust({ brightness })} />
    <RangeControl label="Contrast" value={clip.contrast} min={0} max={2} step={0.05} onPreview={(contrast) => preview({ contrast })} onCommit={(contrast) => adjust({ contrast })} />
    <RangeControl label="Saturation" value={clip.saturation} min={0} max={3} step={0.05} onPreview={(saturation) => preview({ saturation })} onCommit={(saturation) => adjust({ saturation })} />
    <RangeControl label="Hue" value={clip.hue} min={-180} max={180} step={1} suffix="°" onPreview={(hue) => preview({ hue })} onCommit={(hue) => adjust({ hue })} />
    <h3>Playback</h3>
    <RangeControl label="Volume" value={clip.volume} min={0} max={2} step={0.05} onPreview={(volume) => preview({ volume })} onCommit={(volume) => adjust({ volume })} />
    <RangeControl label="Speed" value={clip.speed} min={0.5} max={2} step={0.05} suffix="×" onPreview={(speed) => preview({ speed })} onCommit={(speed) => adjust({ speed })} />
    <label className="check-row"><input type="checkbox" checked={clip.muted} onChange={(event) => adjust({ muted: event.target.checked })} /> Mute clip</label>
    <h3>Fades</h3>
    <RangeControl label="Fade in" value={clip.fadeInMs} min={0} max={Math.min(3000, clipDuration(clip) / 2)} step={50} suffix="ms" onPreview={(fadeInMs) => preview({ fadeInMs })} onCommit={(fadeInMs) => adjust({ fadeInMs })} />
    <RangeControl label="Fade out" value={clip.fadeOutMs} min={0} max={Math.min(3000, clipDuration(clip) / 2)} step={50} suffix="ms" onPreview={(fadeOutMs) => preview({ fadeOutMs })} onCommit={(fadeOutMs) => adjust({ fadeOutMs })} />
    <h3>Transition</h3>
    <select disabled={!next} value={clip.transition.type} onChange={(event) => dispatch({ type: "set_transition", actor: "human", clipId: clip.id, transition: { type: event.target.value as Clip["transition"]["type"], durationMs: event.target.value === "cut" ? 0 : Math.max(300, clip.transition.durationMs) } })}>
      <option value="cut">Hard cut</option><option value="crossfade">Crossfade</option><option value="fade-black">Fade through black</option>
    </select>
    {clip.transition.type !== "cut" && next && <RangeControl label="Duration" value={clip.transition.durationMs} min={100} max={Math.min(3000, clipDuration(clip) / 2, clipDuration(next) / 2)} step={50} suffix="ms" onPreview={(durationMs) => preview({ transition: { ...clip.transition, durationMs } })} onCommit={(durationMs) => dispatch({ type: "set_transition", actor: "human", clipId: clip.id, transition: { ...clip.transition, durationMs } })} />}
  </div>;
}

type TimelineProps = { state: ProjectState; playheadMs: number; selectedClipId: string; onSelect(id: string): void; onSeek(ms: number): void; dispatch(command: CommandInput): ProjectState; setError(message: string): void };
const Timeline = forwardRef<HTMLDivElement, TimelineProps>(function Timeline({ state, playheadMs, selectedClipId, onSelect, onSeek, dispatch, setError }, ref) {
  const [dragging, setDragging] = useState("");
  const entries = timelineClips(state);
  const total = timelineDuration(state);
  const width = Math.max(900, total / 1000 * 14);
  const trim = (event: React.PointerEvent, clip: Clip, edge: "in" | "out") => {
    event.stopPropagation();
    const startX = event.clientX;
    const startIn = clip.sourceInMs; const startOut = clip.sourceOutMs;
    const trackWidth = (event.currentTarget.closest(".timeline-track") as HTMLElement).offsetWidth;
    const finish = (up: PointerEvent) => {
      window.removeEventListener("pointerup", finish);
      const delta = ((up.clientX - startX) / trackWidth) * total * clip.speed;
      const sourceInMs = edge === "in" ? Math.max(0, Math.min(startOut - 50, startIn + delta)) : startIn;
      const sourceOutMs = edge === "out" ? Math.min(state.durationMs, Math.max(startIn + 50, startOut + delta)) : startOut;
      try { dispatch({ type: "trim_clip", actor: "human", clipId: clip.id, sourceInMs, sourceOutMs }); } catch (cause) { setError((cause as Error).message); }
    };
    window.addEventListener("pointerup", finish, { once: true });
  };
  return <div className="timeline-scroll"><div ref={ref} className="timeline-track" style={{ width }} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onSeek(((event.clientX - rect.left) / rect.width) * total); }}>
    <div className="playhead-line" style={{ left: `${(playheadMs / Math.max(1, total)) * 100}%` }}><span /></div>
    {entries.map(({ clip, startMs, durationMs }, index) => <div
      key={clip.id} draggable className={`timeline-clip ${selectedClipId === clip.id ? "selected" : ""}`}
      style={{ left: `${(startMs / total) * 100}%`, width: `${(durationMs / total) * 100}%` }}
      onClick={(event) => { event.stopPropagation(); onSelect(clip.id); onSeek(startMs); }}
      onDragStart={() => setDragging(clip.id)} onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); if (!dragging || dragging === clip.id) return; const order = state.clips.map((item) => item.id); order.splice(order.indexOf(dragging), 1); order.splice(index, 0, dragging); dispatch({ type: "reorder_clips", actor: "human", clipIds: order }); setDragging(""); }}
    >
      <button className="trim-handle left" aria-label="Trim clip start" onPointerDown={(event) => trim(event, clip, "in")} />
      <div className="clip-body"><b>{index + 1}</b><span>{formatTime(durationMs)}</span>{clip.transition.type !== "cut" && <i>{clip.transition.type}</i>}</div>
      <button className="trim-handle right" aria-label="Trim clip end" onPointerDown={(event) => trim(event, clip, "out")} />
    </div>)}
  </div></div>;
});

function TranscriptPanel({ state, transcript, playheadMs, dispatch, saveTranscript, seekTimeline, projectId, setError }: { state: ProjectState; transcript: TranscriptWord[]; playheadMs: number; dispatch(command: CommandInput): ProjectState; saveTranscript(words: TranscriptWord[]): ProjectState; seekTimeline(ms: number): void; projectId: string; setError(message: string): void }) {
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<[number, number] | null>(null);
  const [provider, setProvider] = useState<"cloudflare" | "openai">("cloudflare");
  const [apiKey, setApiKey] = useState("");
  const [processing, setProcessing] = useState("");
  const visible = transcript.filter((word) => !query || word.word.toLowerCase().includes(query.toLowerCase()));

  async function transcribe() {
    setProcessing("Extracting audio…"); setError("");
    try {
      const prepResponse = await fetch(`${MEDIA_URL}/transcription/prepare`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId }) });
      const prep = await prepResponse.json() as { chunks?: Array<{ index: number; offsetMs: number; url: string }>; error?: string };
      if (!prepResponse.ok || !prep.chunks) throw new Error(prep.error || "Audio extraction failed");
      const words: TranscriptWord[] = [];
      for (let index = 0; index < prep.chunks.length; index++) {
        const chunk = prep.chunks[index];
        setProcessing(`Transcribing ${index + 1}/${prep.chunks.length}…`);
        const audio = await fetch(`${MEDIA_URL}${chunk.url}`).then((response) => response.blob());
        const form = new FormData(); form.set("audio", audio, `chunk-${index}.mp3`); form.set("provider", provider);
        const response = await fetch("/api/transcribe", { method: "POST", headers: provider === "openai" ? { "x-openai-key": apiKey } : undefined, body: form });
        const result = await response.json() as { words?: TranscriptWord[]; error?: string };
        if (!response.ok || !result.words) throw new Error(result.error || "Transcription failed");
        words.push(...result.words.map((word) => ({ ...word, id: crypto.randomUUID(), startMs: word.startMs + chunk.offsetMs, endMs: word.endMs + chunk.offsetMs })));
      }
      saveTranscript(words);
      setProcessing("");
    } catch (cause) { setProcessing(""); setError(cause instanceof Error ? cause.message : "Transcription failed"); }
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

  return <div className="transcript-panel">
    <div className="panel-actions">
      <input placeholder="Search transcript" value={query} onChange={(event) => setQuery(event.target.value)} />
      {transcript.length ? <>
        <button disabled={!selectedRange} onClick={() => selectedRange && dispatch({ type: "protect_segment", actor: "human", ...selectedRange, label: "Protected by human" })}>Protect selection</button>
        <button disabled={!selectedRange} onClick={() => selectedRange && dispatch({ type: "remove_segments", actor: "human", ranges: [selectedRange] })}>Cut selection</button>
        <button onClick={generateCaptions}>Generate captions</button>
      </> : <>
        <select value={provider} onChange={(event) => setProvider(event.target.value as typeof provider)}><option value="cloudflare">Cloudflare Whisper Large v3</option><option value="openai">OpenAI whisper-1 (your key)</option></select>
        {provider === "openai" && <input type="password" autoComplete="off" placeholder="Session-only OpenAI key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />}
        <button className="primary-button compact" disabled={!!processing || provider === "openai" && !apiKey} onClick={() => void transcribe()}>{processing || "Transcribe video"}</button>
      </>}
    </div>
    {transcript.length ? <div className="transcript-words">{visible.map((word) => {
      const index = transcript.indexOf(word); const selected = selection && index >= Math.min(...selection) && index <= Math.max(...selection);
      return <button key={word.id} className={`${selected ? "selected" : ""} ${word.startMs <= playheadMs && word.endMs >= playheadMs ? "current" : ""}`} onClick={(event) => { if (event.shiftKey && selection) setSelection([selection[0], index]); else setSelection([index, index]); const clip = timelineClips(state).find((entry) => word.startMs >= entry.clip.sourceInMs && word.startMs <= entry.clip.sourceOutMs); if (clip) seekTimeline(clip.startMs + (word.startMs - clip.clip.sourceInMs) / clip.clip.speed); }}>{word.word}</button>;
    })}</div> : <div className="empty-copy">Transcribe to unlock text search, transcript cuts, and automatic captions.</div>}
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
  return <div className="text-panel">
    <div className="text-form"><select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="overlay">Text overlay</option><option value="caption">Caption</option><option value="broll">B-roll marker</option><option value="protect">Protected range</option></select><input placeholder="Text or marker brief" value={text} onChange={(event) => setText(event.target.value)} />{(kind === "caption" || kind === "overlay") && <select value={position} onChange={(event) => setPosition(event.target.value as typeof position)}><option value="top">Top</option><option value="center">Center</option><option value="bottom">Bottom</option></select>}<input type="number" min={100} step={100} value={duration} onChange={(event) => setDuration(Number(event.target.value))} /><button onClick={add}>Add at {formatTime(playheadMs)}</button></div>
    <MarkerList state={state} dispatch={dispatch} />
  </div>;
}

function MarkerList({ state, dispatch }: { state: ProjectState; dispatch(command: CommandInput): ProjectState }) {
  return <div className="marker-list">
    {state.overlays.map((item) => <Marker key={item.id} label={`Text · ${item.text}`} range={item} onRemove={() => dispatch({ type: "remove_overlay", actor: "human", id: item.id })} />)}
    {state.captions.map((item) => <Marker key={item.id} label={`Caption · ${item.text}`} range={item} onRemove={() => dispatch({ type: "remove_caption", actor: "human", id: item.id })} />)}
    {state.broll.map((item) => <Marker key={item.id} label={`B-roll · ${item.label}`} range={item} onRemove={() => dispatch({ type: "remove_broll", actor: "human", id: item.id })} />)}
    {state.protectedRanges.map((item) => <Marker key={item.id} label={`Protected · ${item.label}`} range={item} onRemove={() => dispatch({ type: "unprotect_segment", actor: "human", rangeId: item.id })} />)}
  </div>;
}
function Marker({ label, range, onRemove }: { label: string; range: Pick<SourceRange, "startMs" | "endMs">; onRemove(): void }) { return <div><span><b>{label}</b><small>{formatTime(range.startMs)} → {formatTime(range.endMs)}</small></span><button onClick={onRemove}>×</button></div>; }

function SilencePanel({ transcript, detect, dispatch, setError }: { transcript: TranscriptWord[]; detect(threshold: number, minimum: number): Promise<Array<{ startMs: number; endMs: number }>>; dispatch(command: CommandInput): ProjectState; setError(message: string): void }) {
  const [threshold, setThreshold] = useState(-35); const [minimum, setMinimum] = useState(500); const [padding, setPadding] = useState(200);
  const [ranges, setRanges] = useState<Array<{ startMs: number; endMs: number }>>([]); const [selected, setSelected] = useState<Set<number>>(new Set()); const [working, setWorking] = useState(false);
  const scan = async () => { setWorking(true); try { const found = (await detect(threshold, minimum)).filter((range) => !transcript.some((word) => word.startMs < range.endMs && range.startMs < word.endMs)); setRanges(found); setSelected(new Set(found.map((_, index) => index))); } catch (cause) { setError((cause as Error).message); } finally { setWorking(false); } };
  const apply = () => {
    const removals = ranges.filter((_, index) => selected.has(index)).map((range) => ({ startMs: range.startMs + padding, endMs: range.endMs - padding })).filter((range) => range.endMs - range.startMs >= 50);
    try { dispatch({ type: "remove_segments", actor: "human", ranges: removals }); setRanges([]); } catch (cause) { setError((cause as Error).message); }
  };
  return <div className="silence-panel"><div className="silence-controls"><RangeControl label="Threshold" value={threshold} min={-60} max={-10} step={1} suffix="dB" onCommit={setThreshold} /><RangeControl label="Minimum" value={minimum} min={100} max={3000} step={100} suffix="ms" onCommit={setMinimum} /><RangeControl label="Speech padding" value={padding} min={0} max={500} step={25} suffix="ms" onCommit={setPadding} /><button className="primary-button compact" disabled={working} onClick={() => void scan()}>{working ? "Scanning audio…" : "Find silences"}</button></div>{ranges.length > 0 && <><div className="silence-ranges">{ranges.map((range, index) => <label key={`${range.startMs}-${range.endMs}`}><input type="checkbox" checked={selected.has(index)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })} /><span>{formatTime(range.startMs)} → {formatTime(range.endMs)}</span><b>{((range.endMs - range.startMs) / 1000).toFixed(1)}s</b></label>)}</div><button onClick={apply}>Remove {selected.size} selected silences</button></>}</div>;
}

function ActivityPanel({ state }: { state: ProjectState }) { return <div className="activity-list">{state.activity.length ? state.activity.map((item) => <div key={item.id}><span className={item.actor}>{item.actor.slice(0, 1)}</span><p><b>{item.summary}</b><small>{new Date(item.at).toLocaleTimeString()}</small></p></div>) : <p className="empty-copy">Edits from you and your agent will appear here.</p>}</div>; }
