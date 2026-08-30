"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { ProjectState, TranscriptWord } from "@/lib/editor";
import type { CommandInput } from "./use-editor";

type Handlers = {
  stateRef: RefObject<ProjectState | null>;
  transcriptRef: RefObject<TranscriptWord[]>;
  dispatch(command: CommandInput): ProjectState;
  undo(actor?: "human" | "agent"): ProjectState | null;
  redo(actor?: "human" | "agent"): ProjectState | null;
  seekTimeline(ms: number): void;
  inspectFrame(ms?: number): { timelineMs: number; image: string };
  detectSilences(thresholdDb?: number, minimumMs?: number): Promise<Array<{ startMs: number; endMs: number }>>;
  exportMp4(): Promise<{ jobId: string; downloadUrl: string }>;
  exportEdl(): string;
  setStatus(status: string): void;
};

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = (description: string) => ({ type: "string", description });
const number = (description: string, minimum = 0) => ({ type: "number", description, minimum });

export function useWebMCP(handlers: Handlers) {
  const current = useRef(handlers);
  current.current = handlers;

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) { current.current.setStatus("Unavailable"); return; }
    const controller = new AbortController();
    const state = () => {
      const value = current.current.stateRef.current;
      if (!value) throw new Error("Project is not ready");
      return value;
    };
    const asNumber = (value: unknown, name: string) => {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number`);
      return value;
    };
    const asString = (value: unknown, name: string) => {
      if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
      return value;
    };
    const mutationSchema = (properties: Record<string, unknown>, required: string[] = []) => objectSchema({ expected_version: { type: "integer", minimum: 0, description: "Project version returned by get_project_state" }, ...properties }, ["expected_version", ...required]);
    const assertVersion = (input: Record<string, unknown>) => {
      const expected = asNumber(input.expected_version, "expected_version");
      if (!Number.isInteger(expected)) throw new Error("expected_version must be an integer");
      const currentVersion = state().version;
      if (expected !== currentVersion) throw new Error(`STALE_VERSION:${currentVersion}`);
    };
    const tools: WebMCPTool[] = [
      {
        name: "get_project_state", title: "Inspect active video project", description: "Read the active project version, duration, ordered clips, transitions, protected ranges, captions, overlays and B-roll markers. Call before editing.",
        annotations: { readOnlyHint: true },
        async execute() { const value = state(); return { ...value, activity: value.activity.slice(0, 20) }; },
      },
      {
        name: "get_transcript", title: "Read transcript", description: "Read a page of word-timestamped transcript for the active source video.",
        inputSchema: objectSchema({ offset: number("Zero-based word offset"), limit: { type: "integer", minimum: 1, maximum: 500, description: "Words to return" } }), annotations: { readOnlyHint: true },
        async execute(input) { const words = current.current.transcriptRef.current; const offset = typeof input.offset === "number" ? input.offset : 0; const limit = typeof input.limit === "number" ? Math.min(500, input.limit) : 200; return { total: words.length, offset, words: words.slice(offset, offset + limit) }; },
      },
      {
        name: "search_transcript", title: "Search transcript", description: "Find transcript words matching text and return surrounding word-timestamped context.",
        inputSchema: objectSchema({ query: string("Text to find"), limit: { type: "integer", minimum: 1, maximum: 50 } }, ["query"]), annotations: { readOnlyHint: true },
        async execute(input) { const query = asString(input.query, "query").toLowerCase(); const words = current.current.transcriptRef.current; const indexes = words.map((word, index) => word.word.toLowerCase().includes(query) ? index : -1).filter((index) => index >= 0).slice(0, typeof input.limit === "number" ? input.limit : 20); return indexes.map((index) => ({ match: words[index], context: words.slice(Math.max(0, index - 6), index + 7) })); },
      },
      {
        name: "inspect_frame", title: "Inspect exact video frame", description: "Seek the visible editor to a timeline time and return the displayed frame as JPEG data with its exact time.",
        inputSchema: objectSchema({ timeline_ms: number("Timeline position in milliseconds") }), annotations: { readOnlyHint: true },
        async execute(input) { const target = typeof input.timeline_ms === "number" ? input.timeline_ms : undefined; if (target !== undefined) { current.current.seekTimeline(target); await new Promise((resolve) => setTimeout(resolve, 150)); } return current.current.inspectFrame(); },
      },
      {
        name: "detect_silences", title: "Detect silent audio ranges", description: "Analyze source audio with FFmpeg and return candidate silent source ranges. This does not edit the timeline.",
        inputSchema: objectSchema({ threshold_db: { type: "number", minimum: -60, maximum: -10 }, minimum_ms: { type: "number", minimum: 100, maximum: 5000 } }), annotations: { readOnlyHint: true },
        async execute(input) { return { ranges: await current.current.detectSilences(typeof input.threshold_db === "number" ? input.threshold_db : -35, typeof input.minimum_ms === "number" ? input.minimum_ms : 500) }; },
      },
      {
        name: "split_clip", description: "Split one timeline clip at an exact source-media time.",
        inputSchema: mutationSchema({ clip_id: string("Clip ID from get_project_state"), source_ms: number("Source-media split time in milliseconds") }, ["clip_id", "source_ms"]),
        async execute(input) { assertVersion(input); return current.current.dispatch({ type: "split_clip", actor: "agent", clipId: asString(input.clip_id, "clip_id"), sourceMs: asNumber(input.source_ms, "source_ms") }); },
      },
      {
        name: "remove_segments", description: "Remove one or more source-media ranges from every matching clip. Protected ranges are rejected.",
        inputSchema: mutationSchema({ ranges: { type: "array", minItems: 1, items: objectSchema({ start_ms: number("Start"), end_ms: number("End") }, ["start_ms", "end_ms"]) } }, ["ranges"]), annotations: { destructiveHint: true },
        async execute(input) { assertVersion(input); if (!Array.isArray(input.ranges)) throw new Error("ranges must be an array"); const ranges = input.ranges.map((range) => { const value = range as Record<string, unknown>; return { startMs: asNumber(value.start_ms, "start_ms"), endMs: asNumber(value.end_ms, "end_ms") }; }); return current.current.dispatch({ type: "remove_segments", actor: "agent", ranges }); },
      },
      {
        name: "reorder_clips", description: "Replace timeline clip order atomically and pack clips together without gaps. Include every current clip ID exactly once.",
        inputSchema: mutationSchema({ clip_ids: { type: "array", items: { type: "string" }, minItems: 1 } }, ["clip_ids"]),
        async execute(input) { assertVersion(input); if (!Array.isArray(input.clip_ids) || input.clip_ids.some((id) => typeof id !== "string")) throw new Error("clip_ids must be strings"); return current.current.dispatch({ type: "reorder_clips", actor: "agent", clipIds: input.clip_ids as string[] }); },
      },
      {
        name: "move_clip", description: "Move a linked video/audio clip to an explicit timeline position. Clips cannot overlap.",
        inputSchema: mutationSchema({ clip_id: string("Clip ID"), timeline_start_ms: number("Timeline start in milliseconds") }, ["clip_id", "timeline_start_ms"]),
        async execute(input) { assertVersion(input); return current.current.dispatch({ type: "move_clip", actor: "agent", clipId: asString(input.clip_id, "clip_id"), timelineStartMs: asNumber(input.timeline_start_ms, "timeline_start_ms") }); },
      },
      {
        name: "adjust_clip", description: "Adjust a clip's color, X/Y zoom and pan, volume, mute state, speed or edge fades. Omitted properties remain unchanged.",
        inputSchema: mutationSchema({ clip_id: string("Clip ID"), brightness: { type: "number", minimum: -1, maximum: 1 }, contrast: { type: "number", minimum: 0, maximum: 2 }, saturation: { type: "number", minimum: 0, maximum: 3 }, hue: { type: "number", minimum: -180, maximum: 180 }, scale_x: { type: "number", minimum: 1, maximum: 4 }, scale_y: { type: "number", minimum: 1, maximum: 4 }, position_x: { type: "number", minimum: -100, maximum: 100 }, position_y: { type: "number", minimum: -100, maximum: 100 }, volume: { type: "number", minimum: 0, maximum: 2 }, muted: { type: "boolean" }, speed: { type: "number", minimum: 0.5, maximum: 2 }, fade_in_ms: number("Fade-in duration"), fade_out_ms: number("Fade-out duration") }, ["clip_id"]),
        async execute(input) { assertVersion(input); const patch: Record<string, number | boolean> = {}; for (const [source, target] of [["brightness", "brightness"], ["contrast", "contrast"], ["saturation", "saturation"], ["hue", "hue"], ["scale_x", "scaleX"], ["scale_y", "scaleY"], ["position_x", "positionX"], ["position_y", "positionY"], ["volume", "volume"], ["speed", "speed"], ["fade_in_ms", "fadeInMs"], ["fade_out_ms", "fadeOutMs"]] as const) if (input[source] !== undefined) patch[target] = asNumber(input[source], source); if (input.muted !== undefined) { if (typeof input.muted !== "boolean") throw new Error("muted must be a boolean"); patch.muted = input.muted; } return current.current.dispatch({ type: "adjust_clip", actor: "agent", clipId: asString(input.clip_id, "clip_id"), patch }); },
      },
      {
        name: "set_transition", description: "Set the transition from one clip into the next: cut, crossfade or fade-black.",
        inputSchema: mutationSchema({ clip_id: string("Outgoing clip ID"), type: { type: "string", enum: ["cut", "crossfade", "fade-black"] }, duration_ms: number("Transition duration") }, ["clip_id", "type"]),
        async execute(input) { assertVersion(input); const type = input.type; if (type !== "cut" && type !== "crossfade" && type !== "fade-black") throw new Error("Invalid transition type"); return current.current.dispatch({ type: "set_transition", actor: "agent", clipId: asString(input.clip_id, "clip_id"), transition: { type, durationMs: type === "cut" ? 0 : asNumber(input.duration_ms ?? 500, "duration_ms") } }); },
      },
      {
        name: "set_captions", description: "Replace captions with timed timeline text cues.",
        inputSchema: mutationSchema({ captions: { type: "array", items: objectSchema({ text: string("Caption"), start_ms: number("Timeline start"), end_ms: number("Timeline end"), position: { type: "string", enum: ["top", "center", "bottom"] } }, ["text", "start_ms", "end_ms"]) } }, ["captions"]),
        async execute(input) { assertVersion(input); if (!Array.isArray(input.captions)) throw new Error("captions must be an array"); const items = input.captions.map((item) => { const value = item as Record<string, unknown>; const position: "top" | "center" | "bottom" = value.position === "top" || value.position === "center" ? value.position : "bottom"; return { text: asString(value.text, "text"), startMs: asNumber(value.start_ms, "start_ms"), endMs: asNumber(value.end_ms, "end_ms"), position }; }); return current.current.dispatch({ type: "set_captions", actor: "agent", items }); },
      },
      {
        name: "add_text_overlay", description: "Add a positioned text overlay at timeline timestamps.",
        inputSchema: mutationSchema({ text: string("Overlay text"), start_ms: number("Timeline start"), end_ms: number("Timeline end"), position: { type: "string", enum: ["top", "center", "bottom"] } }, ["text", "start_ms", "end_ms"]),
        async execute(input) { assertVersion(input); const position = input.position === "top" || input.position === "bottom" ? input.position : "center"; return current.current.dispatch({ type: "add_overlay", actor: "agent", item: { text: asString(input.text, "text"), startMs: asNumber(input.start_ms, "start_ms"), endMs: asNumber(input.end_ms, "end_ms"), position } }); },
      },
      {
        name: "protect_segment", description: "Protect a source range so later destructive edits cannot remove it.",
        inputSchema: mutationSchema({ start_ms: number("Source start"), end_ms: number("Source end"), label: string("Why this must remain") }, ["start_ms", "end_ms", "label"]),
        async execute(input) { assertVersion(input); return current.current.dispatch({ type: "protect_segment", actor: "agent", startMs: asNumber(input.start_ms, "start_ms"), endMs: asNumber(input.end_ms, "end_ms"), label: asString(input.label, "label") }); },
      },
      {
        name: "unprotect_segment", description: "Remove protection from a source range by ID.", inputSchema: mutationSchema({ range_id: string("Protected range ID") }, ["range_id"]),
        async execute(input) { assertVersion(input); return current.current.dispatch({ type: "unprotect_segment", actor: "agent", rangeId: asString(input.range_id, "range_id") }); },
      },
      {
        name: "mark_broll", description: "Attach a B-roll brief to a spoken source range without generating footage.",
        inputSchema: mutationSchema({ start_ms: number("Source start"), end_ms: number("Source end"), brief: string("Visual brief") }, ["start_ms", "end_ms", "brief"]),
        async execute(input) { assertVersion(input); return current.current.dispatch({ type: "mark_broll", actor: "agent", startMs: asNumber(input.start_ms, "start_ms"), endMs: asNumber(input.end_ms, "end_ms"), label: asString(input.brief, "brief") }); },
      },
      { name: "undo", description: "Undo the latest reversible timeline edit.", inputSchema: mutationSchema({}), async execute(input) { assertVersion(input); return current.current.undo("agent") ?? { unchanged: true }; } },
      { name: "redo", description: "Redo the latest undone timeline edit.", inputSchema: mutationSchema({}), async execute(input) { assertVersion(input); return current.current.redo("agent") ?? { unchanged: true }; } },
      { name: "render_preview", description: "Render an accurate MP4 preview from the original video and current edit instructions.", async execute() { return current.current.exportMp4(); } },
      { name: "export_mp4", description: "Render and download the final MP4 from the original source.", async execute() { return current.current.exportMp4(); } },
      { name: "export_edl", description: "Generate and download a CMX3600-style EDL for the current cut.", async execute() { return { edl: current.current.exportEdl() }; } },
    ];

    Promise.all(tools.map((tool) => context.registerTool(tool, { signal: controller.signal })))
      .then(() => current.current.setStatus("Ready"))
      .catch((error) => { console.error("WebMCP registration failed", error); current.current.setStatus("Error"); });
    return () => controller.abort();
  }, []);
}
