import { clipDuration, timelineClips, type Clip, type ProjectState } from "./editor";

export const FRAME_WIDTH = 1920;
export const FRAME_HEIGHT = 1080;
export const FRAME_RATE = 30;
export const AUDIO_RATE = 48000;
export const TEXT_COLORS = { white: "#ffffff", yellow: "#ffe066", lime: "#d9ff63" };
const unit = (value: number) => Math.max(0, Math.min(1, value));

/** One definition of edge/transition envelopes for preview, audio and export. */
export function clipEnvelope(state: ProjectState, clip: Clip, timeMs: number, previous?: Clip | null) {
  const duration = clipDuration(clip);
  const elapsed = timeMs - clip.timelineStartMs;
  if (elapsed < 0 || elapsed >= duration) return { video: 0, audio: 0 };
  let prior = previous;
  if (prior === undefined) {
    const entries = timelineClips(state);
    const index = entries.findIndex((entry) => entry.clip.id === clip.id);
    prior = entries[index - 1]?.clip;
  }
  const edge = Math.min(clip.fadeInMs ? unit(elapsed / clip.fadeInMs) : 1, clip.fadeOutMs ? unit((duration - elapsed) / clip.fadeOutMs) : 1);
  let video = edge;
  let audio = edge;
  if (prior && prior.transition.type !== "cut" && prior.transition.durationMs > 0 && elapsed < prior.transition.durationMs) {
    const progress = unit(elapsed / prior.transition.durationMs);
    const incoming = prior.transition.type === "fade-black" ? unit(progress * 2 - 1) : progress;
    video *= incoming; audio *= incoming;
  }
  const remaining = duration - elapsed;
  if (clip.transition.type !== "cut" && clip.transition.durationMs > 0 && remaining <= clip.transition.durationMs) {
    const progress = unit(1 - remaining / clip.transition.durationMs);
    if (clip.transition.type === "fade-black") { video *= unit(1 - progress * 2); audio *= unit(1 - progress * 2); }
    else audio *= 1 - progress; // The incoming alpha composites over the opaque outgoing picture.
  }
  return { video, audio };
}

export function framePlan(state: ProjectState, timeMs: number) {
  return timelineClips(state).filter((entry) => timeMs >= entry.startMs && timeMs < entry.endMs).map(({ clip }) => ({
    clip, sourceSeconds: (clip.sourceInMs + (timeMs - clip.timelineStartMs) * clip.speed) / 1000,
    ...clipEnvelope(state, clip, timeMs),
  }));
}

export function musicGain(volume: number, muted: boolean, timeMs: number, startMs: number, endMs: number, fadeInMs: number, fadeOutMs: number) {
  if (muted || timeMs < startMs || timeMs >= endMs) return 0;
  return volume * Math.min(fadeInMs ? unit((timeMs - startMs) / fadeInMs) : 1, fadeOutMs ? unit((endMs - timeMs) / fadeOutMs) : 1);
}
