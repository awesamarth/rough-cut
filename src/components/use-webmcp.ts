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
  transcribeVideo(actor?: "human" | "agent", expectedVersion?: number): Promise<ProjectState>;
  exportMp4(): Promise<{ jobId: string; downloadUrl: string }>;
  exportEdl(): string;
  exportSrt(): string;
  requestBackgroundMusicUpload(): { status: string; message: string };
  setStatus(status: string): void;
};

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = (description: string) => ({ type: "string", description });
const number = (description: string, minimum = 0) => ({ type: "number", description, minimum });

function collectionDiff(before: Array<{ id: string }>, after: Array<{ id: string }>) {
  const prior = new Map(before.map((item) => [item.id, item]));
  const next = new Map(after.map((item) => [item.id, item]));
  const created = after.filter((item) => !prior.has(item.id)).map((item) => item.id);
  const removed = before.filter((item) => !next.has(item.id)).map((item) => item.id);
  const changed = after.flatMap((item) => {
    const old = prior.get(item.id);
    if (!old) return [];
    const left = old as Record<string, unknown>;
    const right = item as Record<string, unknown>;
    const fields = Object.fromEntries(Object.keys(right).filter((key) => key !== "id" && JSON.stringify(left[key]) !== JSON.stringify(right[key])).map((key) => [key, { from: left[key], to: right[key] }]));
    return Object.keys(fields).length ? [{ id: item.id, fields }] : [];
  });
  return { ...(created.length ? { created } : {}), ...(removed.length ? { removed } : {}), ...(changed.length ? { changed } : {}) };
}

export function compactMutationResult(before: ProjectState, next: ProjectState) {
  const diff: Record<string, unknown> = {};
  for (const [key, prior, following] of [
    ["clips", before.clips, next.clips], ["captions", before.captions, next.captions], ["overlays", before.overlays, next.overlays],
    ["music", before.music, next.music], ["protected_ranges", before.protectedRanges, next.protectedRanges], ["broll", before.broll, next.broll],
  ] as const) {
    const value = collectionDiff(prior, following);
    if (Object.keys(value).length) diff[key] = value;
  }
  if (before.name !== next.name) diff.project_name = { from: before.name, to: next.name };
  if (JSON.stringify(before.captionStyle) !== JSON.stringify(next.captionStyle)) diff.caption_style = { from: before.captionStyle, to: next.captionStyle };
  return { project_version: next.version, summary: next.activity[0]?.summary ?? "Project updated", diff };
}

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
    const mutate = (command: CommandInput) => { const before = state(); return compactMutationResult(before, current.current.dispatch(command)); };
    const tools: WebMCPTool[] = [
      {
        name: "get_project_state", title: "Inspect active video project", description: "Read the active project version, duration, ordered clips, transitions, protected ranges, captions, caption style, overlays, background music and B-roll markers. Call before editing.",
        annotations: { readOnlyHint: true },
        async execute() { const value = state(); return { ...value, activity: value.activity.slice(0, 3) }; },
      },
      {
        name: "get_activity", title: "Read project activity", description: "Read a paginated page of recent human, agent and system project activity.",
        inputSchema: objectSchema({ offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }), annotations: { readOnlyHint: true },
        async execute(input) { const activity = state().activity; const offset = typeof input.offset === "number" && Number.isInteger(input.offset) ? Math.max(0, input.offset) : 0; const limit = typeof input.limit === "number" && Number.isInteger(input.limit) ? Math.min(100, Math.max(1, input.limit)) : 20; return { total: activity.length, offset, activity: activity.slice(offset, offset + limit) }; },
      },
      {
        name: "rename_project", title: "Rename project", description: "Change the persisted project name used by the editor and default exports.",
        inputSchema: mutationSchema({ name: string("New project name") }, ["name"]),
        async execute(input) { assertVersion(input); return mutate({ type: "rename_project", actor: "agent", name: asString(input.name, "name") }); },
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
        name: "transcribe_video", description: "Transcribe the source video with Cloudflare Whisper and save word timestamps. This may take several minutes.",
        inputSchema: mutationSchema({}),
        async execute(input) { assertVersion(input); const before = state(); const next = await current.current.transcribeVideo("agent", asNumber(input.expected_version, "expected_version")); return { ...compactMutationResult(before, next), transcript: { word_count: current.current.transcriptRef.current.length } }; },
      },
      {
        name: "split_clip", description: "Split one timeline clip at an exact source-media time.",
        inputSchema: mutationSchema({ clip_id: string("Clip ID from get_project_state"), source_ms: number("Source-media split time in milliseconds") }, ["clip_id", "source_ms"]),
        async execute(input) { assertVersion(input); return mutate({ type: "split_clip", actor: "agent", clipId: asString(input.clip_id, "clip_id"), sourceMs: asNumber(input.source_ms, "source_ms") }); },
      },
      {
        name: "split_text", description: "Split one caption or text-overlay clip at an exact timeline time.",
        inputSchema: mutationSchema({ kind: { type: "string", enum: ["caption", "overlay"] }, item_id: string("Caption or overlay ID"), timeline_ms: number("Timeline split position") }, ["kind", "item_id", "timeline_ms"]),
        async execute(input) { assertVersion(input); if (input.kind !== "caption" && input.kind !== "overlay") throw new Error("Invalid text kind"); return mutate({ type: "split_text", actor: "agent", kind: input.kind, id: asString(input.item_id, "item_id"), timelineMs: asNumber(input.timeline_ms, "timeline_ms") }); },
      },
      {
        name: "split_background_music", description: "Split one non-looping A2 music clip at an exact timeline time.",
        inputSchema: mutationSchema({ clip_id: string("Music clip ID"), timeline_ms: number("Timeline split position") }, ["clip_id", "timeline_ms"]),
        async execute(input) { assertVersion(input); return mutate({ type: "split_music", actor: "agent", clipId: asString(input.clip_id, "clip_id"), timelineMs: asNumber(input.timeline_ms, "timeline_ms") }); },
      },
      {
        name: "trim_clip", description: "Set a clip's source in and out points without rippling later clips.",
        inputSchema: mutationSchema({ clip_id: string("Clip ID"), source_in_ms: number("New source in"), source_out_ms: number("New source out") }, ["clip_id", "source_in_ms", "source_out_ms"]),
        async execute(input) { assertVersion(input); return mutate({ type: "trim_clip", actor: "agent", clipId: asString(input.clip_id, "clip_id"), sourceInMs: asNumber(input.source_in_ms, "source_in_ms"), sourceOutMs: asNumber(input.source_out_ms, "source_out_ms") }); },
      },
      {
        name: "delete_clip", description: "Delete one entire clip. By default its timeline gap remains; set ripple true to close the removed clip's span. Protected source ranges are rejected.",
        inputSchema: mutationSchema({ clip_id: string("Clip ID"), ripple: { type: "boolean", description: "Shift later clips left to close the removed span" } }, ["clip_id"]), annotations: { destructiveHint: true },
        async execute(input) { assertVersion(input); if (input.ripple !== undefined && typeof input.ripple !== "boolean") throw new Error("ripple must be a boolean"); return mutate({ type: "delete_clip", actor: "agent", clipId: asString(input.clip_id, "clip_id"), ripple: input.ripple === true }); },
      },
      {
        name: "remove_segments", description: "Remove one or more source-media ranges from every matching clip. Protected ranges are rejected.",
        inputSchema: mutationSchema({ ranges: { type: "array", minItems: 1, items: objectSchema({ start_ms: number("Start"), end_ms: number("End") }, ["start_ms", "end_ms"]) } }, ["ranges"]), annotations: { destructiveHint: true },
        async execute(input) { assertVersion(input); if (!Array.isArray(input.ranges)) throw new Error("ranges must be an array"); const ranges = input.ranges.map((range) => { const value = range as Record<string, unknown>; return { startMs: asNumber(value.start_ms, "start_ms"), endMs: asNumber(value.end_ms, "end_ms") }; }); return mutate({ type: "remove_segments", actor: "agent", ranges }); },
      },
      {
        name: "reorder_clips", description: "Replace timeline clip order atomically and pack clips together without gaps. Include every current clip ID exactly once.",
        inputSchema: mutationSchema({ clip_ids: { type: "array", items: { type: "string" }, minItems: 1 } }, ["clip_ids"]),
        async execute(input) { assertVersion(input); if (!Array.isArray(input.clip_ids) || input.clip_ids.some((id) => typeof id !== "string")) throw new Error("clip_ids must be strings"); return mutate({ type: "reorder_clips", actor: "agent", clipIds: input.clip_ids as string[] }); },
      },
      {
        name: "move_clip", description: "Move a linked video/audio clip to an explicit timeline position. Clips cannot overlap.",
        inputSchema: mutationSchema({ clip_id: string("Clip ID"), timeline_start_ms: number("Timeline start in milliseconds") }, ["clip_id", "timeline_start_ms"]),
        async execute(input) { assertVersion(input); return mutate({ type: "move_clip", actor: "agent", clipId: asString(input.clip_id, "clip_id"), timelineStartMs: asNumber(input.timeline_start_ms, "timeline_start_ms") }); },
      },
      {
        name: "adjust_clip", description: "Adjust a clip's color, X/Y zoom and pan, volume, mute state, speed or edge fades. Omitted properties remain unchanged.",
        inputSchema: mutationSchema({ clip_id: string("Clip ID"), brightness: { type: "number", minimum: -1, maximum: 1 }, contrast: { type: "number", minimum: 0, maximum: 2 }, saturation: { type: "number", minimum: 0, maximum: 3 }, hue: { type: "number", minimum: -180, maximum: 180 }, scale_x: { type: "number", minimum: 0.25, maximum: 4 }, scale_y: { type: "number", minimum: 0.25, maximum: 4 }, position_x: { type: "number", minimum: -100, maximum: 100 }, position_y: { type: "number", minimum: -100, maximum: 100 }, volume: { type: "number", minimum: 0, maximum: 5 }, muted: { type: "boolean" }, speed: { type: "number", minimum: 0.5, maximum: 2 }, fade_in_ms: number("Fade-in duration"), fade_out_ms: number("Fade-out duration") }, ["clip_id"]),
        async execute(input) { assertVersion(input); const patch: Record<string, number | boolean> = {}; for (const [source, target] of [["brightness", "brightness"], ["contrast", "contrast"], ["saturation", "saturation"], ["hue", "hue"], ["scale_x", "scaleX"], ["scale_y", "scaleY"], ["position_x", "positionX"], ["position_y", "positionY"], ["volume", "volume"], ["speed", "speed"], ["fade_in_ms", "fadeInMs"], ["fade_out_ms", "fadeOutMs"]] as const) if (input[source] !== undefined) patch[target] = asNumber(input[source], source); if (input.muted !== undefined) { if (typeof input.muted !== "boolean") throw new Error("muted must be a boolean"); patch.muted = input.muted; } return mutate({ type: "adjust_clip", actor: "agent", clipId: asString(input.clip_id, "clip_id"), patch }); },
      },
      {
        name: "set_transition", description: "Set the transition from one clip into the next: cut, crossfade or fade-black.",
        inputSchema: mutationSchema({ clip_id: string("Outgoing clip ID"), type: { type: "string", enum: ["cut", "crossfade", "fade-black"] }, duration_ms: number("Transition duration") }, ["clip_id", "type"]),
        async execute(input) { assertVersion(input); const type = input.type; if (type !== "cut" && type !== "crossfade" && type !== "fade-black") throw new Error("Invalid transition type"); return mutate({ type: "set_transition", actor: "agent", clipId: asString(input.clip_id, "clip_id"), transition: { type, durationMs: type === "cut" ? 0 : asNumber(input.duration_ms ?? 500, "duration_ms") } }); },
      },
      {
        name: "set_captions", description: "Replace captions with timed timeline text cues.",
        inputSchema: mutationSchema({ captions: { type: "array", items: objectSchema({ text: string("Caption"), start_ms: number("Timeline start"), end_ms: number("Timeline end"), position: { type: "string", enum: ["top", "center", "bottom"] } }, ["text", "start_ms", "end_ms"]) } }, ["captions"]),
        async execute(input) { assertVersion(input); if (!Array.isArray(input.captions)) throw new Error("captions must be an array"); const items = input.captions.map((item) => { const value = item as Record<string, unknown>; const position: "top" | "center" | "bottom" = value.position === "top" || value.position === "center" ? value.position : "bottom"; return { text: asString(value.text, "text"), startMs: asNumber(value.start_ms, "start_ms"), endMs: asNumber(value.end_ms, "end_ms"), position }; }); return mutate({ type: "set_captions", actor: "agent", items }); },
      },
      {
        name: "add_caption", description: "Add one positioned caption without replacing existing captions.",
        inputSchema: mutationSchema({ text: string("Caption text"), start_ms: number("Timeline start"), end_ms: number("Timeline end"), position: { type: "string", enum: ["top", "center", "bottom"] } }, ["text", "start_ms", "end_ms"]),
        async execute(input) { assertVersion(input); const position = input.position === "top" || input.position === "center" ? input.position : "bottom"; return mutate({ type: "add_caption", actor: "agent", item: { text: asString(input.text, "text"), startMs: asNumber(input.start_ms, "start_ms"), endMs: asNumber(input.end_ms, "end_ms"), position } }); },
      },
      {
        name: "update_caption", description: "Edit an existing caption's text, timing or position.",
        inputSchema: mutationSchema({ caption_id: string("Caption ID"), text: { type: "string" }, start_ms: number("Timeline start"), end_ms: number("Timeline end"), position: { type: "string", enum: ["top", "center", "bottom"] } }, ["caption_id"]),
        async execute(input) { assertVersion(input); const patch: Record<string, unknown> = {}; if (input.text !== undefined) patch.text = asString(input.text, "text"); if (input.start_ms !== undefined) patch.startMs = asNumber(input.start_ms, "start_ms"); if (input.end_ms !== undefined) patch.endMs = asNumber(input.end_ms, "end_ms"); if (input.position !== undefined) { if (input.position !== "top" && input.position !== "center" && input.position !== "bottom") throw new Error("Invalid position"); patch.position = input.position; } return mutate({ type: "update_caption", actor: "agent", id: asString(input.caption_id, "caption_id"), patch }); },
      },
      {
        name: "set_caption_style", description: "Set the shared subtitle size, color, background visibility and background opacity.",
        inputSchema: mutationSchema({ size: { type: "string", enum: ["small", "medium", "large"] }, color: { type: "string", enum: ["white", "yellow", "lime"] }, background: { type: "boolean" }, background_opacity: { type: "number", minimum: 0, maximum: 1 } }),
        async execute(input) { assertVersion(input); const patch: Record<string, unknown> = {}; if (input.size !== undefined) { if (input.size !== "small" && input.size !== "medium" && input.size !== "large") throw new Error("Invalid size"); patch.size = input.size; } if (input.color !== undefined) { if (input.color !== "white" && input.color !== "yellow" && input.color !== "lime") throw new Error("Invalid color"); patch.color = input.color; } if (input.background !== undefined) { if (typeof input.background !== "boolean") throw new Error("background must be boolean"); patch.background = input.background; } if (input.background_opacity !== undefined) patch.backgroundOpacity = asNumber(input.background_opacity, "background_opacity"); return mutate({ type: "set_caption_style", actor: "agent", patch }); },
      },
      {
        name: "remove_caption", description: "Remove one caption by ID.",
        inputSchema: mutationSchema({ caption_id: string("Caption ID") }, ["caption_id"]), annotations: { destructiveHint: true },
        async execute(input) { assertVersion(input); return mutate({ type: "remove_caption", actor: "agent", id: asString(input.caption_id, "caption_id") }); },
      },
      {
        name: "add_text_overlay", description: "Add a positioned text overlay at timeline timestamps.",
        inputSchema: mutationSchema({ text: string("Overlay text"), start_ms: number("Timeline start"), end_ms: number("Timeline end"), position: { type: "string", enum: ["top", "center", "bottom"] }, font_size: number("Font size"), color: { type: "string", enum: ["white", "yellow", "lime"] }, background: { type: "boolean" } }, ["text", "start_ms", "end_ms"]),
        async execute(input) { assertVersion(input); const position = input.position === "top" || input.position === "bottom" ? input.position : "center"; const color = input.color === "yellow" || input.color === "lime" ? input.color : "white"; return mutate({ type: "add_overlay", actor: "agent", item: { text: asString(input.text, "text"), startMs: asNumber(input.start_ms, "start_ms"), endMs: asNumber(input.end_ms, "end_ms"), position, fontSize: input.font_size === undefined ? 54 : asNumber(input.font_size, "font_size"), color, background: input.background !== false } }); },
      },
      {
        name: "update_text_overlay", description: "Edit an existing text overlay's text, timing or position.",
        inputSchema: mutationSchema({ overlay_id: string("Overlay ID"), text: { type: "string" }, start_ms: number("Timeline start"), end_ms: number("Timeline end"), position: { type: "string", enum: ["top", "center", "bottom"] }, font_size: number("Font size"), color: { type: "string", enum: ["white", "yellow", "lime"] }, background: { type: "boolean" } }, ["overlay_id"]),
        async execute(input) { assertVersion(input); const patch: Record<string, unknown> = {}; if (input.text !== undefined) patch.text = asString(input.text, "text"); if (input.start_ms !== undefined) patch.startMs = asNumber(input.start_ms, "start_ms"); if (input.end_ms !== undefined) patch.endMs = asNumber(input.end_ms, "end_ms"); if (input.position !== undefined) { if (input.position !== "top" && input.position !== "center" && input.position !== "bottom") throw new Error("Invalid position"); patch.position = input.position; } if (input.font_size !== undefined) patch.fontSize = asNumber(input.font_size, "font_size"); if (input.color !== undefined) { if (input.color !== "white" && input.color !== "yellow" && input.color !== "lime") throw new Error("Invalid color"); patch.color = input.color; } if (input.background !== undefined) { if (typeof input.background !== "boolean") throw new Error("background must be boolean"); patch.background = input.background; } return mutate({ type: "update_overlay", actor: "agent", id: asString(input.overlay_id, "overlay_id"), patch }); },
      },
      {
        name: "remove_text_overlay", description: "Remove one text overlay by ID.",
        inputSchema: mutationSchema({ overlay_id: string("Overlay ID") }, ["overlay_id"]), annotations: { destructiveHint: true },
        async execute(input) { assertVersion(input); return mutate({ type: "remove_overlay", actor: "agent", id: asString(input.overlay_id, "overlay_id") }); },
      },
      {
        name: "request_background_music_upload", title: "Request background music upload", description: "Switch to the Music tab and highlight the upload control so the human can choose a local audio file. Returns human_action_required because browser security requires a user gesture.",
        inputSchema: objectSchema({}),
        async execute() { return current.current.requestBackgroundMusicUpload(); },
      },
      {
        name: "adjust_background_music", description: "Adjust the uploaded A2 background-music track. The human must upload the audio asset first.",
        inputSchema: mutationSchema({ clip_id: string("Music clip ID"), timeline_start_ms: number("Timeline start"), source_in_ms: number("Music source in"), source_out_ms: number("Music source out"), speed: { type: "number", minimum: 0.5, maximum: 2 }, volume: { type: "number", minimum: 0, maximum: 5 }, muted: { type: "boolean" }, fade_in_ms: number("Fade in"), fade_out_ms: number("Fade out"), loop: { type: "boolean" } }, ["clip_id"]),
        async execute(input) { assertVersion(input); if (!state().music.length) throw new Error("Background music has not been uploaded"); const patch: Record<string, number | boolean> = {}; for (const [source, target] of [["timeline_start_ms", "timelineStartMs"], ["source_in_ms", "sourceInMs"], ["source_out_ms", "sourceOutMs"], ["speed", "speed"], ["volume", "volume"], ["fade_in_ms", "fadeInMs"], ["fade_out_ms", "fadeOutMs"]] as const) if (input[source] !== undefined) patch[target] = asNumber(input[source], source); for (const [source, target] of [["muted", "muted"], ["loop", "loop"]] as const) if (input[source] !== undefined) { if (typeof input[source] !== "boolean") throw new Error(`${source} must be boolean`); patch[target] = input[source] as boolean; } return mutate({ type: "adjust_music", actor: "agent", clipId: asString(input.clip_id, "clip_id"), patch }); },
      },
      {
        name: "remove_background_music", description: "Remove one A2 background-music clip. Set ripple true to close the resulting A2 gap.", inputSchema: mutationSchema({ clip_id: string("Music clip ID"), ripple: { type: "boolean" } }, ["clip_id"]), annotations: { destructiveHint: true },
        async execute(input) { assertVersion(input); if (input.ripple !== undefined && typeof input.ripple !== "boolean") throw new Error("ripple must be boolean"); return mutate({ type: "remove_music", actor: "agent", clipId: asString(input.clip_id, "clip_id"), ripple: input.ripple === true }); },
      },
      {
        name: "protect_segment", description: "Protect a source range so later destructive edits cannot remove it.",
        inputSchema: mutationSchema({ start_ms: number("Source start"), end_ms: number("Source end"), label: string("Why this must remain") }, ["start_ms", "end_ms", "label"]),
        async execute(input) { assertVersion(input); return mutate({ type: "protect_segment", actor: "agent", startMs: asNumber(input.start_ms, "start_ms"), endMs: asNumber(input.end_ms, "end_ms"), label: asString(input.label, "label") }); },
      },
      {
        name: "unprotect_segment", description: "Remove protection from a source range by ID.", inputSchema: mutationSchema({ range_id: string("Protected range ID") }, ["range_id"]),
        async execute(input) { assertVersion(input); return mutate({ type: "unprotect_segment", actor: "agent", rangeId: asString(input.range_id, "range_id") }); },
      },
      {
        name: "mark_broll", description: "Attach a B-roll brief to a spoken source range without generating footage.",
        inputSchema: mutationSchema({ start_ms: number("Source start"), end_ms: number("Source end"), brief: string("Visual brief") }, ["start_ms", "end_ms", "brief"]),
        async execute(input) { assertVersion(input); return mutate({ type: "mark_broll", actor: "agent", startMs: asNumber(input.start_ms, "start_ms"), endMs: asNumber(input.end_ms, "end_ms"), label: asString(input.brief, "brief") }); },
      },
      {
        name: "remove_broll", description: "Remove one B-roll marker by ID.",
        inputSchema: mutationSchema({ marker_id: string("B-roll marker ID") }, ["marker_id"]), annotations: { destructiveHint: true },
        async execute(input) { assertVersion(input); return mutate({ type: "remove_broll", actor: "agent", id: asString(input.marker_id, "marker_id") }); },
      },
      { name: "undo", description: "Undo the latest reversible timeline edit.", inputSchema: mutationSchema({}), async execute(input) { assertVersion(input); const before = state(); const next = current.current.undo("agent"); return next ? { ...compactMutationResult(before, next), reread_recommended: true } : { project_version: before.version, unchanged: true }; } },
      { name: "redo", description: "Redo the latest undone timeline edit.", inputSchema: mutationSchema({}), async execute(input) { assertVersion(input); const before = state(); const next = current.current.redo("agent"); return next ? { ...compactMutationResult(before, next), reread_recommended: true } : { project_version: before.version, unchanged: true }; } },
      { name: "export_mp4", description: "Render the current project as an MP4. When rendering completes, a highlighted Download MP4 button appears in the editor; ask the human to click it because browser security requires a trusted user gesture to save the file.", async execute() { return current.current.exportMp4(); } },
      { name: "export_edl", description: "Generate and download a CMX3600-style EDL for the current cut.", async execute() { return { edl: current.current.exportEdl() }; } },
      { name: "export_srt", description: "Generate and download an SRT subtitle file from the current captions.", async execute() { return { srt: current.current.exportSrt() }; } },
    ];

    Promise.all(tools.map((tool) => context.registerTool(tool, { signal: controller.signal })))
      .then(() => { if (!controller.signal.aborted) current.current.setStatus("Ready"); })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("WebMCP registration failed", error);
        current.current.setStatus("Error");
      });
    return () => controller.abort();
  }, []);
}
