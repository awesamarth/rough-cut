export type Actor = "human" | "agent" | "system";
export type TransitionType = "cut" | "crossfade" | "fade-black";

export type Clip = {
  id: string;
  timelineStartMs: number;
  sourceInMs: number;
  sourceOutMs: number;
  speed: number;
  volume: number;
  muted: boolean;
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number;
  scaleX: number;
  scaleY: number;
  positionX: number;
  positionY: number;
  fadeInMs: number;
  fadeOutMs: number;
  transition: { type: TransitionType; durationMs: number };
};

export type TranscriptWord = {
  id: string;
  word: string;
  startMs: number;
  endMs: number;
  confidence?: number;
};

export type TimedText = {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  position: "top" | "center" | "bottom";
};

export type SourceRange = {
  id: string;
  startMs: number;
  endMs: number;
  label: string;
};

export type Activity = {
  id: string;
  at: string;
  actor: Actor;
  summary: string;
};

export type ProjectState = {
  id: string;
  name: string;
  version: number;
  durationMs: number;
  clips: Clip[];
  protectedRanges: SourceRange[];
  captions: TimedText[];
  overlays: TimedText[];
  broll: SourceRange[];
  activity: Activity[];
};

export type EditorCommand =
  | { type: "split_clip"; expectedVersion: number; actor: Actor; clipId: string; sourceMs: number }
  | { type: "trim_clip"; expectedVersion: number; actor: Actor; clipId: string; sourceInMs: number; sourceOutMs: number }
  | { type: "delete_clip"; expectedVersion: number; actor: Actor; clipId: string }
  | { type: "remove_segments"; expectedVersion: number; actor: Actor; ranges: Array<{ startMs: number; endMs: number }> }
  | { type: "reorder_clips"; expectedVersion: number; actor: Actor; clipIds: string[] }
  | { type: "move_clip"; expectedVersion: number; actor: Actor; clipId: string; timelineStartMs: number }
  | { type: "adjust_clip"; expectedVersion: number; actor: Actor; clipId: string; patch: Partial<Pick<Clip, "speed" | "volume" | "muted" | "brightness" | "contrast" | "saturation" | "hue" | "scaleX" | "scaleY" | "positionX" | "positionY" | "fadeInMs" | "fadeOutMs">> }
  | { type: "set_transition"; expectedVersion: number; actor: Actor; clipId: string; transition: Clip["transition"] }
  | { type: "protect_segment"; expectedVersion: number; actor: Actor; startMs: number; endMs: number; label: string }
  | { type: "unprotect_segment"; expectedVersion: number; actor: Actor; rangeId: string }
  | { type: "add_caption" | "add_overlay"; expectedVersion: number; actor: Actor; item: Omit<TimedText, "id"> }
  | { type: "set_captions"; expectedVersion: number; actor: Actor; items: Array<Omit<TimedText, "id"> & { id?: string }> }
  | { type: "remove_caption" | "remove_overlay"; expectedVersion: number; actor: Actor; id: string }
  | { type: "mark_broll"; expectedVersion: number; actor: Actor; startMs: number; endMs: number; label: string }
  | { type: "remove_broll"; expectedVersion: number; actor: Actor; id: string };

const id = () => crypto.randomUUID();
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const overlaps = (a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) => a.startMs < b.endMs && b.startMs < a.endMs;

export function createClip(sourceInMs: number, sourceOutMs: number, timelineStartMs = 0): Clip {
  return {
    id: id(), timelineStartMs, sourceInMs, sourceOutMs, speed: 1, volume: 1, muted: false,
    brightness: 0, contrast: 1, saturation: 1, hue: 0,
    scaleX: 1, scaleY: 1, positionX: 0, positionY: 0,
    fadeInMs: 0, fadeOutMs: 0, transition: { type: "cut", durationMs: 0 },
  };
}

export function createProjectState(id: string, name: string, durationMs: number): ProjectState {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("Video duration must be positive");
  return {
    id, name, version: 0, durationMs,
    clips: [createClip(0, Math.round(durationMs))],
    protectedRanges: [], captions: [], overlays: [], broll: [], activity: [],
  };
}

export function clipDuration(clip: Clip) {
  return (clip.sourceOutMs - clip.sourceInMs) / clip.speed;
}

export function timelineClips(state: ProjectState) {
  return [...state.clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs).map((clip) => {
    const durationMs = clipDuration(clip);
    return { clip, startMs: clip.timelineStartMs, endMs: clip.timelineStartMs + durationMs, durationMs };
  });
}

export function timelineDuration(state: ProjectState) {
  return Math.max(0, ...timelineClips(state).map((entry) => entry.endMs));
}

export function timelineToSource(state: ProjectState, timelineMs: number) {
  const entry = timelineClips(state).find(({ startMs, endMs }) => timelineMs >= startMs && timelineMs < endMs);
  if (!entry) return null;
  return {
    clipId: entry.clip.id,
    sourceMs: clamp(entry.clip.sourceInMs + (timelineMs - entry.startMs) * entry.clip.speed, entry.clip.sourceInMs, entry.clip.sourceOutMs),
  };
}

export function migrateProjectState(state: ProjectState): ProjectState {
  let cursor = 0;
  return {
    ...state,
    clips: state.clips.map((clip) => {
      const migrated = {
        ...clip,
        timelineStartMs: Number.isFinite(clip.timelineStartMs) ? clip.timelineStartMs : cursor,
        scaleX: Number.isFinite(clip.scaleX) ? clip.scaleX : 1,
        scaleY: Number.isFinite(clip.scaleY) ? clip.scaleY : 1,
        positionX: Number.isFinite(clip.positionX) ? clip.positionX : 0,
        positionY: Number.isFinite(clip.positionY) ? clip.positionY : 0,
      };
      cursor = migrated.timelineStartMs + clipDuration(migrated) - migrated.transition.durationMs;
      return migrated;
    }),
  };
}

function validateRange(startMs: number, endMs: number, durationMs: number, minimum = 50) {
  if (![startMs, endMs].every(Number.isFinite) || startMs < 0 || endMs > durationMs || endMs - startMs < minimum) {
    throw new Error("Invalid time range");
  }
}

function assertNotProtected(state: ProjectState, range: { startMs: number; endMs: number }) {
  const protectedRange = state.protectedRanges.find((item) => overlaps(item, range));
  if (protectedRange) throw new Error(`Protected range cannot be removed: ${protectedRange.label}`);
}

function normalizeClip(clip: Clip, durationMs: number): Clip {
  validateRange(clip.sourceInMs, clip.sourceOutMs, durationMs);
  const adjustedDuration = (clip.sourceOutMs - clip.sourceInMs) / clip.speed;
  return {
    ...clip,
    speed: clamp(clip.speed, 0.5, 2), volume: clamp(clip.volume, 0, 2),
    brightness: clamp(clip.brightness, -1, 1), contrast: clamp(clip.contrast, 0, 2),
    saturation: clamp(clip.saturation, 0, 3), hue: clamp(clip.hue, -180, 180),
    scaleX: clamp(clip.scaleX, 1, 4), scaleY: clamp(clip.scaleY, 1, 4),
    positionX: clamp(clip.positionX, -100, 100), positionY: clamp(clip.positionY, -100, 100),
    fadeInMs: clamp(clip.fadeInMs, 0, adjustedDuration / 2),
    fadeOutMs: clamp(clip.fadeOutMs, 0, adjustedDuration / 2),
  };
}

function normalizeTransitions(clips: Clip[]) {
  return clips.map((clip, index) => {
    const following = clips[index + 1];
    if (!following || clip.transition.type === "cut") return { ...clip, transition: { type: "cut" as const, durationMs: 0 } };
    const maximum = Math.min(clipDuration(clip), clipDuration(following)) / 2;
    const durationMs = clamp(clip.transition.durationMs, 50, maximum);
    const expectedStart = clip.timelineStartMs + clipDuration(clip) - durationMs;
    return Math.abs(following.timelineStartMs - expectedStart) <= 1
      ? { ...clip, transition: { ...clip.transition, durationMs } }
      : { ...clip, transition: { type: "cut" as const, durationMs: 0 } };
  });
}

function assertTimelineLayout(clips: Clip[]) {
  const sorted = [...clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  sorted.forEach((clip) => {
    if (!Number.isFinite(clip.timelineStartMs) || clip.timelineStartMs < 0) throw new Error("Invalid timeline position");
  });
  for (let index = 1; index < sorted.length; index++) {
    const prior = sorted[index - 1];
    const allowedOverlap = prior.transition.type === "cut" ? 0 : prior.transition.durationMs;
    if (sorted[index].timelineStartMs < prior.timelineStartMs + clipDuration(prior) - allowedOverlap - 1) throw new Error("Clips cannot overlap");
  }
}

function subtractRanges(clip: Clip, ranges: Array<{ startMs: number; endMs: number }>) {
  let pieces = [{ startMs: clip.sourceInMs, endMs: clip.sourceOutMs }];
  for (const range of ranges) {
    pieces = pieces.flatMap((piece) => {
      if (!overlaps(piece, range)) return [piece];
      const result: Array<{ startMs: number; endMs: number }> = [];
      if (range.startMs - piece.startMs >= 50) result.push({ startMs: piece.startMs, endMs: Math.min(range.startMs, piece.endMs) });
      if (piece.endMs - range.endMs >= 50) result.push({ startMs: Math.max(range.endMs, piece.startMs), endMs: piece.endMs });
      return result;
    });
  }
  return pieces.map((piece, index) => ({
    ...clip,
    id: index === 0 ? clip.id : id(),
    timelineStartMs: clip.timelineStartMs + (piece.startMs - clip.sourceInMs) / clip.speed,
    sourceInMs: piece.startMs,
    sourceOutMs: piece.endMs,
    transition: index === pieces.length - 1 ? clip.transition : { type: "cut" as const, durationMs: 0 },
  }));
}

export function validateState(value: unknown): asserts value is ProjectState {
  const state = value as ProjectState;
  if (!state || typeof state !== "object" || typeof state.id !== "string" || typeof state.name !== "string" || !Number.isInteger(state.version) || !Number.isFinite(state.durationMs) || state.durationMs <= 0) throw new Error("Invalid project state");
  if (!Array.isArray(state.clips) || !state.clips.length || new Set(state.clips.map((clip) => clip.id)).size !== state.clips.length) throw new Error("Invalid clips");
  state.clips.forEach((clip) => {
    normalizeClip(clip, state.durationMs);
    if (!["cut", "crossfade", "fade-black"].includes(clip.transition.type) || !Number.isFinite(clip.transition.durationMs) || clip.transition.durationMs < 0) throw new Error("Invalid transition");
  });
  assertTimelineLayout(state.clips);
  for (const collection of [state.protectedRanges, state.broll]) {
    if (!Array.isArray(collection)) throw new Error("Invalid source ranges");
    collection.forEach((range) => validateRange(range.startMs, range.endMs, state.durationMs));
  }
  const duration = timelineDuration(state);
  for (const collection of [state.captions, state.overlays]) {
    if (!Array.isArray(collection)) throw new Error("Invalid text items");
    collection.forEach((item) => validateRange(item.startMs, item.endMs, duration));
  }
  if (!Array.isArray(state.activity)) throw new Error("Invalid activity");
}

export function applyCommand(state: ProjectState, command: EditorCommand): ProjectState {
  if (command.expectedVersion !== state.version) throw new Error(`STALE_VERSION:${state.version}`);
  const next: ProjectState = structuredClone(state);
  const summary = command.type.replaceAll("_", " ");
  const clipIndex = "clipId" in command ? next.clips.findIndex((clip) => clip.id === command.clipId) : -1;
  if ("clipId" in command && clipIndex < 0) throw new Error("Clip not found");

  switch (command.type) {
    case "split_clip": { 
      const clip = next.clips[clipIndex];
      validateRange(clip.sourceInMs, command.sourceMs, state.durationMs);
      validateRange(command.sourceMs, clip.sourceOutMs, state.durationMs);
      const left = { ...clip, sourceOutMs: command.sourceMs, fadeOutMs: 0, transition: { type: "cut" as const, durationMs: 0 } };
      const right = { ...clip, id: id(), timelineStartMs: clip.timelineStartMs + (command.sourceMs - clip.sourceInMs) / clip.speed, sourceInMs: command.sourceMs, fadeInMs: 0 };
      next.clips.splice(clipIndex, 1, left, right);
      break;
    }
    case "trim_clip": {
      const clip = next.clips[clipIndex];
      validateRange(command.sourceInMs, command.sourceOutMs, state.durationMs);
      if (command.sourceInMs > clip.sourceInMs) assertNotProtected(state, { startMs: clip.sourceInMs, endMs: command.sourceInMs });
      if (command.sourceOutMs < clip.sourceOutMs) assertNotProtected(state, { startMs: command.sourceOutMs, endMs: clip.sourceOutMs });
      next.clips[clipIndex] = normalizeClip({ ...clip, timelineStartMs: clip.timelineStartMs + (command.sourceInMs - clip.sourceInMs) / clip.speed, sourceInMs: command.sourceInMs, sourceOutMs: command.sourceOutMs }, state.durationMs);
      break;
    }
    case "delete_clip": {
      const clip = next.clips[clipIndex];
      assertNotProtected(state, { startMs: clip.sourceInMs, endMs: clip.sourceOutMs });
      next.clips.splice(clipIndex, 1);
      break;
    }
    case "remove_segments": {
      for (const range of command.ranges) {
        validateRange(range.startMs, range.endMs, state.durationMs);
        assertNotProtected(state, range);
      }
      next.clips = next.clips.flatMap((clip) => subtractRanges(clip, command.ranges));
      break;
    }
    case "reorder_clips": {
      if (new Set(command.clipIds).size !== next.clips.length || command.clipIds.some((clipId) => !next.clips.some((clip) => clip.id === clipId))) throw new Error("Clip order must include every clip exactly once");
      let cursor = 0;
      next.clips = command.clipIds.map((clipId) => {
        const clip = next.clips.find((item) => item.id === clipId)!;
        const positioned = { ...clip, timelineStartMs: cursor };
        cursor += clipDuration(positioned) - positioned.transition.durationMs;
        return positioned;
      });
      break;
    }
    case "move_clip":
      next.clips[clipIndex] = { ...next.clips[clipIndex], timelineStartMs: command.timelineStartMs };
      break;
    case "adjust_clip":
      next.clips[clipIndex] = normalizeClip({ ...next.clips[clipIndex], ...command.patch }, state.durationMs);
      break;
    case "set_transition": { 
      const clip = next.clips[clipIndex];
      const following = next.clips[clipIndex + 1];
      if (!following && command.transition.type !== "cut") throw new Error("The last clip cannot transition to another clip");
      const max = following ? Math.min(clipDuration(clip), clipDuration(following)) / 2 : 0;
      const durationMs = command.transition.type === "cut" ? 0 : clamp(command.transition.durationMs, 50, max);
      if (following && command.transition.type !== "cut") {
        const clipEnd = clip.timelineStartMs + clipDuration(clip);
        const currentExpectedStart = clipEnd - (clip.transition.type === "cut" ? 0 : clip.transition.durationMs);
        if (Math.abs(following.timelineStartMs - currentExpectedStart) > 1) throw new Error("Transitions require touching clips");
        next.clips[clipIndex + 1] = { ...following, timelineStartMs: clipEnd - durationMs };
      }
      next.clips[clipIndex] = { ...clip, transition: { type: command.transition.type, durationMs } };
      break;
    }
    case "protect_segment":
      validateRange(command.startMs, command.endMs, state.durationMs);
      next.protectedRanges.push({ id: id(), startMs: command.startMs, endMs: command.endMs, label: command.label.trim() || "Protected" });
      break;
    case "unprotect_segment":
      next.protectedRanges = next.protectedRanges.filter((range) => range.id !== command.rangeId);
      break;
    case "add_caption":
    case "add_overlay": {
      validateRange(command.item.startMs, command.item.endMs, timelineDuration(state));
      const key = command.type === "add_caption" ? "captions" : "overlays";
      next[key].push({ ...command.item, id: id(), text: command.item.text.trim() });
      break;
    }
    case "set_captions":
      command.items.forEach((item) => validateRange(item.startMs, item.endMs, timelineDuration(state)));
      next.captions = command.items.map((item) => ({ ...item, id: item.id ?? id(), text: item.text.trim() }));
      break;
    case "remove_caption":
      next.captions = next.captions.filter((item) => item.id !== command.id);
      break;
    case "remove_overlay":
      next.overlays = next.overlays.filter((item) => item.id !== command.id);
      break;
    case "mark_broll":
      validateRange(command.startMs, command.endMs, state.durationMs);
      next.broll.push({ id: id(), startMs: command.startMs, endMs: command.endMs, label: command.label.trim() || "B-roll" });
      break;
    case "remove_broll":
      next.broll = next.broll.filter((item) => item.id !== command.id);
      break;
  }

  if (!next.clips.length) throw new Error("Timeline must contain at least one clip");
  next.clips.sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  assertTimelineLayout(next.clips);
  next.clips = normalizeTransitions(next.clips);
  assertTimelineLayout(next.clips);
  next.version = state.version + 1;
  next.activity = [{ id: id(), at: new Date().toISOString(), actor: command.actor, summary }, ...state.activity].slice(0, 100);
  return next;
}
