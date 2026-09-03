import { cloudflare, jsonError } from "@/lib/server";
import { sanitizeTranscript, type TranscriptWord } from "@/lib/editor";

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
  const form = await request.formData();
  const audio = form.get("audio");
  const provider = form.get("provider") === "openai" ? "openai" : "cloudflare";
  if (!(audio instanceof File) || !audio.size || audio.size > 20 * 1024 * 1024) return jsonError("A valid audio chunk up to 20 MB is required");

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

  const ai = cloudflare().AI as unknown as { run(model: string, input: Record<string, unknown>): Promise<WhisperResult> };
  const result = await ai.run("@cf/openai/whisper-large-v3-turbo", {
    audio: Buffer.from(await audio.arrayBuffer()).toString("base64"),
    task: "transcribe",
    vad_filter: true,
  });
  return Response.json(normalize(result));
}
