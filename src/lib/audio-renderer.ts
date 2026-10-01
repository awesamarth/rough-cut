import { normalizePcmTimestamp } from "./media-timing";
import { Stretch } from "@soundtouchjs/core";
import { ALL_FORMATS, BlobSource, Conversion, Input, NullTarget, Output, UrlSource, WavOutputFormat } from "mediabunny";
import { AUDIO_RATE, clipEnvelope, musicGain } from "./composition";
import { clipDuration, musicClipEnd, timelineClips, type ProjectState } from "./editor";
import { ensureTrackDecodable } from "./codec-support";
import type { MediaSource } from "./video-renderer";

async function* decodedPcm(source: MediaSource, startMs: number, endMs: number, signal: AbortSignal) {
  const input = new Input({ source: typeof source === "string" ? new UrlSource(source) : new BlobSource(source), formats: ALL_FORMATS });
  const stream = new TransformStream<Float32Array, Float32Array>();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  let conversion: Conversion | undefined;
  const abort = () => { void writer.abort(signal.reason).catch(() => {}); void conversion?.cancel().catch(() => {}); input.dispose(); };
  signal.addEventListener("abort", abort, { once: true });
  const producer = (async () => {
    signal.throwIfAborted();
    const track = await input.getPrimaryAudioTrack();
    if (!track) { await writer.close(); return; }
    await ensureTrackDecodable(track, "audio", signal);
    let cursor = 0;
    conversion = await Conversion.init({
      input, output: new Output({ format: new WavOutputFormat(), target: new NullTarget() }),
      trim: { start: startMs / 1000, end: endMs / 1000 }, video: { discard: true },
      audio: (candidate) => candidate.id !== track.id ? { discard: true } : {
        codec: "pcm-f32", sampleRate: AUDIO_RATE, numberOfChannels: 2,
        process: async (sample) => {
          signal.throwIfAborted();
          normalizePcmTimestamp(sample);
          const target = Math.max(0, Math.round(sample.timestamp * AUDIO_RATE));
          while (cursor < target) {
            const count = Math.min(4096, target - cursor);
            await writer.write(new Float32Array(count * 2)); cursor += count;
          }
          const pcm = new Float32Array(sample.allocationSize({ format: "f32", planeIndex: 0 }) / 4);
          sample.copyTo(pcm, { format: "f32", planeIndex: 0 });
          const skip = Math.max(0, cursor - target);
          if (skip < sample.numberOfFrames) { await writer.write(pcm.subarray(skip * 2)); cursor += sample.numberOfFrames - skip; }
          return sample; // NullTarget drains PCM; WAVE still requires packets to finalize.
        },
      },
    });
    if (!conversion.isValid) throw new Error("Audio conversion is not supported");
    await conversion.execute();
    await writer.close();
  })().catch(async (error) => { await writer.abort(error).catch(() => {}); });
  try {
    while (true) { const { done, value } = await reader.read(); if (done) return; yield value; }
  } finally {
    await reader.cancel().catch(() => {});
    await conversion?.cancel().catch(() => {});
    await producer;
    signal.removeEventListener("abort", abort);
    input.dispose();
  }
}

/** WSOLA time stretching, identical for playback and export; no pitch-shifting shortcut. */
async function* stretchedPcm(source: MediaSource, startMs: number, endMs: number, speed: number, signal: AbortSignal) {
  if (speed === 1) { yield* decodedPcm(source, startMs, endMs, signal); return; }
  const stretch = new Stretch({ createBuffers: true, sampleRate: AUDIO_RATE });
  stretch.tempo = speed;
  const inputBuffer = stretch.inputBuffer!;
  const outputBuffer = stretch.outputBuffer!;
  const expected = Math.round((endMs - startMs) / 1000 / speed * AUDIO_RATE);
  let emitted = 0;
  function drain() {
    const count = Math.min(outputBuffer.frameCount, expected - emitted);
    const pcm = new Float32Array(count * 2);
    outputBuffer.extract(pcm, 0, count); outputBuffer.receive(count);
    emitted += count;
    return pcm;
  }
  try {
    for await (const pcm of decodedPcm(source, startMs, endMs, signal)) {
      inputBuffer.putSamples(pcm); stretch.process();
      if (outputBuffer.frameCount && emitted < expected) yield drain();
    }
    while (emitted < expected) {
      signal.throwIfAborted();
      inputBuffer.putSamples(new Float32Array(Math.max(4096, stretch.sampleReq) * 2)); stretch.process();
      if (outputBuffer.frameCount) yield drain();
    }
  } finally { stretch.clear(); }
}

class PcmReader {
  private block: Float32Array = new Float32Array();
  private offset = 0;
  private ended = false;
  private controller = new AbortController();
  private iterator: AsyncGenerator<Float32Array, void, unknown>;
  constructor(source: MediaSource, start: number, end: number, speed: number) { this.iterator = stretchedPcm(source, start, end, speed, this.controller.signal); }
  async read(frames: number) {
    const result = new Float32Array(frames * 2);
    let written = 0;
    while (written < result.length && !this.ended) {
      if (this.offset === this.block.length) {
        const next = await this.iterator.next(); this.ended = !!next.done;
        this.block = next.value ?? new Float32Array(); this.offset = 0;
        if (this.ended) break;
      }
      const size = Math.min(result.length - written, this.block.length - this.offset);
      result.set(this.block.subarray(this.offset, this.offset + size), written);
      this.offset += size; written += size;
    }
    return result;
  }
  dispose() { this.controller.abort(); void this.iterator.return().catch(() => {}); }
}

/** Sequential, bounded stereo timeline mixing. Create a new mixer for a seek or changed edit. */
export class AudioRenderer {
  private readers = new Map<string, { reader: PcmReader; nextFrame: number }>();
  private disposed = false;
  constructor(private source: MediaSource, private music: Record<string, MediaSource>) {}
  async render(state: ProjectState, startFrame: number, frames: number) {
    if (this.disposed) throw new DOMException("Audio renderer closed", "AbortError");
    const result = new Float32Array(frames * 2);
    const used = new Set<string>();
    const mix = async (key: string, source: MediaSource, timelineStart: number, end: number, sourceIn: number, sourceOut: number, speed: number, gain: (ms: number) => number) => {
      const first = Math.max(startFrame, Math.round(timelineStart * AUDIO_RATE / 1000));
      const last = Math.min(startFrame + frames, Math.round(end * AUDIO_RATE / 1000));
      if (last <= first) return;
      used.add(key);
      let entry = this.readers.get(key);
      if (!entry || entry.nextFrame !== first) {
        entry?.reader.dispose();
        const offsetMs = (first / AUDIO_RATE * 1000 - timelineStart) * speed;
        entry = { reader: new PcmReader(source, sourceIn + Math.max(0, offsetMs), sourceOut, speed), nextFrame: first };
        this.readers.set(key, entry);
      }
      const pcm = await entry.reader.read(last - first);
      entry.nextFrame = last;
      for (let index = first; index < last; index++) {
        const volume = gain(index / AUDIO_RATE * 1000);
        const input = (index - first) * 2; const output = (index - startFrame) * 2;
        result[output] += pcm[input] * volume; result[output + 1] += pcm[input + 1] * volume;
      }
    };
    const ordered = timelineClips(state);
    for (let clipIndex = 0; clipIndex < ordered.length; clipIndex++) {
      const clip = ordered[clipIndex].clip;
      if (clip.muted || clip.volume === 0) continue;
      await mix(clip.id, this.source, clip.timelineStartMs, clip.timelineStartMs + clipDuration(clip), clip.sourceInMs, clip.sourceOutMs, clip.speed, (time) => clip.volume * clipEnvelope(state, clip, time, ordered[clipIndex - 1]?.clip ?? null).audio);
    }
    for (const clip of state.music) {
      if (clip.muted || clip.volume === 0) continue;
      const source = this.music[clip.assetId];
      if (!source) throw new Error(`Relink music: ${clip.name}`);
      const end = musicClipEnd(state, clip);
      const span = (clip.sourceOutMs - clip.sourceInMs) / clip.speed;
      const startMs = startFrame / AUDIO_RATE * 1000;
      const lastMs = (startFrame + frames) / AUDIO_RATE * 1000;
      const firstLoop = clip.loop ? Math.max(0, Math.floor((startMs - clip.timelineStartMs) / span)) : 0;
      const lastLoop = clip.loop ? Math.max(firstLoop, Math.ceil((Math.min(end, lastMs) - clip.timelineStartMs) / span) - 1) : 0;
      for (let loop = firstLoop; loop <= lastLoop; loop++) {
        const start = clip.timelineStartMs + loop * span;
        await mix(`${clip.id}:${loop}`, source, start, Math.min(end, start + span), clip.sourceInMs, clip.sourceOutMs, clip.speed, (time) => musicGain(clip.volume, clip.muted, time, clip.timelineStartMs, end, clip.fadeInMs, clip.fadeOutMs));
      }
    }
    for (const [key, entry] of this.readers) if (!used.has(key)) { entry.reader.dispose(); this.readers.delete(key); }
    // Explicit hard clipping matches the preview's Float32 -> audio-device output ceiling.
    for (let index = 0; index < result.length; index++) result[index] = Math.max(-1, Math.min(1, result[index]));
    return result;
  }
  dispose() { this.disposed = true; this.readers.forEach(({ reader }) => reader.dispose()); this.readers.clear(); }
}
