const RATE = 16000;

/** One bounded transcription chunk, including timestamp gaps rather than collapsing source time. */
export function transcriptionWav(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 300000) throw new Error("Invalid transcription chunk duration");
  const frames = Math.round(durationMs * RATE / 1000);
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => new Uint8Array(buffer, offset, value.length).set(new TextEncoder().encode(value));
  text(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, frames * 2, true);
  return buffer;
}

/** Input is normalized stereo 16kHz. Avoid erasing speech in phase-inverted recordings. */
export function writeTranscriptionPcm(buffer: ArrayBuffer, pcm: Float32Array, timestampSeconds: number) {
  if (!Number.isFinite(timestampSeconds) || pcm.length % 2 || buffer.byteLength < 44 || buffer.byteLength % 2) throw new Error("Invalid transcription PCM");
  const view = new DataView(buffer);
  const frames = (buffer.byteLength - 44) / 2;
  const first = Math.round(timestampSeconds * RATE);
  let leftEnergy = 0, rightEnergy = 0, monoEnergy = 0;
  for (let index = 0; index < pcm.length; index += 2) {
    if (!Number.isFinite(pcm[index]) || !Number.isFinite(pcm[index + 1])) throw new Error("Non-finite source audio sample");
    leftEnergy += pcm[index] ** 2; rightEnergy += pcm[index + 1] ** 2;
    monoEnergy += ((pcm[index] + pcm[index + 1]) / 2) ** 2;
  }
  // Both channels must be audible for cancellation at this threshold; retain the left phase reference.
  const cancels = monoEnergy < 0.1 * Math.max(leftEnergy, rightEnergy);
  for (let index = Math.max(0, -first); index < pcm.length / 2 && first + index < frames; index++) {
    const value = Math.max(-1, Math.min(1, cancels ? pcm[index * 2] : (pcm[index * 2] + pcm[index * 2 + 1]) / 2));
    view.setInt16(44 + (first + index) * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
}
