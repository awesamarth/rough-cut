import { expect, test } from "bun:test";
import { createClip, createProjectState, replaceTranscript, type TranscriptWord } from "./editor";
import { mergeTranscriptionChunk, sourceChunkWords, transcribeRanges, transcriptionRanges } from "./transcription-plan";
const word = (id: string, startMs: number, endMs: number): TranscriptWord => ({ id, word: id, startMs, endMs, confidence: 1 });

test("37-minute source trimmed to one minute only schedules the retained source minute", () => {
  const state = createProjectState("p", "Test", 37 * 60_000);
  state.clips = [createClip(35 * 60_000, 36 * 60_000, 0)];
  expect(transcriptionRanges(state)).toEqual([{ startMs: 2_100_000, endMs: 2_160_000 }]);
  state.clips[0].speed = 2;
  expect(transcriptionRanges(state)).toHaveLength(1);
  expect(sourceChunkWords([word("hello", 1000, 1400)], transcriptionRanges(state)[0])[0].startMs).toBe(2_101_000);
});

test("source gaps stay excluded, repeated/reordered source intervals are transcribed once, chunks stay bounded", () => {
  const state = createProjectState("p", "Test", 900000);
  state.clips = [createClip(800000, 810000, 0), createClip(1000, 4000, 10000), createClip(2000, 4000, 13000), createClip(10000, 610001, 16000)];
  expect(transcriptionRanges(state)).toEqual([
    { startMs: 1000, endMs: 4000 }, { startMs: 10000, endMs: 310000 },
    { startMs: 310000, endMs: 610000 }, { startMs: 610000, endMs: 610001 }, { startMs: 800000, endMs: 810000 },
  ]);
});

test("chunk replacement keeps unprocessed words/anchors and rejects out-of-range words", () => {
  const previous = [word("old", 1000, 1200), word("keep", 8000, 8300)];
  const range = { startMs: 1000, endMs: 2000 };
  const next = sourceChunkWords([word("new", 0, 300), word("outside", 5000, 6000)], range);
  expect(next).toHaveLength(1);
  expect(mergeTranscriptionChunk(previous, next, range).map((item) => item.id)).toEqual(["new", "keep"]);
  expect(mergeTranscriptionChunk(previous, [], range)).toBe(previous);
  let state = createProjectState("p", "Test", 10000);
  state = { ...state, captions: [{ id: "caption", text: "Keep edited text", startMs: 8000, endMs: 8500, position: "bottom", fontSize: 54, color: "white", background: true, sourceWordIds: ["keep"] }] };
  const replaced = replaceTranscript({ state, transcript: previous }, mergeTranscriptionChunk(previous, next, range), "human");
  expect(replaced.state.captions[0].sourceWordIds).toEqual(["keep"]);
  expect(replaced.state.captions[0].text).toBe("Keep edited text");
});

function fixture() {
  let state = createProjectState("p", "Test", 600000);
  let transcript = [word("untouched", 500000, 500100)];
  let writes = 0, durable = 0;
  const controller = new AbortController();
  const options = {
    ranges: transcriptionRanges(state), signal: controller.signal, expectedVersion: state.version,
    state: () => state, transcript: () => transcript,
    save: (incoming: TranscriptWord[]) => { writes++; const next = replaceTranscript({ state, transcript }, incoming, "human"); state = next.state; transcript = next.transcript; return state; },
    durability: async () => { durable++; }, saved: () => {},
  };
  return { options, controller, counters: () => ({ writes, durable }), edit: () => { state = { ...state, version: state.version + 1 }; } };
}

test("cancel after one completed part retains it durably and never starts the next part", async () => {
  const f = fixture(); let reads = 0;
  await expect(transcribeRanges({ ...f.options, read: async () => { reads++; return [word("done", 100, 200)]; }, saved: () => f.controller.abort(new DOMException("Cancelled.", "AbortError")) })).rejects.toMatchObject({ name: "AbortError" });
  expect(reads).toBe(1);
  expect(f.counters()).toEqual({ writes: 1, durable: 1 });
  expect(f.options.transcript().map((item) => item.word)).toEqual(["done", "untouched"]);
});

test("later provider failure retains earlier completed transcript; cancel during checkpoint still saves completed part", async () => {
  const f = fixture();
  await expect(transcribeRanges({ ...f.options, read: async (_range, index) => { if (index) throw new Error("Provider failed"); return [word("done", 100, 200)]; } })).rejects.toThrow("Provider failed");
  expect(f.counters()).toEqual({ writes: 1, durable: 1 });
  const g = fixture();
  await expect(transcribeRanges({ ...g.options, read: async () => { g.controller.abort(); return [word("done", 100, 200)]; } })).rejects.toMatchObject({ name: "AbortError" });
  expect(g.counters()).toEqual({ writes: 1, durable: 1 });
});

test("external edits and durability failure stop before further work; pre-cancel performs no read/save", async () => {
  const f = fixture();
  await expect(transcribeRanges({ ...f.options, read: async () => { f.edit(); return [word("done", 100, 200)]; } })).rejects.toThrow("Project changed");
  expect(f.counters().writes).toBe(0);
  const g = fixture(); let reads = 0;
  await expect(transcribeRanges({ ...g.options, read: async () => { reads++; return [word("done", 100, 200)]; }, durability: async () => { throw new Error("Disk full"); } })).rejects.toThrow("Disk full");
  expect(reads).toBe(1);
  const h = fixture(); h.controller.abort();
  await expect(transcribeRanges({ ...h.options, read: async () => { throw new Error("must not read"); } })).rejects.toMatchObject({ name: "AbortError" });
  expect(h.counters().writes).toBe(0);
});
