import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createProjectState } from "@/lib/editor";
import { TranscriptPanel } from "./editor";

test("partial transcript retains a retry action and neutral cancellation status", () => {
  const state = createProjectState("p", "Test", 600000);
  const html = renderToStaticMarkup(<TranscriptPanel state={state}
    transcript={[{ id: "done", word: "Completed", startMs: 100, endMs: 200 }]}
    playheadMs={0} dispatch={() => state} transcribeVideo={async () => state}
    automaticStatus="" transcriptionNotice="Cancelled. Completed transcription saved."
    cancelTranscription={() => {}} seekTimeline={() => {}} setError={() => {}} />);
  expect(html).toContain("Cancelled. Completed transcription saved.");
  expect(html).toContain('role="status"');
  expect(html).not.toContain('role="alert"');
  expect(html).toContain("Completed</button>");
  const retry = html.match(/<button[^>]*>Continue \/ transcribe<\/button>/)?.[0];
  expect(retry).toBeDefined();
  expect(retry).not.toContain("disabled");
  expect(html).not.toContain("Cancel transcription");
});
