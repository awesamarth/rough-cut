import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const PORT = Number(process.env.PORT || 8788);
const DATA_DIR = process.env.DATA_DIR || "/data/jobs";
const APP_ORIGIN = (process.env.APP_ORIGIN || "http://host.docker.internal:3000").replace(/\/$/, "");

type Clip = {
  id: string; timelineStartMs: number; sourceInMs: number; sourceOutMs: number; speed: number; volume: number; muted: boolean;
  brightness: number; contrast: number; saturation: number; hue: number;
  scaleX: number; scaleY: number; positionX: number; positionY: number; fadeInMs: number; fadeOutMs: number;
  transition: { type: "cut" | "crossfade" | "fade-black"; durationMs: number };
};
type TimedText = { text: string; startMs: number; endMs: number; position: "top" | "center" | "bottom"; fontSize?: number; color?: "white" | "yellow" | "lime"; background?: boolean };
type MusicClip = { id: string; assetId: string; name: string; durationMs: number; timelineStartMs: number; sourceInMs: number; sourceOutMs: number; speed: number; volume: number; muted: boolean; fadeInMs: number; fadeOutMs: number; loop: boolean };
type ProjectState = { id: string; name: string; durationMs: number; clips: Clip[]; captions: TimedText[]; captionStyle: { size: "small" | "medium" | "large"; color: "white" | "yellow" | "lime"; background: boolean; backgroundOpacity: number }; overlays: TimedText[]; music: MusicClip[] };
type Job = { id: string; kind: "export"; status: "queued" | "running" | "complete" | "failed"; error?: string; output?: string; createdAt: string };
const jobs = new Map<string, Job>();
const waveformCache = new Map<string, number[]>();

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: cors });
const safeProjectId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
const sourceUrl = (projectId: string, asset: "media" | "music" = "media", assetId = "") => `${APP_ORIGIN}/api/projects/${projectId}/${asset}${asset === "music" ? `?asset=${encodeURIComponent(assetId)}` : ""}`;

async function run(command: string[]) {
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code !== 0) throw new Error(`${command[0]} exited ${code}: ${stderr.slice(-4000)}`);
  return { stdout, stderr };
}

async function download(projectId: string, destination: string, asset: "media" | "music" = "media", assetId = "") {
  const response = await fetch(sourceUrl(projectId, asset, assetId));
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
  const captionSize = { small: 38, medium: 48, large: 58 }[state.captionStyle.size];
  const captionColor = { white: "&H00FFFFFF", yellow: "&H0066E0FF", lime: "&H0063FFD9" }[state.captionStyle.color];
  const borderStyle = state.captionStyle.background ? 3 : 1;
  const backgroundAlpha = Math.round((1 - state.captionStyle.backgroundOpacity) * 255).toString(16).padStart(2, "0").toUpperCase();
  const background = state.captionStyle.background ? `&H${backgroundAlpha}000000` : "&HFF000000";
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Caption,DejaVu Sans,${captionSize},${captionColor},&H000000FF,&H00101010,${background},-1,0,0,0,100,100,0,0,${borderStyle},3,1,2,60,60,54,1\nStyle: Overlay,DejaVu Sans,54,&H00FFFFFF,&H000000FF,&H00101010,&H90000000,-1,0,0,0,100,100,0,0,3,10,0,5,60,60,60,1\nStyle: OverlayNoBG,DejaVu Sans,54,&H00FFFFFF,&H000000FF,&H00101010,&HFF000000,-1,0,0,0,100,100,0,0,1,3,1,5,60,60,60,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const events = [...state.captions.map((item) => ({ ...item, style: "Caption" })), ...state.overlays.map((item) => ({ ...item, style: item.background === false ? "OverlayNoBG" : "Overlay" }))]
    .map((item) => {
      const alignment = item.position === "top" ? "\\an8" : item.position === "center" ? "\\an5" : "\\an2";
      const size = item.style.startsWith("Overlay") ? `\\fs${item.fontSize ?? 54}` : "";
      const color = item.style.startsWith("Overlay") ? `\\c${{ white: "&H00FFFFFF&", yellow: "&H0066E0FF&", lime: "&H0063FFD9&" }[item.color ?? "white"]}` : "";
      return `Dialogue: 0,${assTime(item.startMs)},${assTime(item.endMs)},${item.style},,0,0,0,,{${alignment}${size}${color}}${assText(item.text)}`;
    }).join("\n");
  await writeFile(file, header + events);
}

function validateState(state: ProjectState) {
  if (!state || !safeProjectId(state.id) || !Array.isArray(state.clips) || !state.clips.length || state.clips.length > 200) throw new Error("Invalid project state");
  for (const clip of state.clips) {
    if (![clip.timelineStartMs, clip.sourceInMs, clip.sourceOutMs, clip.speed, clip.scaleX, clip.scaleY, clip.positionX, clip.positionY, clip.volume].every(Number.isFinite) || clip.timelineStartMs < 0 || clip.sourceInMs < 0 || clip.sourceOutMs <= clip.sourceInMs || clip.sourceOutMs > state.durationMs || clip.speed < 0.5 || clip.speed > 2 || clip.scaleX < 0.25 || clip.scaleX > 4 || clip.scaleY < 0.25 || clip.scaleY > 4 || Math.abs(clip.positionX) > 100 || Math.abs(clip.positionY) > 100 || clip.volume < 0 || clip.volume > 5 || typeof clip.muted !== "boolean") throw new Error("Invalid clip");
  }
  if (!state.captionStyle || !["small", "medium", "large"].includes(state.captionStyle.size) || !["white", "yellow", "lime"].includes(state.captionStyle.color) || typeof state.captionStyle.background !== "boolean" || !Number.isFinite(state.captionStyle.backgroundOpacity) || state.captionStyle.backgroundOpacity < 0 || state.captionStyle.backgroundOpacity > 1) throw new Error("Invalid caption style");
  if (!Array.isArray(state.music)) throw new Error("Invalid music");
  for (const music of state.music) if (!safeProjectId(music.id) || !safeProjectId(music.assetId) || ![music.durationMs, music.timelineStartMs, music.sourceInMs, music.sourceOutMs, music.speed, music.volume, music.fadeInMs, music.fadeOutMs].every(Number.isFinite) || music.durationMs <= 0 || music.timelineStartMs < 0 || music.sourceInMs < 0 || music.sourceOutMs <= music.sourceInMs || music.sourceOutMs > music.durationMs || music.speed < 0.5 || music.speed > 2 || music.volume < 0 || music.volume > 5 || typeof music.muted !== "boolean" || typeof music.loop !== "boolean") throw new Error("Invalid music");
}

async function exportProject(job: Job, state: ProjectState) {
  job.status = "running";
  const dir = path.join(DATA_DIR, job.id);
  await mkdir(dir, { recursive: true });
  const input = path.join(dir, "source");
  const musicInputs = state.music.map((_, index) => path.join(dir, `music-${index}`));
  const output = path.join(dir, "rough-cut.mp4");
  const ass = path.join(dir, "text.ass");
  try {
    validateState(state);
    await download(state.id, input);
    await Promise.all(state.music.map((music, index) => download(state.id, musicInputs[index], "music", music.assetId)));
    const audio = await hasAudio(input);
    await writeAss(ass, state);
    const filters: string[] = [];
    const clips = [...state.clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
    const videoDuration = Math.max(...clips.map((clip) => clip.timelineStartMs + (clip.sourceOutMs - clip.sourceInMs) / clip.speed));
    const musicEnd = Math.max(0, ...state.music.map((music) => music.loop ? videoDuration : music.timelineStartMs + (music.sourceOutMs - music.sourceInMs) / music.speed));
    const totalDuration = Math.max(videoDuration, musicEnd);
    const simpleVideo = clips.length === 1 && clips[0].timelineStartMs === 0 && Math.abs(videoDuration - totalDuration) < 1 && clips[0].scaleX === 1 && clips[0].scaleY === 1 && clips[0].positionX === 0 && clips[0].positionY === 0 && clips[0].fadeInMs === 0 && clips[0].fadeOutMs === 0 && clips[0].transition.type === "cut";
    const simpleAudio = audio && clips.length === 1 && !state.music.length && clips[0].timelineStartMs === 0 && Math.abs(videoDuration - totalDuration) < 1;
    if (!simpleVideo) filters.push(`color=c=black:s=1920x1080:r=30:d=${seconds(totalDuration)}[basev]`);
    if ((audio || state.music.length) && !simpleAudio) filters.push(`anullsrc=r=48000:cl=stereo:d=${seconds(totalDuration)}[basea]`);

    clips.forEach((clip, index) => {
      const duration = (clip.sourceOutMs - clip.sourceInMs) / clip.speed;
      const prior = clips[index - 1];
      const transitionIn = prior?.transition.type === "cut" ? 0 : prior?.transition.durationMs ?? 0;
      const transitionOut = clip.transition.type === "cut" ? 0 : clip.transition.durationMs;
      const videoFadeIn = Math.min(Math.max(clip.fadeInMs, transitionIn), duration / 2);
      const videoFadeOut = Math.min(Math.max(clip.fadeOutMs, clip.transition.type === "crossfade" ? 0 : transitionOut), duration / 2);
      const audioFadeIn = Math.min(Math.max(clip.fadeInMs, transitionIn), duration / 2);
      const audioFadeOut = Math.min(Math.max(clip.fadeOutMs, transitionOut), duration / 2);
      const videoFilters = [
        `trim=start=${seconds(clip.sourceInMs)}:end=${seconds(clip.sourceOutMs)}`,
        `setpts=(PTS-STARTPTS)/${clip.speed}`,
        "fps=30",
      ];
      if (clip.brightness !== 0) videoFilters.push(`colorchannelmixer=rr=${1 + clip.brightness}:gg=${1 + clip.brightness}:bb=${1 + clip.brightness}`);
      if (clip.contrast !== 1 || clip.saturation !== 1) videoFilters.push(`eq=contrast=${clip.contrast}:saturation=${clip.saturation}`);
      if (clip.hue !== 0) videoFilters.push(`hue=h=${clip.hue}`);
      videoFilters.push("scale=1920:1080:force_original_aspect_ratio=decrease", "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black");
      if (clip.scaleX !== 1 || clip.scaleY !== 1) videoFilters.push(`scale=max(2\\,trunc(iw*${clip.scaleX}/2)*2):max(2\\,trunc(ih*${clip.scaleY}/2)*2)`);
      videoFilters.push(simpleVideo ? "format=yuv420p" : "format=yuva420p");
      if (videoFadeIn > 0) videoFilters.push(`fade=t=in:st=0:d=${seconds(videoFadeIn)}:alpha=1`);
      if (videoFadeOut > 0) videoFilters.push(`fade=t=out:st=${seconds(duration - videoFadeOut)}:d=${seconds(videoFadeOut)}:alpha=1`);
      videoFilters.push(`setpts=PTS+${seconds(clip.timelineStartMs)}/TB`);
      filters.push(`[0:v]${videoFilters.join(",")}[v${index}]`);
      if (audio) {
        const audioFilters = [`atrim=start=${seconds(clip.sourceInMs)}:end=${seconds(clip.sourceOutMs)}`, "asetpts=PTS-STARTPTS", `atempo=${clip.speed}`, `volume=${clip.muted ? 0 : clip.volume}`];
        if (audioFadeIn > 0) audioFilters.push(`afade=t=in:st=0:d=${seconds(audioFadeIn)}`);
        if (audioFadeOut > 0) audioFilters.push(`afade=t=out:st=${seconds(duration - audioFadeOut)}:d=${seconds(audioFadeOut)}`);
        audioFilters.push(`adelay=${Math.round(clip.timelineStartMs)}:all=1`);
        filters.push(`[0:a]${audioFilters.join(",")}[a${index}]`);
      }
    });

    let video = simpleVideo ? "v0" : "basev";
    if (!simpleVideo) clips.forEach((clip, index) => {
      const nextVideo = `vx${index}`;
      const end = clip.timelineStartMs + (clip.sourceOutMs - clip.sourceInMs) / clip.speed;
      filters.push(`[${video}][v${index}]overlay=x='(main_w-overlay_w)/2+main_w*${clip.positionX}/100':y='(main_h-overlay_h)/2+main_h*${clip.positionY}/100':eof_action=repeat:shortest=0:enable='between(t,${seconds(clip.timelineStartMs)},${seconds(end)})'[${nextVideo}]`);
      video = nextVideo;
    });
    const audioTracks: string[] = [];
    if (audio) {
      if (simpleAudio) audioTracks.push("[a0]");
      else {
        filters.push(`${clips.map((_, index) => `[a${index}]`).join("")}amix=inputs=${clips.length}:duration=longest:normalize=0[sourcea]`);
        audioTracks.push("[sourcea]");
      }
    }
    state.music.forEach((music, index) => {
      const available = Math.max(0, totalDuration - music.timelineStartMs);
      const duration = music.loop ? available : Math.min(available, (music.sourceOutMs - music.sourceInMs) / music.speed);
      const musicFilters = [`atrim=start=${seconds(music.sourceInMs)}:end=${seconds(music.sourceOutMs)}`, "asetpts=PTS-STARTPTS", "aresample=48000"];
      if (music.loop) musicFilters.push(`aloop=loop=-1:size=${Math.max(1, Math.round((music.sourceOutMs - music.sourceInMs) / 1000 * 48000))}`);
      musicFilters.push(`atempo=${music.speed}`, `atrim=duration=${seconds(duration)}`, `volume=${music.muted ? 0 : music.volume}`);
      const fadeIn = Math.min(music.fadeInMs, duration / 2);
      const fadeOut = Math.min(music.fadeOutMs, duration / 2);
      if (fadeIn > 0) musicFilters.push(`afade=t=in:st=0:d=${seconds(fadeIn)}`);
      if (fadeOut > 0) musicFilters.push(`afade=t=out:st=${seconds(duration - fadeOut)}:d=${seconds(fadeOut)}`);
      musicFilters.push(`adelay=${Math.round(music.timelineStartMs)}:all=1`);
      filters.push(`[${index + 1}:a]${musicFilters.join(",")}[music${index}]`);
      audioTracks.push(`[music${index}]`);
    });
    let audioLabel = "";
    if (simpleAudio) audioLabel = "a0";
    else if (audioTracks.length) {
      audioLabel = "aout";
      filters.push(`[basea]${audioTracks.join("")}amix=inputs=${audioTracks.length + 1}:duration=longest:normalize=0[${audioLabel}]`);
    }

    if (state.captions.length || state.overlays.length) {
      filters.push(`[${video}]ass=${ass.replaceAll(":", "\\:")}[vout]`);
      video = "vout";
    }

    const args = ["ffmpeg", "-y", "-i", input];
    musicInputs.forEach((musicInput) => args.push("-i", musicInput));
    args.push("-filter_complex", filters.join(";"), "-map", `[${video}]`);
    if (audioLabel) args.push("-map", `[${audioLabel}]`, "-c:a", "aac", "-b:a", "192k");
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-t", seconds(totalDuration), output);
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

async function waveform(projectId: string, asset: "media" | "music" = "media", assetVersion = "") {
  const cacheKey = `${projectId}:${asset}:${assetVersion}`;
  const cached = waveformCache.get(cacheKey);
  if (cached) return cached;
  const dir = path.join(DATA_DIR, crypto.randomUUID());
  const input = path.join(dir, "source");
  await mkdir(dir, { recursive: true });
  try {
    await download(projectId, input, asset, assetVersion);
    if (!await hasAudio(input)) return [];
    const process = Bun.spawn(["ffmpeg", "-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", "800", "-f", "s16le", "-acodec", "pcm_s16le", "-"], { stdout: "pipe", stderr: "pipe" });
    const [buffer, stderr, code] = await Promise.all([new Response(process.stdout).arrayBuffer(), new Response(process.stderr).text(), process.exited]);
    if (code !== 0) throw new Error(`Waveform extraction failed: ${stderr.slice(-2000)}`);
    const samples = new Int16Array(buffer);
    const bucketSize = Math.max(1, Math.ceil(samples.length / 2000));
    const peaks: number[] = [];
    for (let start = 0; start < samples.length; start += bucketSize) {
      let peak = 0;
      for (let index = start; index < Math.min(samples.length, start + bucketSize); index++) peak = Math.max(peak, Math.abs(samples[index]));
      peaks.push(peak / 32768);
    }
    const maximum = Math.max(0.01, ...peaks);
    const normalized = peaks.map((peak) => Math.min(1, peak / maximum));
    waveformCache.set(cacheKey, normalized);
    return normalized;
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
  const manifest = path.join(dir, "chunks.csv");
  await run(["ffmpeg", "-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", "-f", "segment", "-segment_time", "300", "-reset_timestamps", "1", "-segment_list", manifest, "-segment_list_type", "csv", path.join(dir, "chunk-%03d.mp3")]);
  await rm(input, { force: true });
  const chunks = (await Bun.file(manifest).text()).trim().split("\n").filter(Boolean).map((line, index) => {
    const [, start] = line.split(",");
    return { index, offsetMs: Math.round(Number(start) * 1000), url: `/jobs/${jobId}/chunks/${index}` };
  });
  await rm(manifest, { force: true });
  return { jobId, chunks };
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

    if (request.method === "POST" && url.pathname === "/waveform") {
      const input = await request.json().catch(() => null) as { projectId?: string; asset?: "media" | "music"; assetVersion?: string } | null;
      if (!safeProjectId(input?.projectId) || input.asset !== undefined && input.asset !== "media" && input.asset !== "music" || input.assetVersion !== undefined && (typeof input.assetVersion !== "string" || input.assetVersion.length > 100)) return json({ error: "Invalid project" }, 400);
      try { return json({ peaks: await waveform(input.projectId, input.asset ?? "media", input.assetVersion ?? "") }); }
      catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 500); }
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
