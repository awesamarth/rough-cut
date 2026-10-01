import { cloudflare, jsonError } from "@/lib/server";
import { sanitizeTranscript, type TranscriptWord } from "@/lib/editor";
import { transcriptionDurationSeconds } from "@/lib/transcription-audio";
import { reserveCloudUsage } from "@/lib/cloud-budget";
import { readBody } from "@/lib/request-body";

export const dynamic = "force-dynamic";

type RawWord = { word?: string; start?: number; end?: number; confidence?: number; probability?: number };
type WhisperResult = { text?: string; words?: RawWord[]; segments?: Array<{ words?: RawWord[] }> };

function normalize(result: WhisperResult): { text: string; words: TranscriptWord[] } {
  const rawWords = result.words ?? result.segments?.flatMap((segment) => segment.words ?? []) ?? [];
  return {
    text: result.text ?? rawWords.map((word) => word.word).join(" "),
    words: sanitizeTranscript(rawWords.filter((word) => word.word && Number.isFinite(word.start) && Number.isFinite(word.end)).map((word) => ({
      id: crypto.randomUUID(),
      word: word.word!,
      startMs: word.start! * 1000,
      endMs: word.end! * 1000,
      confidence: word.confidence ?? word.probability,
    }))),
  };
}

export async function POST(request: Request) {
  let body: Uint8Array<ArrayBuffer>;
  try { body = await readBody(request, 11 * 1024 * 1024); }
  catch { return jsonError("Audio chunk is too large", 413); }
  const form = await new Response(body, { headers: { "content-type": request.headers.get("content-type") || "" } }).formData().catch(() => null);
  if (!form) return jsonError("Invalid transcription request");
  const audio = form.get("audio");
  const provider = form.get("provider") === "openai" ? "openai" : "cloudflare";
  if (!(audio instanceof File) || !audio.size || audio.size > 10 * 1024 * 1024) return jsonError("A prepared PCM WAV audio chunk up to five minutes is required");
  const bytes = await audio.arrayBuffer();
  let duration: number;
  try { duration = transcriptionDurationSeconds(bytes); }
  catch (error) { return jsonError(error instanceof Error ? error.message : "Invalid audio"); }

  if (provider === "openai") {
    const key = request.headers.get("x-openai-key");
    if (!key) return jsonError("OpenAI API key is required", 401);
    const upstream = new FormData();
    upstream.set("file", audio, audio.name || "chunk.mp3");
    upstream.set("model", "whisper-1");
    upstream.set("response_format", "verbose_json");
    upstream.append("timestamp_granularities[]", "word");
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: upstream });
    if (!response.ok) return jsonError("OpenAI transcription failed", response.status, await response.text());
    return Response.json(normalize(await response.json() as WhisperResult));
  }

  let env: CloudflareEnv & { CLOUD_TRANSCRIPTION_DAILY_MINUTES?: string };
  try { env = cloudflare(); }
  catch { return jsonError("Cloud transcription is not configured here. For local cloud development, start with ENABLE_CLOUD_DEV=1, or use your own OpenAI key.", 503); }
  const minutes = Number(env.CLOUD_TRANSCRIPTION_DAILY_MINUTES ?? 0);
  if (!Number.isSafeInteger(minutes) || minutes <= 0) return jsonError("Cloud transcription is unavailable. You can use your own OpenAI key.", 503);
  if (!await reserveCloudUsage(env.DB, "transcription-seconds", duration, minutes * 60, 120)) return jsonError("This app's daily transcription allowance has been reached. No inference was started.", 429);
  const ai = env.AI as unknown as { run(model: string, input: Record<string, unknown>): Promise<WhisperResult> };
  const result = await ai.run("@cf/openai/whisper-large-v3-turbo", {
    audio: Buffer.from(bytes).toString("base64"),
    task: "transcribe",
    vad_filter: true,
  });
  return Response.json(normalize(result));
}
