/** Accept only the bounded PCM WAV shape produced by our browser preparation worker. */
export function transcriptionDurationSeconds(bytes: ArrayBuffer): number {
  if (bytes.byteLength < 44 || bytes.byteLength > 10 * 1024 * 1024) throw new Error("Expected a mono 16 kHz PCM WAV chunk up to five minutes");
  const view = new DataView(bytes);
  const text = (offset: number) => String.fromCharCode(...new Uint8Array(bytes, offset, 4));
  if (text(0) !== "RIFF" || text(8) !== "WAVE" || view.getUint32(4, true) + 8 !== bytes.byteLength) throw new Error("Invalid WAV container");
  let format = false;
  let frames = 0;
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const kind = text(offset);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + size > bytes.byteLength) throw new Error("Truncated WAV chunk");
    if (kind === "fmt ") {
      if (format || size < 16 || view.getUint16(start, true) !== 1 || view.getUint16(start + 2, true) !== 1 || view.getUint32(start + 4, true) !== 16000 || view.getUint32(start + 8, true) !== 32000 || view.getUint16(start + 12, true) !== 2 || view.getUint16(start + 14, true) !== 16) throw new Error("Expected mono 16 kHz signed 16-bit PCM");
      format = true;
    } else if (kind === "data") {
      if (!format || frames || !size || size % 2) throw new Error("Invalid WAV audio data");
      frames = size / 2;
    }
    offset = start + size + (size % 2);
  }
  if (!format || !frames || frames > 300 * 16000) throw new Error("Audio chunk must contain at most five minutes");
  return Math.max(1, Math.ceil(frames / 16000));
}
