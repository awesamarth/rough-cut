// Mediabunny 1.55.x does not write AAC priming edit lists. Only patch our own non-fragmented,
// moov-at-end outputs: mdat offsets stay unchanged. Reject unfamiliar metadata, never guess.
type Box = { type: string; data: Uint8Array<ArrayBuffer> };
const decoder = new TextDecoder();
const encoder = new TextEncoder();
function boxes(bytes: Uint8Array): Box[] {
  const result: Box[] = [];
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new Error("Truncated MP4 metadata");
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset).getUint32(0);
    if (size < 8 || offset + size > bytes.length) throw new Error("Unsupported MP4 metadata box");
    result.push({ type: decoder.decode(bytes.subarray(offset + 4, offset + 8)), data: bytes.slice(offset, offset + size) });
    offset += size;
  }
  return result;
}
function box(type: string, children: Uint8Array[]) {
  const length = 8 + children.reduce((sum, child) => sum + child.length, 0);
  const data = new Uint8Array(length); new DataView(data.buffer).setUint32(0, length); data.set(encoder.encode(type), 4);
  let offset = 8; for (const child of children) { data.set(child, offset); offset += child.length; }
  return data;
}
function timeInfo(data: Uint8Array, trackHeader = false) {
  const version = data[8];
  if (version !== 0 && version !== 1) throw new Error("Unsupported MP4 timing version");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const durationOffset = trackHeader ? (version === 1 ? 36 : 28) : (version === 1 ? 32 : 24);
  if (durationOffset + (version === 1 ? 8 : 4) > data.length) throw new Error("Truncated MP4 timing");
  return { version, view, durationOffset, scale: trackHeader ? 0 : view.getUint32(version === 1 ? 28 : 20) };
}
function setDuration(data: Uint8Array, duration: number, trackHeader = false) {
  const { version, view, durationOffset } = timeInfo(data, trackHeader);
  if (!Number.isSafeInteger(duration) || duration < 0 || version === 0 && duration > 0xffffffff) throw new Error("MP4 duration exceeds metadata range");
  if (version === 1) view.setBigUint64(durationOffset, BigInt(duration)); else view.setUint32(durationOffset, duration);
}

export function fixMp4Timing(metadata: Uint8Array, durationSeconds: number, audioDelaySeconds: number) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(audioDelaySeconds) || audioDelaySeconds < 0 || audioDelaySeconds > 0.25 || metadata.length > 32 * 1024 * 1024) throw new Error("Invalid MP4 timing correction");
  const outer = boxes(metadata);
  if (outer.length !== 1 || outer[0].type !== "moov") throw new Error("Expected one moov-at-end metadata box");
  const children = boxes(outer[0].data.subarray(8));
  const movie = children.find((child) => child.type === "mvhd");
  if (!movie) throw new Error("Missing movie header");
  const movieScale = timeInfo(movie.data).scale;
  if (!movieScale) throw new Error("Invalid movie timescale");
  const duration = Math.round(durationSeconds * movieScale);
  setDuration(movie.data, duration);
  let audioTracks = 0;
  for (const track of children.filter((child) => child.type === "trak")) {
    const parts = boxes(track.data.subarray(8));
    const header = parts.find((part) => part.type === "tkhd");
    const media = parts.find((part) => part.type === "mdia");
    if (!header || !media) throw new Error("Missing track metadata");
    setDuration(header.data, duration, true);
    const mediaParts = boxes(media.data.subarray(8));
    const handler = mediaParts.find((part) => part.type === "hdlr");
    if (!handler || handler.data.length < 20) throw new Error("Missing track handler");
    if (decoder.decode(handler.data.subarray(16, 20)) === "soun") {
      audioTracks++;
      const mediaHeader = mediaParts.find((part) => part.type === "mdhd");
      if (!mediaHeader || parts.some((part) => part.type === "edts")) throw new Error("Unexpected existing AAC edit list");
      const scale = timeInfo(mediaHeader.data).scale;
      if (!scale) throw new Error("Invalid audio timescale");
      const entry = new Uint8Array(28); const view = new DataView(entry.buffer);
      entry[0] = 1; view.setUint32(4, 1); // FullBox v1; one edit.
      view.setBigUint64(8, BigInt(duration));
      view.setBigInt64(16, BigInt(Math.round(audioDelaySeconds * scale)));
      view.setInt16(24, 1); // media_rate = 1.0
      parts.push({ type: "edts", data: box("edts", [box("elst", [entry])]) });
    }
    track.data = box("trak", parts.map((part) => part.data));
  }
  if (audioTracks > 1) throw new Error("Expected one mixed audio track");
  return box("moov", children.map((child) => child.data));
}
