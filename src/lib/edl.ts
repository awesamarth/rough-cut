import { clipDuration, type ProjectState } from "./editor";

const FPS = 30;

function timecode(ms: number) {
  const frames = Math.max(0, Math.round((ms / 1000) * FPS));
  const ff = frames % FPS;
  const seconds = Math.floor(frames / FPS);
  const ss = seconds % 60;
  const minutes = Math.floor(seconds / 60);
  const mm = minutes % 60;
  const hh = Math.floor(minutes / 60);
  return [hh, mm, ss, ff].map((part) => String(part).padStart(2, "0")).join(":");
}

export function exportEdl(state: ProjectState) {
  let recordMs = 0;
  const lines = [`TITLE: ${state.name}`, "FCM: NON-DROP FRAME", ""];

  state.clips.forEach((clip, index) => {
    const duration = clipDuration(clip);
    const transitionFrames = Math.round((clip.transition.durationMs / 1000) * FPS);
    const transition = clip.transition.type === "cut" ? "C" : `D ${String(transitionFrames).padStart(3, "0")}`;
    const recordOut = recordMs + duration;
    lines.push(
      `${String(index + 1).padStart(3, "0")}  AX       V     ${transition.padEnd(7)} ${timecode(clip.sourceInMs)} ${timecode(clip.sourceOutMs)} ${timecode(recordMs)} ${timecode(recordOut)}`,
      `* FROM CLIP NAME: ${state.name}`,
      `* ROUGH_CUT CLIP ID: ${clip.id}`,
      "",
    );
    recordMs = recordOut - clip.transition.durationMs;
  });

  return lines.join("\n");
}
