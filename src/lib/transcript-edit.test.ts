import { expect, test } from "bun:test";
import { captionsFromTranscript, correctTranscriptWords, createProjectState, replaceTranscript } from "./editor";

test("retranscription preserves IDs and edited captions, and never erases text with no matching speech", () => {
  const state = createProjectState("p", "Transcript", 1000);
  const transcript = [{ id: "a", word: "Hello", startMs: 0, endMs: 200 }, { id: "b", word: "world", startMs: 220, endMs: 450 }];
  state.captions = captionsFromTranscript(state, transcript).map((caption) => ({ ...caption, id: crypto.randomUUID() }));
  state.captions[0].text = "My edited caption";
  const result = replaceTranscript({ state, transcript }, transcript.map((word) => ({ ...word, id: crypto.randomUUID(), startMs: word.startMs + 10, endMs: word.endMs + 10 })), "human");
  expect(result.transcript.map((word) => word.id)).toEqual(["a", "b"]);
  expect(result.state.captions[0]).toEqual(state.captions[0]);
  expect(result.state.version).toBe(state.version + 1);
  const unmatched = replaceTranscript({ state, transcript }, [{ id: "fresh", word: "Different", startMs: 800, endMs: 1200 }], "human");
  expect(unmatched.state.captions[0].text).toBe("My edited caption");
  expect(unmatched.state.captions[0].sourceWordIds).toEqual([]);
  expect(unmatched.transcript[0].endMs).toBe(1000);
  expect(() => replaceTranscript({ state, transcript }, [], "human")).toThrow("preserved");
});

test("caption corrections preserve individual word IDs and unchanged word timing", () => {
  const words = [
    { id: "a", word: "This", startMs: 0, endMs: 100 },
    { id: "b", word: "iz", startMs: 120, endMs: 200 },
    { id: "c", word: "good", startMs: 220, endMs: 400 },
  ];
  const corrected = correctTranscriptWords(words, ["a", "b", "c"], "This is good")!;
  expect(corrected.anchorIds).toEqual(["a", "b", "c"]);
  expect(corrected.words.map((word) => word.word)).toEqual(["This", "is", "good"]);
  expect(corrected.words[0]).toEqual(words[0]);
  expect(corrected.words[2]).toEqual(words[2]);
  const expanded = correctTranscriptWords(words, ["a", "b", "c"], "This is really good")!;
  expect(expanded.words).toHaveLength(4);
  expect(expanded.words.at(-1)).toEqual(words[2]);
  expect(new Set(expanded.anchorIds).size).toBe(4);
  expect(expanded.words.every((word) => word.endMs > word.startMs)).toBe(true);
});
