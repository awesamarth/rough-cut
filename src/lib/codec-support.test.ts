import { expect, test } from "bun:test";
import { createCodecSupport, ensureTrackDecodable, extensionForCodec, inspectInput } from "./codec-support";

const track = (codec: string, supported: () => Promise<boolean>) => ({ getCodec: async () => codec, canDecode: supported, computeDuration: async () => 2.0001 }) as never;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const encoders = { canEncodeVideo: async () => true, canEncodeAudio: async () => true };

test("extension selection follows codec and role, not container", () => {
  expect(extensionForCodec("prores", "video")).toBe("prores");
  expect(extensionForCodec("ac3", "audio")).toBe("ac3");
  expect(extensionForCodec("eac3", "audio")).toBe("ac3");
  expect(extensionForCodec("dts", "audio")).toBe("dts");
  expect(extensionForCodec("aac", "audio")).toBeUndefined();
  expect(extensionForCodec("prores", "audio")).toBeUndefined();
});

test("native support never loads extensions; unsupported codecs fail locally", async () => {
  let loads = 0;
  const policy = createCodecSupport({ ...encoders, load: async () => { loads++; } });
  expect((await policy.ensureTrackDecodable(track("prores", async () => true), "video")).extension).toBeUndefined();
  await policy.ensureOutputEncoding();
  await expect(policy.ensureTrackDecodable(track("hevc", async () => false), "video")).rejects.toThrow("hevc");
  expect(loads).toBe(0);
});

test("no-audio source is valid, but missing/unsupported music is not; duration stays integral", async () => {
  const video = track("avc", async () => true);
  const input = { getPrimaryVideoTrack: async () => video, getPrimaryAudioTrack: async () => null } as never;
  expect(await inspectInput(input, "source")).toMatchObject({ audio: null, durationMs: 2001 });
  await expect(inspectInput(input, "audio")).rejects.toThrow("audio track");
  const badAudio = { getPrimaryVideoTrack: async () => video, getPrimaryAudioTrack: async () => track("unknown", async () => false) } as never;
  await expect(inspectInput(badAudio, "source")).rejects.toThrow("unknown");
});

test("concurrent callers share registration, but independent realms do not", async () => {
  const gate = deferred(); let loads = 0, supported = false;
  const deps = { ...encoders, load: async () => { loads++; await gate.promise; supported = true; } };
  const policy = createCodecSupport(deps);
  const input = track("eac3", async () => supported);
  const first = policy.ensureTrackDecodable(input, "audio");
  const second = policy.ensureTrackDecodable(input, "audio");
  gate.resolve();
  expect((await first).extension).toBe("ac3"); await second;
  expect(loads).toBe(1);
  supported = false;
  await createCodecSupport(deps).ensureTrackDecodable(input, "audio");
  expect(loads).toBe(2);
});

test("failed registration can retry; registered but unsupported configuration is rejected", async () => {
  let attempts = 0, supported = false;
  const policy = createCodecSupport({ ...encoders, load: async () => { if (++attempts === 1) throw new Error("network failed"); supported = true; } });
  const input = track("dts", async () => supported);
  await expect(policy.ensureTrackDecodable(input, "audio")).rejects.toThrow("Could not load");
  await policy.ensureTrackDecodable(input, "audio");
  expect(attempts).toBe(2);
  await expect(policy.ensureTrackDecodable(track("dts", async () => false), "audio")).rejects.toThrow("configuration");
});

test("cancellation during native checks cannot accept a track or start fallback", async () => {
  const controller = new AbortController(); const gate = deferred(); let loads = 0;
  const policy = createCodecSupport({ ...encoders, load: async () => { loads++; } });
  const pending = policy.ensureTrackDecodable(track("prores", async () => { await gate.promise; return true; }), "video", controller.signal);
  controller.abort(); gate.resolve();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(loads).toBe(0);
  await expect(ensureTrackDecodable(track("prores", async () => false), "video", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});

test("one aborted waiter does not cancel another caller's extension load", async () => {
  const started = deferred(), gate = deferred(); const controller = new AbortController(); let supported = false, loads = 0;
  const policy = createCodecSupport({ ...encoders, load: async () => { loads++; started.resolve(); await gate.promise; supported = true; } });
  const input = track("prores", async () => supported);
  const first = policy.ensureTrackDecodable(input, "video", controller.signal);
  const second = policy.ensureTrackDecodable(input, "video");
  await started.promise; controller.abort();
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  gate.resolve(); await second;
  expect(loads).toBe(1);
});

test("output checks canonical settings, H264 first; AAC fallback is rechecked", async () => {
  let registered = false; const loads: string[] = [];
  const policy = createCodecSupport({
    canEncodeVideo: async (codec, options) => { expect(codec).toBe("avc"); expect(options).toMatchObject({ width: 1920, height: 1080, bitrate: 8_000_000 }); return true; },
    canEncodeAudio: async (codec, options) => { expect(codec).toBe("aac"); expect(options).toMatchObject({ sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 }); return registered; },
    load: async (extension) => { loads.push(extension); registered = true; },
  });
  await policy.ensureOutputEncoding(); expect(loads).toEqual(["aac-encoder"]);
  await expect(createCodecSupport({ ...encoders, canEncodeVideo: async () => false, load: async () => { throw new Error("must not load"); } }).ensureOutputEncoding()).rejects.toThrow("H.264");
});

test("output cancellation stays AbortError while AAC import is pending", async () => {
  const controller = new AbortController(), started = deferred(), gate = deferred();
  const policy = createCodecSupport({ ...encoders, canEncodeAudio: async () => false, load: async () => { started.resolve(); await gate.promise; } });
  const pending = policy.ensureOutputEncoding(controller.signal);
  await started.promise; controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" }); gate.resolve();
});
