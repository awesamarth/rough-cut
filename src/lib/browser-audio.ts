import { ANALYSIS_WINDOW_MS, type AudioAnalysis } from "./audio-analysis";

/** Immutable asset key; cache failures are optional, decoding failures are not. */
export async function analyzeAudio(source: string | Blob, assetKey: string, signal: AbortSignal): Promise<AudioAnalysis> {
  signal.throwIfAborted();
  let cache: Cache | undefined;
  const cacheKey = new URL(`/__rough_cut_audio_v2/${encodeURIComponent(assetKey)}`, location.origin).href;
  try {
    cache = await caches.open("rough-cut-audio-v2");
    const saved = await cache.match(cacheKey);
    if (saved) {
      const durationMs = Number(saved.headers.get("x-duration-ms"));
      const buffer = await saved.arrayBuffer();
      const hasAudio = saved.headers.get("x-has-audio") === "true";
      if (durationMs > 0 && durationMs <= 86_400_000 && buffer.byteLength === (hasAudio ? Math.ceil(durationMs / ANALYSIS_WINDOW_MS) * 4 : 0)) {
        signal.throwIfAborted();
        return { durationMs, windowMs: ANALYSIS_WINDOW_MS, hasAudio, peaks: new Float32Array(buffer) };
      }
    }
  } catch { signal.throwIfAborted(); }
  signal.throwIfAborted();
  const message = await runAudioWorker(source, signal);
  const result = message.result;
  if (!result) throw new Error("Audio analysis produced no result");
  signal.throwIfAborted();
  try {
    await cache?.put(cacheKey, new Response(result.peaks.slice().buffer, { headers: {
      "content-type": "application/octet-stream", "x-duration-ms": String(result.durationMs), "x-has-audio": String(result.hasAudio),
    } }));
  } catch { /* Quota/private-mode failure only disables the optional analysis cache. */ }
  return result;
}

type WorkerResult = { result?: AudioAnalysis; chunk?: ArrayBuffer; offsetMs?: number; hasSamples?: boolean; error?: string };

function runAudioWorker(source: string | Blob, signal: AbortSignal, chunk?: { startMs: number; endMs: number }) {
  signal.throwIfAborted();
  return new Promise<WorkerResult>((resolve, reject) => {
    const worker = new Worker(new URL("./media-analysis.worker.ts", import.meta.url), { type: "module" });
    const timeout = setTimeout(() => { cleanup(); reject(new Error("Audio processing timed out; try a shorter source")); }, 10 * 60_000);
    const cleanup = () => { clearTimeout(timeout); worker.terminate(); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = () => { cleanup(); reject(new Error("Could not run local audio worker")); };
    worker.onmessage = ({ data }: MessageEvent<WorkerResult>) => {
      cleanup();
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    worker.postMessage({ source, chunk });
  });
}

/** At most five minutes of mono 16 kHz PCM (~9.6 MB), not the whole source. */
export async function prepareAudioChunk(source: string | Blob, startMs: number, endMs: number, signal: AbortSignal) {
  const result = await runAudioWorker(source, signal, { startMs, endMs });
  if (!result.chunk || result.offsetMs !== startMs) throw new Error("Audio preparation produced an invalid chunk");
  return { audio: new Blob([result.chunk], { type: "audio/wav" }), offsetMs: result.offsetMs, hasSamples: result.hasSamples !== false };
}
