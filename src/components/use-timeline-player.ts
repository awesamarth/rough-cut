"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioRenderer } from "@/lib/audio-renderer";
import { AUDIO_RATE, FRAME_HEIGHT, FRAME_WIDTH } from "@/lib/composition";
import { timelineDuration, type ProjectState } from "@/lib/editor";
import { VideoRenderer, type MediaSource } from "@/lib/video-renderer";

export function useTimelinePlayer(state: ProjectState | null, source: MediaSource | undefined, music: Record<string, MediaSource>, setError: (message: string) => void) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const current = useRef({ state, source, music }); current.current = { state, source, music };
  const audioContext = useRef<AudioContext | null>(null);
  const mixer = useRef<AudioRenderer | null>(null);
  const nodes = useRef(new Set<AudioBufferSourceNode>());
  const generation = useRef(0);
  const playing = useRef(false);
  const position = useRef(0);
  const origin = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const clock = useCallback(() => playing.current && audioContext.current ? Math.max(position.current, (audioContext.current.currentTime - origin.current) * 1000) : position.current, []);

  const stop = useCallback(() => {
    position.current = clock(); generation.current++;
    playing.current = false; setIsPlaying(false); setPlayheadMs(position.current);
    clearTimeout(timer.current);
    mixer.current?.dispose(); mixer.current = null;
    for (const node of nodes.current) { try { node.stop(); } catch {} node.disconnect(); }
    nodes.current.clear();
  }, [clock]);

  const start = useCallback(async (target: number) => {
    stop();
    const { state, source, music } = current.current;
    if (!state || !source) throw new Error("Select the original source file before playing");
    target = Math.max(0, Math.min(timelineDuration(state), target));
    if (target >= timelineDuration(state)) { position.current = target; setPlayheadMs(target); return; }
    const run = generation.current;
    const context = audioContext.current ??= new AudioContext({ sampleRate: AUDIO_RATE });
    await context.resume();
    if (run !== generation.current) return;
    const renderer = new AudioRenderer(source, music); mixer.current = renderer;
    const total = Math.round(timelineDuration(state) * AUDIO_RATE / 1000);
    let frame = Math.min(total, Math.round(target * AUDIO_RATE / 1000));
    const initialFrame = frame;
    const prepare = async () => {
      const count = Math.min(4800, total - frame);
      const pcm = await renderer.render(state, frame, count);
      const buffer = context.createBuffer(2, count, AUDIO_RATE);
      for (let channel = 0; channel < 2; channel++) {
        const plane = buffer.getChannelData(channel);
        for (let index = 0; index < count; index++) plane[index] = pcm[index * 2 + channel];
      }
      const chunk = { buffer, frame }; frame += count;
      return chunk;
    };
    const schedule = (chunk: { buffer: AudioBuffer; frame: number }) => {
      const node = context.createBufferSource(); node.buffer = chunk.buffer; node.connect(context.destination);
      nodes.current.add(node); node.onended = () => { nodes.current.delete(node); node.disconnect(); };
      node.start(origin.current + chunk.frame / AUDIO_RATE);
    };
    try {
      const initial: Array<{ buffer: AudioBuffer; frame: number }> = [];
      while (frame < total && frame - initialFrame < AUDIO_RATE * 0.4) initial.push(await prepare());
      if (run !== generation.current) return;
      origin.current = context.currentTime + 0.06 - initialFrame / AUDIO_RATE;
      position.current = target; playing.current = true; setIsPlaying(true);
      initial.forEach(schedule);
      const pump = async () => {
        if (run !== generation.current) return;
        try {
          while (frame < total && frame / AUDIO_RATE + origin.current < context.currentTime + 0.4) {
            const chunk = await prepare();
            if (run !== generation.current) return;
            if (origin.current + chunk.frame / AUDIO_RATE < context.currentTime - 0.01) throw new Error("Playback could not keep up with decoding. Playback paused without skipping audio; try again after analysis/export finishes.");
            schedule(chunk);
          }
          if (context.currentTime >= origin.current + total / AUDIO_RATE) {
            stop(); position.current = total / AUDIO_RATE * 1000; setPlayheadMs(position.current); return;
          }
          timer.current = setTimeout(() => { void pump(); }, 30);
        } catch (error) { if (run === generation.current) { stop(); setError(String(error)); } }
      };
      void pump();
    } catch (error) { if (run === generation.current) { stop(); throw error; } }
  }, [setError, stop]);

  const seekTimeline = useCallback((value: number) => {
    const total = current.current.state ? timelineDuration(current.current.state) : 0;
    const target = Math.max(0, Math.min(total, value));
    const resume = playing.current;
    stop(); position.current = target; setPlayheadMs(target);
    if (resume && target < total) void start(target).catch((error) => setError(String(error)));
  }, [setError, start, stop]);

  const togglePlayback = useCallback(() => {
    if (playing.current || mixer.current) { stop(); return; }
    const total = current.current.state ? timelineDuration(current.current.state) : 0;
    void start(position.current >= total - 1 ? 0 : position.current).catch((error) => setError(String(error)));
  }, [setError, start, stop]);

  const audioSettings = state ? JSON.stringify([state.clips.map(({ speed, volume, muted, fadeInMs, fadeOutMs, transition, timelineStartMs, sourceInMs, sourceOutMs }) => [speed, volume, muted, fadeInMs, fadeOutMs, transition, timelineStartMs, sourceInMs, sourceOutMs]), state.music]) : "";
  // A changed committed timeline invalidates already-scheduled audio. Seek/rebuild, never play stale edits.
  useEffect(() => {
    if (playing.current) {
      const at = clock();
      void start(at).catch((error) => setError(String(error)));
    }
  }, [state?.version, audioSettings, source, clock, setError, start]);

  useEffect(() => {
    if (!source) return;
    const renderer = new VideoRenderer(source);
    const back = new OffscreenCanvas(FRAME_WIDTH, FRAME_HEIGHT);
    const context = back.getContext("2d")!;
    let canceled = false;
    let frame = 0;
    let lastTime = -1;
    let lastState: ProjectState | null = null;
    const draw = async () => {
      if (canceled) return;
      const snapshot = current.current.state;
      const total = snapshot ? timelineDuration(snapshot) : 0;
      const time = Math.max(0, Math.min(total, clock()));
      const run = generation.current;
      try {
        if (snapshot && canvasRef.current && (time !== lastTime || snapshot !== lastState)) {
          await renderer.draw(context, snapshot, time);
          if (!canceled && run === generation.current) {
            canvasRef.current.getContext("2d")!.drawImage(back, 0, 0);
            lastTime = time; lastState = snapshot; setPlayheadMs(time);
          }
        }
      } catch (error) { if (!canceled) { stop(); lastTime = clock(); lastState = snapshot; setError(String(error)); } }
      if (!canceled) frame = requestAnimationFrame(() => { void draw(); });
    };
    void draw();
    return () => { canceled = true; cancelAnimationFrame(frame); void renderer.dispose().catch((error) => console.error("Preview cleanup failed", error)); };
  }, [clock, setError, source, stop]);

  const inspectFrame = useCallback(async (target?: number) => {
    const { source, state } = current.current;
    if (!source || !state) throw new Error("Frame is not ready; select the source media");
    const time = Math.max(0, Math.min(timelineDuration(state), target ?? clock()));
    seekTimeline(time);
    const canvas = document.createElement("canvas"); canvas.width = 960; canvas.height = 540;
    const renderer = new VideoRenderer(source);
    try { await renderer.draw(canvas.getContext("2d")!, state, time); return { timelineMs: time, image: canvas.toDataURL("image/jpeg", 0.85) }; }
    finally { await renderer.dispose(); }
  }, [clock, seekTimeline]);

  useEffect(() => () => { stop(); void audioContext.current?.close(); }, [stop]);
  return { canvasRef, playheadMs, isPlaying, seekTimeline, togglePlayback, inspectFrame, stop };
}
