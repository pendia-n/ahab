/** Inspect MP4 metadata without buffering a full video in a Worker. */
export function inspectMp4Metadata(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (at: number) =>
    String.fromCharCode(...bytes.subarray(at, at + 4));
  const boxes = (start: number, end: number) => {
    const found: { type: string; body: number; end: number }[] = [];
    let p = start;
    while (p + 8 <= end && found.length < 2000) {
      let n = view.getUint32(p);
      let h = 8;
      if (n === 1) {
        if (p + 16 > end) break;
        n = Number(view.getBigUint64(p + 8));
        h = 16;
      }
      if (n === 0) n = end - p;
      if (!Number.isSafeInteger(n) || n < h || p + n > end) break;
      found.push({ type: str(p + 4), body: p + h, end: p + n });
      p += n;
    }
    return found;
  };
  let moov: { body: number; end: number } | undefined;
  for (let at = 4; at + 8 < bytes.length; at++) {
    if (str(at) !== "moov") continue;
    const n = view.getUint32(at - 4);
    if (n >= 8 && at - 4 + n <= bytes.length) {
      moov = { body: at + 4, end: at - 4 + n };
      break;
    }
  }
  if (!moov)
    throw new Error("The completed video has no readable MP4 metadata.");
  const root = boxes(moov.body, moov.end),
    mvhd = root.find((b) => b.type === "mvhd");
  if (!mvhd || mvhd.end - mvhd.body < 20)
    throw new Error("The completed video has no readable timing.");
  const v = bytes[mvhd.body],
    scaleAt = mvhd.body + (v === 1 ? 20 : 12),
    durationAt = scaleAt + 4;
  if (durationAt + (v === 1 ? 8 : 4) > mvhd.end)
    throw new Error("Invalid video timing.");
  const scale = view.getUint32(scaleAt),
    ticks =
      v === 1
        ? Number(view.getBigUint64(durationAt))
        : view.getUint32(durationAt),
    duration = ticks / scale;
  let width = 0,
    height = 0,
    hasAudio = false;
  for (const track of root.filter((b) => b.type === "trak")) {
    const parts = boxes(track.body, track.end),
      mdia = parts.find((b) => b.type === "mdia"),
      tkhd = parts.find((b) => b.type === "tkhd");
    if (!mdia) continue;
    const handler = boxes(mdia.body, mdia.end).find((b) => b.type === "hdlr");
    if (!handler || handler.end - handler.body < 12) continue;
    const type = str(handler.body + 8);
    if (type === "soun") hasAudio = true;
    if (type === "vide" && tkhd && tkhd.end - tkhd.body >= 8) {
      width = view.getUint32(tkhd.end - 8) / 65536;
      height = view.getUint32(tkhd.end - 4) / 65536;
    }
  }
  if (!Number.isFinite(duration) || duration <= 0 || !width || !height)
    throw new Error("The completed video has invalid dimensions or duration.");
  return { duration, width, height, hasAudio };
}
export async function validateOutput(
  bucket: R2Bucket,
  key: string,
  size: number,
  target: number,
  resolution: string,
  needsSpeech: boolean,
  presenter: boolean,
) {
  const limit = 4 * 1024 * 1024,
    first = await bucket.get(key, {
      range: { offset: 0, length: Math.min(size, limit) },
    });
  if (!first) throw new Error("The completed video is missing.");
  let metadata;
  try {
    metadata = inspectMp4Metadata(
      new Uint8Array(await new Response(first.body).arrayBuffer()),
    );
  } catch {
    const last = await bucket.get(key, {
      range: {
        offset: Math.max(0, size - limit),
        length: Math.min(size, limit),
      },
    });
    if (!last) throw new Error("The completed video is missing.");
    metadata = inspectMp4Metadata(
      new Uint8Array(await new Response(last.body).arrayBuffer()),
    );
  }
  const shortSide = Math.min(metadata.width, metadata.height),
    expected = resolution === "720p" ? 720 : 1080;
  if (
    shortSide < expected ||
    Math.abs(metadata.width / metadata.height - 9 / 16) > 0.025 ||
    metadata.duration > target + 2 ||
    (!presenter && metadata.duration < target - 1) ||
    (needsSpeech && !metadata.hasAudio)
  )
    throw new Error(
      "The completed video did not meet its format, timing or audio requirements.",
    );
  return metadata;
}
