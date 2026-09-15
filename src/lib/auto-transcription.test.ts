import { expect, test } from "bun:test";
import { queueAutoTranscription, takeAutoTranscription } from "./auto-transcription";

test("auto transcription only consumes explicitly queued new uploads, once", () => {
  expect(takeAutoTranscription("reopened-project")).toBe(false);
  queueAutoTranscription("new-upload");
  expect(takeAutoTranscription("other-project")).toBe(false);
  expect(takeAutoTranscription("new-upload")).toBe(true);
  expect(takeAutoTranscription("new-upload")).toBe(false);
});
