import { expect, test } from "bun:test";
import { AudioSample, AudioSampleSource, NullTarget, Output, WavOutputFormat } from "mediabunny";
import { normalizePcmTimestamp } from "./media-timing";

test("PCM muxing accepts trim round-off without masking genuinely invalid timestamps", async () => {
  for (const timestamp of [-8.881784197001252e-16, -3.552713678800501e-15]) {
    const output = new Output({ format: new WavOutputFormat(), target: new NullTarget() });
    const source = new AudioSampleSource({ codec: "pcm-f32" });
    output.addAudioTrack(source);
    await output.start();
    const sample = new AudioSample({ data: new Float32Array(128), format: "f32", sampleRate: 48000, numberOfChannels: 1, timestamp });
    try { normalizePcmTimestamp(sample); expect(sample.timestamp).toBe(0); await source.add(sample); }
    finally { sample.close(); }
    source.close(); await output.finalize();
  }
  for (const timestamp of [-0.01, 0, 0.12345, NaN, Infinity]) {
    const sample = { timestamp, setTimestamp(value: number) { this.timestamp = value; } };
    normalizePcmTimestamp(sample);
    expect(sample.timestamp).toBe(timestamp);
  }
});
