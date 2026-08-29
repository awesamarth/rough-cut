import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const PORT = Number(process.env.PORT || 8788);
const DATA_DIR = process.env.DATA_DIR || "/data/jobs";
const APP_ORIGIN = (process.env.APP_ORIGIN || "http://host.docker.internal:3000").replace(/\/$/, "");

type Clip = {
  id: string; sourceInMs: number; sourceOutMs: number; speed: number; volume: number; muted: boolean;
  brightness: number; contrast: number; saturation: number; hue: number; fadeInMs: number; fadeOutMs: number;
  transition: { type: "cut" | "crossfade" | "fade-black"; durationMs: number };
};
type TimedText = { text: string; startMs: number; endMs: number; position: "top" | "center" | "bottom" };
type ProjectState = { id: string; name: string; durationMs: number; clips: Clip[]; captions: TimedText[]; overlays: TimedText[] };
type Job = { id: string; kind: "export"; status: "queued" | "running" | "complete" | "failed"; error?: string; output?: string; createdAt: string };
const jobs = new Map<string, Job>();

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: cors });
const safeProjectId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
const sourceUrl = (projectId: string) => `${APP_ORIGIN}/api/projects/${projectId}/media`;

async function run(command: string[]) {
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code !== 0) throw new Error(`${command[0]} exited ${code}: ${stderr.slice(-4000)}`);
  return { stdout, stderr };
}

async function download(projectId: string, destination: string) {
  const response = await fetch(sourceUrl(projectId));
  if (!response.ok || !response.body) throw new Error(`Source download failed: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination));
}

async function hasAudio(input: string) {
  const { stdout } = await run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", input]);
  return stdout.trim().length > 0;
}

function seconds(ms: number) { return (ms / 1000).toFixed(3); }
function assTime(ms: number) {
  const centiseconds = Math.max(0, Math.round(ms / 10));
  const cs = centiseconds % 100;
  const totalSeconds = Math.floor(centiseconds / 100);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}
function assText(text: string) { return text.replaceAll("\\", "\\\\").replaceAll("{", "\\{").replaceAll("}", "\\}").replaceAll("\n", "\\N"); }

async function writeAss(file: string, state: ProjectState) {
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Caption,DejaVu Sans,48,&H00FFFFFF,&H000000FF,&H00101010,&H90000000,-1,0,0,0,100,100,0,0,1,3,1,2,60,60,54,1\nStyle: Overlay,DejaVu Sans,54,&H00FFFFFF,&H000000FF,&H00101010,&H70000000,-1,0,0,0,100,100,0,0,1,3,1,5,60,60,60,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const events = [...state.captions.map((item) => ({ ...item, style: "Caption" })), ...state.overlays.map((item) => ({ ...item, style: "Overlay" }))]
    .map((item) => {
      const alignment = item.position === "top" ? "{\\an8}" : item.position === "center" ? "{\\an5}" : "{\\an2}";
      return `Dialogue: 0,${assTime(item.startMs)},${assTime(item.endMs)},${item.style},,0,0,0,,${alignment}${assText(item.text)}`;
    }).join("\n");
  await writeFile(file, header + events);
}

function validateState(state: ProjectState) {
  if (!state || !safeProjectId(state.id) || !Array.isArray(state.clips) || !state.clips.length || state.clips.length > 200) throw new Error("Invalid project state");
  for (const clip of state.clips) {
    if (![clip.sourceInMs, clip.sourceOutMs, clip.speed].every(Number.isFinite) || clip.sourceInMs < 0 || clip.sourceOutMs <= clip.sourceInMs || clip.sourceOutMs > state.durationMs || clip.speed < 0.5 || clip.speed > 2) throw new Error("Invalid clip");
  }
}

async function exportProject(job: Job, state: ProjectState) {
  job.status = "running";
  const dir = path.join(DATA_DIR, job.id);
  await mkdir(dir, { recursive: true });
  const input = path.join(dir, "source");
  const output = path.join(dir, "rough-cut.mp4");
  const ass = path.join(dir, "text.ass");
  try {
    validateState(state);
    await download(state.id, input);
    const audio = await hasAudio(input);
    await writeAss(ass, state);
    const filters: string[] = [];
    const durations: number[] = [];

    state.clips.forEach((clip, index) => {
      const duration = (clip.sourceOutMs - clip.sourceInMs) / clip.speed;
      durations.push(duration);
      const fadeIn = Math.min(clip.fadeInMs, duration / 2);
      const fadeOut = Math.min(clip.fadeOutMs, duration / 2);
      const videoFilters = [
        `trim=start=${seconds(clip.sourceInMs)}:end=${seconds(clip.sourceOutMs)}`,
        `setpts=(PTS-STARTPTS)/${clip.speed}`,
        "fps=30",
        "settb=1/30",
        `eq=brightness=${clip.brightness}:contrast=${clip.contrast}:saturation=${clip.saturation}`,
        `hue=h=${clip.hue}`,
        "format=yuv420p",
      ];
      if (fadeIn > 0) videoFilters.push(`fade=t=in:st=0:d=${seconds(fadeIn)}`);
      if (fadeOut > 0) videoFilters.push(`fade=t=out:st=${seconds(duration - fadeOut)}:d=${seconds(fadeOut)}`);
      filters.push(`[0:v]${videoFilters.join(",")}[v${index}]`);
      if (audio) filters.push(`[0:a]atrim=start=${seconds(clip.sourceInMs)}:end=${seconds(clip.sourceOutMs)},asetpts=PTS-STARTPTS,atempo=${clip.speed},volume=${clip.muted ? 0 : clip.volume}[a${index}]`);
    });

    let video = "v0";
    let audioLabel = "a0";
    let composedDuration = durations[0];
    for (let index = 1; index < state.clips.length; index++) {
      const prior = state.clips[index - 1];
      const durationMs = prior.transition.type === "cut" ? 1 : Math.max(50, Math.min(prior.transition.durationMs, composedDuration / 2, durations[index] / 2));
      const transitionSeconds = durationMs / 1000;
      const offsetSeconds = Math.max(0, (composedDuration - durationMs) / 1000);
      const transition = prior.transition.type === "fade-black" ? "fadeblack" : "fade";
      const nextVideo = `vx${index}`;
      filters.push(`[${video}][v${index}]xfade=transition=${transition}:duration=${transitionSeconds.toFixed(3)}:offset=${offsetSeconds.toFixed(3)}[${nextVideo}]`);
      video = nextVideo;
      if (audio) {
        const nextAudio = `ax${index}`;
        filters.push(`[${audioLabel}][a${index}]acrossfade=d=${transitionSeconds.toFixed(3)}[${nextAudio}]`);
        audioLabel = nextAudio;
      }
      composedDuration += durations[index] - durationMs;
    }

    if (state.captions.length || state.overlays.length) {
      filters.push(`[${video}]ass=${ass.replaceAll(":", "\\:")}[vout]`);
      video = "vout";
    }

    const args = ["ffmpeg", "-y", "-i", input, "-filter_complex", filters.join(";"), "-map", `[${video}]`];
    if (audio) args.push("-map", `[${audioLabel}]`, "-c:a", "aac", "-b:a", "192k");
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-shortest", output);
    await run(args);
    job.status = "complete";
    job.output = output;
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
  }
}

async function detectSilences(projectId: string, thresholdDb: number, minimumMs: number) {
  const jobId = crypto.randomUUID();
  const dir = path.join(DATA_DIR, jobId);
  await mkdir(dir, { recursive: true });
  const input = path.join(dir, "source");
  try {
    await download(projectId, input);
    const { stderr } = await run(["ffmpeg", "-hide_banner", "-i", input, "-af", `silencedetect=noise=${thresholdDb}dB:d=${minimumMs / 1000}`, "-f", "null", "-"]);
    const starts = [...stderr.matchAll(/silence_start: ([\d.]+)/g)].map((match) => Number(match[1]) * 1000);
    const ends = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((match) => Number(match[1]) * 1000);
    return starts.map((startMs, index) => ({ startMs: Math.round(startMs), endMs: Math.round(ends[index] ?? startMs) })).filter((range) => range.endMs > range.startMs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function prepareTranscription(projectId: string) {
  const jobId = crypto.randomUUID();
  const dir = path.join(DATA_DIR, jobId);
  await mkdir(dir, { recursive: true });
  const input = path.join(dir, "source");
  await download(projectId, input);
  await run(["ffmpeg", "-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", "-f", "segment", "-segment_time", "300", "-reset_timestamps", "1", path.join(dir, "chunk-%03d.mp3")]);
  await rm(input, { force: true });
  const chunks = (await readdir(dir)).filter((name) => name.endsWith(".mp3")).sort();
  return { jobId, chunks: chunks.map((_, index) => ({ index, offsetMs: index * 300_000, url: `/jobs/${jobId}/chunks/${index}` })) };
}

await mkdir(DATA_DIR, { recursive: true });

Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, ffmpeg: "available" });

    if (request.method === "POST" && url.pathname === "/silences") {
      const input = await request.json().catch(() => null) as { projectId?: string; thresholdDb?: number; minimumMs?: number } | null;
      if (!safeProjectId(input?.projectId)) return json({ error: "Invalid project" }, 400);
      try {
        const ranges = await detectSilences(input.projectId, Math.max(-60, Math.min(-10, input.thresholdDb ?? -35)), Math.max(100, Math.min(5000, input.minimumMs ?? 500)));
        return json({ ranges });
      } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 500); }
    }

    if (request.method === "POST" && url.pathname === "/transcription/prepare") {
      const input = await request.json().catch(() => null) as { projectId?: string } | null;
      if (!safeProjectId(input?.projectId)) return json({ error: "Invalid project" }, 400);
      try { return json(await prepareTranscription(input.projectId)); }
      catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 500); }
    }

    const chunkMatch = url.pathname.match(/^\/jobs\/([a-f0-9-]{36})\/chunks\/(\d+)$/i);
    if (request.method === "GET" && chunkMatch) {
      const files = (await readdir(path.join(DATA_DIR, chunkMatch[1])).catch(() => [])).filter((name) => name.endsWith(".mp3")).sort();
      const file = files[Number(chunkMatch[2])];
      if (!file) return json({ error: "Chunk not found" }, 404);
      return new Response(Bun.file(path.join(DATA_DIR, chunkMatch[1], file)), { headers: { ...cors, "Content-Type": "audio/mpeg" } });
    }

    if (request.method === "POST" && url.pathname === "/exports") {
      const input = await request.json().catch(() => null) as { state?: ProjectState } | null;
      try { validateState(input?.state as ProjectState); }
      catch (error) { return json({ error: error instanceof Error ? error.message : "Invalid project" }, 400); }
      const job: Job = { id: crypto.randomUUID(), kind: "export", status: "queued", createdAt: new Date().toISOString() };
      jobs.set(job.id, job);
      void exportProject(job, input!.state!);
      return json(job, 202);
    }

    const jobMatch = url.pathname.match(/^\/jobs\/([a-f0-9-]{36})(\/output)?$/i);
    if (request.method === "GET" && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return json({ error: "Job not found" }, 404);
      if (jobMatch[2]) {
        if (job.status !== "complete" || !job.output) return json({ error: "Output is not ready" }, 409);
        return new Response(Bun.file(job.output), { headers: { ...cors, "Content-Type": "video/mp4", "Content-Disposition": "attachment; filename=rough-cut.mp4" } });
      }
      return json({ ...job, output: job.status === "complete" ? `/jobs/${job.id}/output` : undefined });
    }

    return json({ error: "Not found" }, 404);
  },
});

console.log(`ROUGH//CUT media service listening on :${PORT}`);
