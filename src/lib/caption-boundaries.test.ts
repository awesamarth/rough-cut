import { expect, test } from "bun:test";
import { applyCommand, applyEdit, captionsFromTranscript, createProjectState, reconcileAnchoredCaptions } from "./editor";

const words = [{ id: "a", word: "Hello", startMs: 900, endMs: 1100 }, { id: "b", word: "there.", startMs: 1150, endMs: 1400 }];
function split() {
  const state = createProjectState("p", "Boundary", 3000);
  return applyCommand(state, { type: "split_clip", expectedVersion: 0, actor: "human", clipId: state.clips[0].id, sourceMs: 1000 });
}

test("plain splits retain boundary words exactly once regardless of capitalisation", () => {
  for (const word of ["Hello", "hello"]) {
    const captions = captionsFromTranscript(split(), [{ ...words[0], word }, words[1]]);
    expect(captions.map((cue) => cue.text).join(" ")).toBe(`${word} there.`);
    expect(captions.flatMap((cue) => cue.sourceWordIds)).toEqual(["a", "b"]);
    expect(captions[0].startMs).toBe(900);
    expect(captions[0].endMs).toBe(1400);
  }
});

test("boundary timestamps map piecewise through differing clip speeds", () => {
  const state = split();
  state.clips[0].speed = 2;
  state.clips[1].timelineStartMs = 500;
  const captions = captionsFromTranscript(state, words);
  expect(captions[0]).toMatchObject({ startMs: 450, endMs: 900, sourceWordIds: ["a", "b"] });
});

test("multiple plain splits inside a single word do not lose or duplicate it", () => {
  const state = split();
  const next = applyCommand(state, { type: "split_clip", expectedVersion: state.version, actor: "human", clipId: state.clips[1].id, sourceMs: 1050 });
  expect(captionsFromTranscript(next, words).flatMap((cue) => cue.sourceWordIds)).toEqual(["a", "b"]);
});

test("actual trims, deleted speech, timeline gaps and reordered source do not resurrect partial words", () => {
  for (const mode of ["trim", "source-gap", "timeline-gap", "reorder", "transition"]) {
    const state = split();
    if (mode === "trim") state.clips.shift();
    if (mode === "source-gap") state.clips[0].sourceOutMs = 950;
    if (mode === "timeline-gap") state.clips[1].timelineStartMs += 100;
    if (mode === "reorder") { state.clips[0].timelineStartMs = 2000; state.clips[1].timelineStartMs = 0; }
    if (mode === "transition") state.clips[0].transition = { type: "crossfade", durationMs: 100 };
    expect(captionsFromTranscript(state, words).flatMap((cue) => cue.sourceWordIds)).not.toContain("a");
  }
});

test("anchored words survive a plain split and subsequent speed reconciliation", () => {
  const state = createProjectState("p", "Boundary", 3000);
  state.captions = captionsFromTranscript(state, words).map((cue) => ({ ...cue, id: "caption" }));
  const edited = applyEdit({ state, transcript: words }, { type: "split_clip", expectedVersion: 0, actor: "human", clipId: state.clips[0].id, sourceMs: 1000 });
  expect(edited.state.captions.flatMap((cue) => cue.sourceWordIds)).toEqual(["a", "b"]);
  const faster = applyCommand(edited.state, { type: "adjust_clip", expectedVersion: edited.state.version, actor: "human", clipId: edited.state.clips[0].id, patch: { speed: 2 } });
  expect(reconcileAnchoredCaptions(edited.state, faster, words).flatMap((cue) => cue.sourceWordIds)).toEqual(["a", "b"]);
});
