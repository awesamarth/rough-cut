import { describe, expect, test } from "bun:test";
import { applyCommand, captionsFromTranscript, correctTranscriptWords, createProjectState, excludeTranscriptFromSilences, exportSrt, groupCaptionWords, partitionCaptionWords, reconcileAnchoredCaptions, sanitizeTranscript, timelineDuration, type TranscriptWord } from "./editor";

describe("editing commands", () => {
  test("corrects an anchored transcript span without fuzzy text matching", () => {
    expect(correctTranscriptWords([
      { id: "rough", word: "Ruff", startMs: 1000, endMs: 1200 },
      { id: "cut", word: "Cut", startMs: 1250, endMs: 1450 },
      { id: "other", word: "works", startMs: 1500, endMs: 1800 },
    ], ["rough", "cut"], "ROUGH//CUT")).toEqual({
      anchorId: "rough",
      words: [
        { id: "rough", word: "ROUGH//CUT", startMs: 1000, endMs: 1450 },
        { id: "other", word: "works", startMs: 1500, endMs: 1800 },
      ],
    });
  });

  test("splits silence candidates around transcript words instead of dropping the whole range", () => {
    expect(excludeTranscriptFromSilences(
      [{ startMs: 0, endMs: 30_000 }],
      [{ id: "word", word: "hello", startMs: 10_000, endMs: 11_000 }],
      200,
      500,
    )).toEqual([{ startMs: 0, endMs: 9800 }, { startMs: 11_200, endMs: 30_000 }]);
  });

  test("drops malformed Whisper words before persistence", () => {
    expect(sanitizeTranscript([
      { id: "valid", word: " hello ", startMs: 100.2, endMs: 300.4 },
      { id: "zero", word: "bad", startMs: 500.1, endMs: 500.4 },
      { id: "empty", word: " ", startMs: 600, endMs: 700 },
    ])).toEqual([{ id: "valid", word: "hello", startMs: 100, endMs: 300 }]);
  });

  test("normalizes fractional media duration to whole milliseconds", () => {
    const state = createProjectState("00000000-0000-4000-8000-000000000000", "Short", 5866.667);
    expect(state.durationMs).toBe(5867);
    expect(state.clips[0].sourceOutMs).toBe(5867);
  });

  test("renames projects through the versioned command layer", () => {
    const state = createProjectState("00000000-0000-4000-8000-000000000000", "Untitled", 1000);
    const next = applyCommand(state, { type: "rename_project", expectedVersion: 0, actor: "human", name: "  Interview cut  " });
    expect(next.name).toBe("Interview cut");
    expect(next.version).toBe(1);
    expect(() => applyCommand(next, { type: "rename_project", expectedVersion: 1, actor: "human", name: "  " })).toThrow("1–120");
  });

  test("splits generated caption groups at speech pauses", () => {
    const words = [
      { id: "1", word: "Hey", startMs: 1000, endMs: 1200 },
      { id: "2", word: "guys", startMs: 1250, endMs: 1500 },
      { id: "3", word: "what's", startMs: 6000, endMs: 6250 },
      { id: "4", word: "up?", startMs: 6300, endMs: 6500 },
    ] satisfies TranscriptWord[];
    expect(groupCaptionWords(words).map((group) => group.map((word) => word.word))).toEqual([["Hey", "guys"], ["what's", "up?"]]);
  });

  test("retimes subtitles locally when clip speed changes", () => {
    let state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 10_000);
    state = applyCommand(state, { type: "add_caption", expectedVersion: 0, actor: "human", item: { text: "Hello", startMs: 6000, endMs: 8000, position: "bottom" } });
    state = applyCommand(state, { type: "adjust_clip", expectedVersion: 1, actor: "human", clipId: state.clips[0].id, patch: { speed: 2 } });
    expect(state.captions[0]).toMatchObject({ startMs: 3000, endMs: 4000 });
    expect(timelineDuration(state)).toBe(5000);
  });

  test("rejects stale and protected destructive edits", () => {
    let state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 10_000);
    state = applyCommand(state, { type: "protect_segment", expectedVersion: 0, actor: "human", startMs: 3000, endMs: 5000, label: "Keep" });
    expect(() => applyCommand(state, { type: "split_clip", expectedVersion: 0, actor: "agent", clipId: state.clips[0].id, sourceMs: 2000 })).toThrow("STALE_VERSION:1");
    expect(() => applyCommand(state, { type: "remove_segments", expectedVersion: 1, actor: "agent", ranges: [{ startMs: 4000, endMs: 4500 }] })).toThrow("Protected range");
  });

  test("ripple-removes source ranges and retimes captions", () => {
    const state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 10_000);
    state.captions = [
      { id: "before", text: "Before", startMs: 1000, endMs: 2000, position: "bottom" },
      { id: "removed", text: "Silence", startMs: 4500, endMs: 5500, position: "bottom" },
      { id: "after", text: "After", startMs: 7000, endMs: 8000, position: "bottom" },
    ];
    const next = applyCommand(state, { type: "remove_segments", expectedVersion: 0, actor: "human", ranges: [{ startMs: 4000, endMs: 6000 }] });
    expect(next.clips.map((clip) => [clip.timelineStartMs, clip.sourceInMs, clip.sourceOutMs])).toEqual([[0, 0, 4000], [4000, 6000, 10_000]]);
    expect(next.captions.map((caption) => [caption.id, caption.startMs, caption.endMs])).toEqual([["before", 1000, 2000], ["after", 5000, 6000]]);
    expect(timelineDuration(next)).toBe(8000);
    expect(next.version).toBe(1);
  });

  test("resyncs repeated transcript text by source occurrence", () => {
    const state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 10_000);
    const cut = applyCommand(state, { type: "remove_segments", expectedVersion: 0, actor: "human", ranges: [{ startMs: 0, endMs: 6000 }] });
    const captions = captionsFromTranscript(cut, [
      { id: "first", word: "hey", startMs: 1000, endMs: 1200 },
      { id: "clean", word: "hey", startMs: 7000, endMs: 7200 },
    ]);
    expect(captions).toEqual([{ text: "hey", startMs: 1000, endMs: 1200, position: "bottom", sourceWordIds: ["clean"] }]);
  });

  test("supports lift and ripple-delete semantics", () => {
    let state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 5000);
    state.captions = [{ id: "later", text: "Later", startMs: 2000, endMs: 3000, position: "bottom" }];
    state = applyCommand(state, { type: "split_clip", expectedVersion: 0, actor: "human", clipId: state.clips[0].id, sourceMs: 1000 });
    const firstId = state.clips[0].id;
    const lifted = applyCommand(state, { type: "delete_clip", expectedVersion: 1, actor: "human", clipId: firstId });
    const rippled = applyCommand(state, { type: "delete_clip", expectedVersion: 1, actor: "human", clipId: firstId, ripple: true });
    expect(lifted.clips[0].timelineStartMs).toBe(1000);
    expect(lifted.captions[0].startMs).toBe(2000);
    expect(rippled.clips[0].timelineStartMs).toBe(0);
    expect(rippled.captions[0].startMs).toBe(1000);
  });

  test("transforms existing anchored captions without regenerating duplicates", () => {
    const transcript = [
      { id: "a", word: "one", startMs: 500, endMs: 900 },
      { id: "b", word: "two", startMs: 1500, endMs: 1900 },
      { id: "c", word: "three", startMs: 5500, endMs: 5900 },
      { id: "d", word: "four", startMs: 6500, endMs: 6900 },
    ] satisfies TranscriptWord[];
    let state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 10_000);
    state.captions = captionsFromTranscript(state, transcript).map((caption, index) => ({ ...caption, id: `caption-${index}` }));
    state = applyCommand(state, { type: "split_clip", expectedVersion: 0, actor: "human", clipId: state.clips[0].id, sourceMs: 5000 });
    const beforeDelete = state;
    const lifted = applyCommand(beforeDelete, { type: "delete_clip", expectedVersion: 1, actor: "human", clipId: beforeDelete.clips[0].id });
    lifted.captions = reconcileAnchoredCaptions(beforeDelete, lifted, transcript);
    const rippled = applyCommand(beforeDelete, { type: "delete_clip", expectedVersion: 1, actor: "human", clipId: beforeDelete.clips[0].id, ripple: true });
    rippled.captions = reconcileAnchoredCaptions(beforeDelete, rippled, transcript);
    expect(lifted.captions.flatMap((caption) => caption.sourceWordIds ?? [])).toEqual(["c", "d"]);
    expect(lifted.captions[0]).toMatchObject({ startMs: 5500, endMs: 6900 });
    expect(rippled.captions.flatMap((caption) => caption.sourceWordIds ?? [])).toEqual(["c", "d"]);
    expect(rippled.captions[0]).toMatchObject({ startMs: 500, endMs: 1900 });
  });

  test("preserves anchored caption timing offsets through speed changes", () => {
    const transcript = [{ id: "word", word: "hello", startMs: 1000, endMs: 2000 }] satisfies TranscriptWord[];
    const state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 5000);
    state.captions = [{ id: "caption", text: "hello", startMs: 900, endMs: 2100, position: "bottom", sourceWordIds: ["word"] }];
    const faster = applyCommand(state, { type: "adjust_clip", expectedVersion: 0, actor: "human", clipId: state.clips[0].id, patch: { speed: 2 } });
    faster.captions = reconcileAnchoredCaptions(state, faster, transcript);
    expect(faster.captions[0]).toMatchObject({ startMs: 450, endMs: 1050, sourceWordIds: ["word"] });
  });

  test("partitions transcript anchors when splitting a generated caption", () => {
    const transcript = [
      { id: "left", word: "hello", startMs: 1000, endMs: 1400 },
      { id: "right", word: "world", startMs: 1600, endMs: 2000 },
    ] satisfies TranscriptWord[];
    const state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 5000);
    const caption = { id: "caption", text: "hello world", startMs: 1000, endMs: 2000, position: "bottom" as const, sourceWordIds: ["left", "right"] };
    expect(partitionCaptionWords(state, transcript, caption, 1500)).toEqual({
      left: { sourceWordIds: ["left"], text: "hello" },
      right: { sourceWordIds: ["right"], text: "world" },
    });
  });

  test("normalizes clip transforms", () => {
    const state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 5000);
    const next = applyCommand(state, { type: "adjust_clip", expectedVersion: 0, actor: "human", clipId: state.clips[0].id, patch: { scaleX: 0.1, scaleY: 5, positionX: 40, positionY: -25 } });
    expect(next.clips[0]).toMatchObject({ scaleX: 0.25, scaleY: 4, positionX: 40, positionY: -25 });
  });

  test("changes background-music speed and timeline duration", () => {
    let state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 5000);
    state = applyCommand(state, { type: "set_music", expectedVersion: 0, actor: "human", music: { assetId: "10000000-0000-4000-8000-000000000000", name: "bed.mp3", durationMs: 10_000, timelineStartMs: 0, sourceInMs: 0, sourceOutMs: 10_000, speed: 1, volume: 0.3, muted: false, fadeInMs: 0, fadeOutMs: 0, loop: false } });
    expect(timelineDuration(state)).toBe(10_000);
    state = applyCommand(state, { type: "adjust_music", expectedVersion: 1, actor: "human", clipId: state.music[0].id, patch: { speed: 2 } });
    expect(timelineDuration(state)).toBe(5000);
    expect(state.music[0].speed).toBe(2);
  });

  test("applies one shared subtitle background opacity", () => {
    const state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 5000);
    const next = applyCommand(state, { type: "set_caption_style", expectedVersion: 0, actor: "human", patch: { backgroundOpacity: 0.7 } });
    expect(next.captionStyle.backgroundOpacity).toBe(0.7);
    expect(() => applyCommand(next, { type: "set_caption_style", expectedVersion: 1, actor: "human", patch: { backgroundOpacity: 1.1 } })).toThrow("Invalid caption style");
  });

  test("edits captions and one bounded background-music track", () => {
    let state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 5000);
    state = applyCommand(state, { type: "add_caption", expectedVersion: 0, actor: "human", item: { text: "Hello", startMs: 0, endMs: 1000, position: "bottom" } });
    state = applyCommand(state, { type: "update_caption", expectedVersion: 1, actor: "human", id: state.captions[0].id, patch: { text: "Hello world", endMs: 1500 } });
    state = applyCommand(state, { type: "set_music", expectedVersion: 2, actor: "human", music: { assetId: "10000000-0000-4000-8000-000000000000", name: "bed.mp3", durationMs: 10_000, timelineStartMs: 0, sourceInMs: 0, sourceOutMs: 10_000, speed: 1, volume: 0.3, muted: false, fadeInMs: 250, fadeOutMs: 250, loop: false } });
    state = applyCommand(state, { type: "adjust_music", expectedVersion: 3, actor: "agent", clipId: state.music[0].id, patch: { volume: 9, timelineStartMs: 1000 } });
    expect(state.captions[0].text).toBe("Hello world");
    expect(exportSrt(state)).toContain("00:00:00,000 --> 00:00:01,500\nHello world");
    expect(state.music[0]).toMatchObject({ name: "bed.mp3", volume: 5, timelineStartMs: 1000, loop: false });
    expect(timelineDuration(state)).toBe(11_000);
    state = applyCommand(state, { type: "split_text", expectedVersion: 4, actor: "human", kind: "caption", id: state.captions[0].id, timelineMs: 500 });
    state = applyCommand(state, { type: "split_music", expectedVersion: 5, actor: "human", clipId: state.music[0].id, timelineMs: 5000 });
    expect(state.captions).toHaveLength(2);
    expect(state.music).toHaveLength(2);
    state = applyCommand(state, { type: "remove_music", expectedVersion: 6, actor: "human", clipId: state.music[0].id, ripple: true });
    expect(state.music).toHaveLength(1);
    expect(state.music[0].timelineStartMs).toBe(1000);
  });

  test("trims without rippling and allows non-overlapping gaps", () => {
    let state = createProjectState("00000000-0000-4000-8000-000000000000", "Demo", 5000);
    state = applyCommand(state, { type: "split_clip", expectedVersion: 0, actor: "human", clipId: state.clips[0].id, sourceMs: 1000 });
    const second = state.clips[1];
    state = applyCommand(state, { type: "trim_clip", expectedVersion: 1, actor: "human", clipId: second.id, sourceInMs: 2000, sourceOutMs: 5000 });
    expect(state.clips.map((clip) => [clip.timelineStartMs, clip.sourceInMs, clip.sourceOutMs])).toEqual([[0, 0, 1000], [2000, 2000, 5000]]);
    expect(() => applyCommand(state, { type: "move_clip", expectedVersion: 2, actor: "human", clipId: second.id, timelineStartMs: 500 })).toThrow("Clips cannot overlap");
    const joined = applyCommand(state, { type: "move_clip", expectedVersion: 2, actor: "human", clipId: second.id, timelineStartMs: 1000 });
    expect(joined.clips[1].timelineStartMs).toBe(1000);
  });
});
