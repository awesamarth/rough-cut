import { sanitizeTranscript, type ProjectState, type TranscriptWord } from "./editor";

export type TranscriptionRange = { startMs: number; endMs: number };

/** Transcript timestamps are source-based. Transcribe retained source once, regardless of order/speed/repetition. */
export function transcriptionRanges(state: ProjectState): TranscriptionRange[] {
  const merged: TranscriptionRange[] = [];
  for (const range of state.clips.map((clip) => ({ startMs: clip.sourceInMs, endMs: clip.sourceOutMs })).sort((a, b) => a.startMs - b.startMs)) {
    const last = merged.at(-1);
    if (last && range.startMs <= last.endMs) last.endMs = Math.max(last.endMs, range.endMs);
    else merged.push({ ...range });
  }
  return merged.flatMap((range) => {
    const chunks: TranscriptionRange[] = [];
    for (let startMs = range.startMs; startMs < range.endMs; startMs += 300_000) chunks.push({ startMs, endMs: Math.min(range.endMs, startMs + 300_000) });
    return chunks;
  });
}

export function sourceChunkWords(words: TranscriptWord[], range: TranscriptionRange): TranscriptWord[] {
  return sanitizeTranscript(words).map((word) => ({ ...word,
    startMs: range.startMs + Math.max(0, word.startMs),
    endMs: range.startMs + Math.min(range.endMs - range.startMs, word.endMs),
  })).filter((word) => word.startMs < word.endMs && word.startMs < range.endMs);
}

/** Replace only a completed source interval; preserve unprocessed words and their caption anchors. */
export function mergeTranscriptionChunk(previous: TranscriptWord[], incoming: TranscriptWord[], range: TranscriptionRange): TranscriptWord[] {
  if (!incoming.length) return previous; // Silence/empty provider results must not erase earlier human corrections.
  return [...previous.filter((word) => word.endMs <= range.startMs || word.startMs >= range.endMs), ...incoming].sort((a, b) => a.startMs - b.startMs);
}

export async function transcribeRanges(options: {
  ranges: TranscriptionRange[]; signal: AbortSignal; expectedVersion: number;
  state(): ProjectState; transcript(): TranscriptWord[];
  read(range: TranscriptionRange, index: number): Promise<TranscriptWord[]>;
  save(words: TranscriptWord[]): ProjectState; durability(): Promise<void>;
  saved(): void;
}) {
  let version = options.expectedVersion;
  const checkVersion = () => {
    if (options.state().version !== version) throw new Error("Project changed during transcription. Completed results were kept; start transcription again to continue.");
  };
  for (const [index, range] of options.ranges.entries()) {
    options.signal.throwIfAborted(); checkVersion();
    const words = sourceChunkWords(await options.read(range, index), range);
    checkVersion();
    if (words.length) {
      // A completed response is checkpointed even if Cancel arrives during its cache/save step.
      // Do not abort durability or replace any unprocessed intervals.
      version = options.save(mergeTranscriptionChunk(options.transcript(), words, range)).version;
      await options.durability();
      options.saved();
    }
  }
  options.signal.throwIfAborted(); checkVersion();
  return options.state();
}
