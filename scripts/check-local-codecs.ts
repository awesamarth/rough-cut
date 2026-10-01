// Non-browser, synthetic one-second fixtures. Requires Node and local ffmpeg/ffprobe.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_FORMATS, AudioSample, AudioSampleSink, AudioSampleSource, BlobSource, BufferTarget, Input, Mp4OutputFormat, Output, VideoSampleSink, canEncodeAudio } from "mediabunny";
import { registerAacEncoder } from "@mediabunny/aac-encoder";
import { ensureTrackDecodable } from "../src/lib/codec-support";

const directory = mkdtempSync(join(tmpdir(), "rough-cut-codecs-"));
const deadline = setTimeout(() => { rmSync(directory, { recursive: true, force: true }); console.error("Codec probe timed out"); process.exit(1); }, 30_000);
try {
  const proresFile = join(directory, "prores.mov");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:size=320x180:rate=5:duration=0.2", "-c:v", "prores_ks", "-profile:v", "2", "-pix_fmt", "yuv422p10le", "-threads", "1", proresFile], { timeout: 10_000 });
  const proresInput = new Input({ source: new BlobSource(new Blob([readFileSync(proresFile)])), formats: ALL_FORMATS });
  try {
    const track = await proresInput.getPrimaryVideoTrack(); assert(track);
    assert.equal(await track.getCodec(), "prores");
    await ensureTrackDecodable(track, "video");
    const sample = await new VideoSampleSink(track).getSample(0); assert(sample);
    try {
      assert.equal(sample.displayWidth, 320); assert.equal(sample.displayHeight, 180);
      const pixels = new Uint8Array(sample.allocationSize()); await sample.copyTo(pixels);
      assert(pixels.some((value) => value > 0));
      console.log("ProRes: actual WASM frame decode passed (not browser canvas/color-parity proof)");
    } finally { sample.close(); }
  } finally { proresInput.dispose(); }
  for (const [codec, encoder] of [["ac3", "ac3"], ["eac3", "eac3"], ["dts", "dca"]]) {
    const filename = join(directory, `${codec}.mka`);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-ac", "2", "-c:a", encoder, "-strict", "-2", filename], { timeout: 10_000 });
    const input = new Input({ source: new BlobSource(new Blob([readFileSync(filename)])), formats: ALL_FORMATS });
    try {
      const track = await input.getPrimaryAudioTrack(); assert(track);
      assert.equal(await track.getCodec(), codec);
      await ensureTrackDecodable(track, "audio");
      let frames = 0, energy = 0;
      for await (const sample of new AudioSampleSink(track).samples()) {
        try {
          const pcm = new Float32Array(sample.numberOfFrames);
          sample.copyTo(pcm, { format: "f32-planar", planeIndex: 0 });
          frames += pcm.length;
          for (const value of pcm) { assert(Number.isFinite(value)); energy += value * value; }
        } finally { sample.close(); }
      }
      assert(frames >= 48000 && frames < 52000); assert(energy / frames > 0.001);
      console.log(`${codec}: actual WASM decode passed (${frames} frames)`);
    } finally { input.dispose(); }
  }
  assert.equal(await canEncodeAudio("aac", { sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 }), false, "Run in Node without native AAC to exercise the extension");
  registerAacEncoder();
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const source = new AudioSampleSource({ codec: "aac", bitrate: 192000 });
  output.addAudioTrack(source);
  try {
    await output.start();
    for (let first = 0; first < 48000; first += 1600) {
      const data = new Float32Array(3200);
      for (let frame = 0; frame < 1600; frame++) data[frame * 2] = data[frame * 2 + 1] = Math.sin(2 * Math.PI * 440 * (first + frame) / 48000) * 0.2;
      const sample = new AudioSample({ data, format: "f32", numberOfChannels: 2, sampleRate: 48000, timestamp: first / 48000 });
      try { await source.add(sample); } finally { sample.close(); }
    }
    source.close(); await output.finalize(); assert(target.buffer);
    const file = join(directory, "aac.mp4"); writeFileSync(file, new Uint8Array(target.buffer));
    const metadata = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file], { encoding: "utf8", timeout: 10_000 }));
    assert.equal(metadata.streams[0].codec_name, "aac");
    const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "f32le", "-ac", "1", "pipe:1"], { timeout: 10_000 });
    assert(pcm.length >= 48000 * 4 && pcm.length < 53000 * 4);
    let energy = 0; for (let i = 0; i < pcm.length; i += 4) energy += pcm.readFloatLE(i) ** 2;
    assert(energy / (pcm.length / 4) > 0.01);
    console.log("AAC: actual WASM encode, MP4 mux and independent FFmpeg decode passed (not browser A/V synchronization proof)");
  } finally { if (output.state !== "finalized" && output.state !== "canceled") await output.cancel(); }
} finally { clearTimeout(deadline); rmSync(directory, { recursive: true, force: true }); }
