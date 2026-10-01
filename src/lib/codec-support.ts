import {
  ALL_FORMATS, BlobSource, Input, canEncodeAudio, canEncodeVideo,
  type InputAudioTrack, type InputVideoTrack,
} from "mediabunny";
import { AUDIO_RATE, FRAME_HEIGHT, FRAME_WIDTH } from "./composition";

export type MediaRole = "source" | "audio";
export type CodecExtension = "prores" | "ac3" | "dts" | "aac-encoder";

export function extensionForCodec(codec: string, role: "video" | "audio"): CodecExtension | undefined {
  if (role === "video") return codec === "prores" ? "prores" : undefined;
  if (codec === "ac3" || codec === "eac3") return "ac3";
  if (codec === "dts") return "dts";
  return undefined;
}

async function registerExtension(extension: CodecExtension) {
  switch (extension) {
    case "prores": (await import("@mediabunny/prores")).registerProresDecoder(); break;
    case "ac3": (await import("@mediabunny/ac3")).registerAc3Decoder(); break;
    case "dts": (await import("@mediabunny/dts")).registerDtsDecoder(); break;
    case "aac-encoder": (await import("@mediabunny/aac-encoder")).registerAacEncoder(); break;
  }
}

/** Stop waiting without canceling a shared import or leaving its rejection unobserved. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const done = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => { done(); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then((value) => {
      done();
      if (signal.aborted) reject(signal.reason); else resolve(value);
    }, (error) => { done(); reject(signal.aborted ? signal.reason : error); });
  });
}

// Injectable boundary for non-browser policy tests. Production has one instance per JS realm.
export function createCodecSupport(dependencies = { load: registerExtension, canEncodeAudio, canEncodeVideo }) {
  const extensionLoads = new Map<CodecExtension, Promise<void>>();
  function loadExtension(extension: CodecExtension, signal: AbortSignal) {
    signal.throwIfAborted();
    let load = extensionLoads.get(extension);
    if (!load) {
      load = Promise.resolve().then(() => dependencies.load(extension));
      extensionLoads.set(extension, load);
      load.catch(() => { if (extensionLoads.get(extension) === load) extensionLoads.delete(extension); });
    }
    return abortable(load, signal);
  }

  async function ensureTrackDecodable(track: InputVideoTrack | InputAudioTrack, role: "video" | "audio", signal: AbortSignal = new AbortController().signal) {
    signal.throwIfAborted();
    const codec = await abortable(track.getCodec(), signal);
    if (!codec) throw new Error(`The ${role} codec is unknown; choose a file with a supported ${role} track.`);
    // Real track configuration/profile, not a generic codec-name capability query.
    if (await abortable(track.canDecode(), signal)) return { codec, extension: undefined as CodecExtension | undefined };
    const extension = extensionForCodec(codec, role);
    if (!extension) throw new Error(`This device cannot decode the ${role} track (${codec}). Choose a supported file.`);
    try { await loadExtension(extension, signal); }
    catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new Error(`Could not load the local ${extension} codec extension. Please try again.`, { cause: error });
    }
    if (!await abortable(track.canDecode(), signal)) throw new Error(`The local ${extension} extension does not support this ${role} track configuration (${codec}).`);
    return { codec, extension };
  }

  async function inspectInput(input: Input, role: MediaRole, signal: AbortSignal = new AbortController().signal) {
    signal.throwIfAborted();
    const video = role === "source" ? await abortable(input.getPrimaryVideoTrack(), signal) : null;
    if (role === "source") {
      if (!video) throw new Error("Choose a file containing a video track.");
      await ensureTrackDecodable(video, "video", signal);
    }
    const audio = await abortable(input.getPrimaryAudioTrack(), signal);
    // No audio is valid for source video, not music. Existing undecodable audio is never discarded.
    if (audio) await ensureTrackDecodable(audio, "audio", signal);
    else if (role === "audio") throw new Error("Choose a file containing an audio track.");
    const track = video ?? audio!;
    const duration = await abortable(track.computeDuration(), signal);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("The file has no usable duration.");
    return { video, audio, durationMs: Math.ceil(duration * 1000) };
  }

  /** Separate output capability gate, also called before any R2 admission. */
  async function ensureOutputEncoding(signal: AbortSignal = new AbortController().signal) {
    signal.throwIfAborted();
    const video = await abortable(dependencies.canEncodeVideo("avc", { width: FRAME_WIDTH, height: FRAME_HEIGHT, bitrate: 8_000_000 }), signal);
    if (!video) throw new Error("Required H.264 encoding is not supported on this device.");
    const audioOptions = { numberOfChannels: 2, sampleRate: AUDIO_RATE, bitrate: 192_000 };
    let audio = await abortable(dependencies.canEncodeAudio("aac", audioOptions), signal);
    if (!audio) {
      try { await loadExtension("aac-encoder", signal); }
      catch (error) {
        if (signal.aborted) throw signal.reason;
        throw new Error("Could not load the local AAC encoder extension. Please try again.", { cause: error });
      }
      audio = await abortable(dependencies.canEncodeAudio("aac", audioOptions), signal);
    }
    if (!audio) throw new Error("Required AAC encoding is not supported on this device.");
    return { video: "avc" as const, audio: "aac" as const };
  }
  return { ensureTrackDecodable, inspectInput, ensureOutputEncoding };
}

export const { ensureTrackDecodable, inspectInput, ensureOutputEncoding } = createCodecSupport();

export async function inspectMediaSource(source: Blob, role: MediaRole, signal: AbortSignal = new AbortController().signal) {
  signal.throwIfAborted();
  const input = new Input({ source: new BlobSource(source), formats: ALL_FORMATS });
  try {
    const { durationMs, audio } = await inspectInput(input, role, signal);
    // Do not expose track objects owned by the disposed Input.
    return { durationMs, hasAudio: !!audio };
  } finally { input.dispose(); }
}
