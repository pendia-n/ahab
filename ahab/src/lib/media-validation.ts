/** Bounded, dependency-free upload inspection for the Workers runtime.
 * This validates container structure and timing, rather than trusting a browser's
 * MIME or duration. It is not a full decoder: codec payloads are still handled by
 * the media provider. Unsupported/fragmented containers are rejected explicitly.
 */
export type MediaKind = "image" | "audio" | "video";
export type MediaInspection = {
  mime: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  extension: string;
};

const MiB = 1024 * 1024;
const MAX_ELEMENTS = 100_000;
const text = new TextDecoder("ascii");
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++)
    crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  return crc >>> 0;
});

function invalid(message: string): never {
  throw new Error(message);
}
function ascii(bytes: Uint8Array, start: number, length: number): string {
  return text.decode(bytes.subarray(start, start + length));
}
function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function dimension(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 12000 ||
    height > 12000 ||
    width * height > 80_000_000
  ) {
    invalid(
      "Use an image or video with valid dimensions, at most 12,000 pixels per side and 80 megapixels.",
    );
  }
}
function durationLimit(seconds: number, maximum: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0)
    invalid("This file has no readable duration. Export it again and retry.");
  if (seconds > maximum + 0.000001)
    invalid(
      `This ${maximum === 5 ? "video reference" : "audio file"} is too long. The maximum is ${maximum} seconds.`,
    );
  return seconds;
}
function imageResult(
  mime: string,
  extension: string,
  width: number,
  height: number,
): MediaInspection {
  dimension(width, height);
  return { mime, extension, width, height, duration: null };
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++)
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]!) & 255]!;
  return (crc ^ 0xffffffff) >>> 0;
}

function png(bytes: Uint8Array): MediaInspection {
  const data = view(bytes);
  let offset = 8,
    width = 0,
    height = 0,
    hasData = false,
    chunks = 0;
  while (offset + 12 <= bytes.length && ++chunks <= MAX_ELEMENTS) {
    const size = data.getUint32(offset);
    if (size > bytes.length - offset - 12)
      invalid("This PNG is incomplete or damaged.");
    const type = ascii(bytes, offset + 4, 4),
      end = offset + 12 + size;
    if (crc32(bytes, offset + 4, end - 4) !== data.getUint32(end - 4))
      invalid("This PNG is damaged. Export the image again.");
    if (chunks === 1 && type !== "IHDR")
      invalid("This PNG has no valid image header.");
    if (type === "IHDR") {
      if (chunks !== 1 || size !== 13)
        invalid("This PNG has an invalid image header.");
      width = data.getUint32(offset + 8);
      height = data.getUint32(offset + 12);
      dimension(width, height);
      const depth = bytes[offset + 16]!,
        color = bytes[offset + 17]!;
      const depths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !depths[color]?.includes(depth) ||
        bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 ||
        bytes[offset + 20]! > 1
      )
        invalid("This PNG format is not supported. Export a standard PNG.");
    } else if (type === "acTL")
      invalid("Use a still image rather than an animated PNG.");
    else if (type === "IDAT" && size > 0) hasData = true;
    else if (type === "IEND") {
      if (size !== 0 || end !== bytes.length || !hasData)
        invalid("This PNG is incomplete or damaged.");
      return imageResult("image/png", "png", width, height);
    }
    offset = end;
  }
  return invalid("This PNG is incomplete or has too many chunks.");
}

function jpeg(bytes: Uint8Array): MediaInspection {
  const data = view(bytes);
  let offset = 2,
    width = 0,
    height = 0,
    markers = 0;
  while (offset + 1 < bytes.length && ++markers <= MAX_ELEMENTS) {
    if (bytes[offset++] !== 0xff)
      invalid("This JPEG has an invalid image header.");
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (
      marker === undefined ||
      marker === 0x00 ||
      marker === 0xd8 ||
      marker === 0xd9
    )
      invalid("This JPEG is incomplete or damaged.");
    if (offset + 2 > bytes.length) invalid("This JPEG is incomplete.");
    const size = data.getUint16(offset);
    if (size < 2 || offset + size > bytes.length)
      invalid("This JPEG is incomplete.");
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (size < 11 || width !== 0 || bytes[offset + 2] !== 8)
        invalid("Use a standard 8-bit JPEG image.");
      height = data.getUint16(offset + 3);
      width = data.getUint16(offset + 5);
      dimension(width, height);
      const channels = bytes[offset + 7]!;
      if (![1, 3, 4].includes(channels) || size !== 8 + 3 * channels)
        invalid("This JPEG has an invalid frame header.");
    } else if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      invalid("Use a standard baseline or progressive JPEG image.");
    }
    if (marker === 0xda) {
      if (
        !width ||
        offset + size >= bytes.length - 2 ||
        bytes[bytes.length - 2] !== 0xff ||
        bytes[bytes.length - 1] !== 0xd9
      )
        invalid("This JPEG has no complete image data.");
      return imageResult("image/jpeg", "jpg", width, height);
    }
    offset += size;
  }
  return invalid("This JPEG is incomplete or has too many headers.");
}

function webp(bytes: Uint8Array): MediaInspection {
  const data = view(bytes);
  if (bytes.length < 20 || data.getUint32(4, true) + 8 !== bytes.length)
    invalid("This WebP is incomplete or damaged.");
  let offset = 12,
    width = 0,
    height = 0,
    canvasWidth = 0,
    canvasHeight = 0,
    chunks = 0;
  while (offset + 8 <= bytes.length && ++chunks <= MAX_ELEMENTS) {
    const type = ascii(bytes, offset, 4),
      size = data.getUint32(offset + 4, true),
      start = offset + 8;
    if (size > bytes.length - start) invalid("This WebP is incomplete.");
    if (type === "ANIM" || type === "ANMF")
      invalid("Use a still WebP image rather than an animation.");
    if (type === "VP8X") {
      if (size !== 10 || bytes[start]! & 2) invalid("Use a still WebP image.");
      canvasWidth =
        1 +
        bytes[start + 4]! +
        bytes[start + 5]! * 256 +
        bytes[start + 6]! * 65536;
      canvasHeight =
        1 +
        bytes[start + 7]! +
        bytes[start + 8]! * 256 +
        bytes[start + 9]! * 65536;
      dimension(canvasWidth, canvasHeight);
    } else if (type === "VP8 ") {
      if (
        width ||
        size < 10 ||
        bytes[start]! & 1 ||
        bytes[start + 3] !== 0x9d ||
        bytes[start + 4] !== 1 ||
        bytes[start + 5] !== 0x2a
      )
        invalid("This WebP has no valid image frame.");
      width = data.getUint16(start + 6, true) & 0x3fff;
      height = data.getUint16(start + 8, true) & 0x3fff;
    } else if (type === "VP8L") {
      if (width || size < 5 || bytes[start] !== 0x2f)
        invalid("This WebP has no valid image frame.");
      const packed = data.getUint32(start + 1, true);
      if (packed >>> 29)
        invalid("This WebP uses an unsupported format version.");
      width = (packed & 0x3fff) + 1;
      height = ((packed >>> 14) & 0x3fff) + 1;
    }
    offset = start + size + (size & 1);
  }
  if (
    offset !== bytes.length ||
    !width ||
    !height ||
    (canvasWidth && (width !== canvasWidth || height !== canvasHeight))
  )
    invalid("This WebP has invalid dimensions or image data.");
  return imageResult("image/webp", "webp", width, height);
}

function wav(bytes: Uint8Array): MediaInspection {
  const data = view(bytes),
    end = bytes.length;
  if (end < 44 || data.getUint32(4, true) + 8 !== end)
    invalid("This WAV is incomplete or damaged.");
  let offset = 12,
    byteRate = 0,
    blockAlign = 0,
    audioBytes = 0,
    chunks = 0;
  while (offset + 8 <= end && ++chunks <= MAX_ELEMENTS) {
    const type = ascii(bytes, offset, 4),
      size = data.getUint32(offset + 4, true),
      start = offset + 8;
    if (size > end - start) invalid("This WAV is incomplete.");
    if (type === "fmt ") {
      if (byteRate || size < 16)
        invalid("This WAV has an invalid audio format.");
      let format = data.getUint16(start, true);
      const channels = data.getUint16(start + 2, true),
        rate = data.getUint32(start + 4, true),
        bits = data.getUint16(start + 14, true);
      if (format === 0xfffe) {
        if (size < 40 || data.getUint16(start + 16, true) < 22)
          invalid("This WAV has an invalid extended format.");
        format = data.getUint16(start + 24, true);
      }
      if (
        channels < 1 ||
        channels > 8 ||
        rate < 8000 ||
        rate > 192000 ||
        !(
          (format === 1 && [8, 16, 24, 32].includes(bits)) ||
          (format === 3 && [32, 64].includes(bits))
        )
      )
        invalid(
          "Export this WAV as PCM or floating-point audio, with a sample rate from 8–192 kHz.",
        );
      blockAlign = data.getUint16(start + 12, true);
      byteRate = data.getUint32(start + 8, true);
      if (
        blockAlign !== (channels * bits) / 8 ||
        byteRate !== rate * blockAlign
      )
        invalid("This WAV has inconsistent audio timing.");
    } else if (type === "data") {
      if (!byteRate || size === 0 || size % blockAlign)
        invalid("This WAV has invalid audio data.");
      audioBytes += size;
    }
    offset = start + size + (size & 1);
  }
  if (offset !== end || !byteRate || !audioBytes)
    invalid("This WAV has no complete audio data.");
  return {
    mime: "audio/wav",
    extension: "wav",
    duration: durationLimit(audioBytes / byteRate, 120),
    width: null,
    height: null,
  };
}

type Mp3Frame = {
  size: number;
  samples: number;
  rate: number;
  version: number;
  mono: boolean;
  crc: boolean;
};
function mp3Frame(bytes: Uint8Array, offset: number): Mp3Frame {
  if (
    offset + 4 > bytes.length ||
    bytes[offset] !== 0xff ||
    (bytes[offset + 1]! & 0xe0) !== 0xe0
  )
    invalid(
      "This MP3 has damaged or unsupported audio frames. Export it again as MP3 or WAV.",
    );
  const b1 = bytes[offset + 1]!,
    b2 = bytes[offset + 2]!,
    b3 = bytes[offset + 3]!;
  const version = (b1 >>> 3) & 3,
    layer = (b1 >>> 1) & 3,
    rateIndex = (b2 >>> 2) & 3,
    bitrateIndex = b2 >>> 4;
  if (
    version === 1 ||
    layer !== 1 ||
    rateIndex === 3 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    (b3 & 3) === 2
  )
    invalid("Use a standard MPEG Layer III MP3 or WAV file.");
  const rates = [44100, 48000, 32000],
    rates1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    rates2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const rate = rates[rateIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4),
    bitrate = (version === 3 ? rates1 : rates2)[bitrateIndex]! * 1000;
  const size =
    Math.floor(((version === 3 ? 144 : 72) * bitrate) / rate) +
    ((b2 >>> 1) & 1);
  if (size < 24 || offset + size > bytes.length)
    invalid("This MP3 has an incomplete audio frame.");
  return {
    size,
    samples: version === 3 ? 1152 : 576,
    rate,
    version,
    mono: b3 >>> 6 === 3,
    crc: !(b1 & 1),
  };
}
function mp3(bytes: Uint8Array): MediaInspection {
  const data = view(bytes);
  let offset = 0;
  if (ascii(bytes, 0, 3) === "ID3") {
    if (
      bytes.length < 10 ||
      ![2, 3, 4].includes(bytes[3]!) ||
      bytes.subarray(6, 10).some((b) => b & 0x80)
    )
      invalid("This MP3 has an invalid ID3 header.");
    const size =
      bytes[6]! * 2097152 + bytes[7]! * 16384 + bytes[8]! * 128 + bytes[9]!;
    offset = 10 + size + (bytes[3] === 4 && bytes[5]! & 0x10 ? 10 : 0);
    if (offset >= bytes.length) invalid("This MP3 has no audio data.");
  }
  let end = bytes.length;
  if (end >= 128 && ascii(bytes, end - 128, 3) === "TAG") end -= 128;
  let count = 0,
    seconds = 0,
    initial: Mp3Frame | undefined,
    declaredFrames: number | undefined,
    trimSamples = 0;
  while (offset < end && ++count <= MAX_ELEMENTS) {
    const frame = mp3Frame(bytes, offset);
    if (offset + frame.size > end)
      invalid("This MP3 has incomplete audio data.");
    if (!initial) {
      initial = frame;
      const xing =
        offset +
        4 +
        (frame.crc ? 2 : 0) +
        (frame.version === 3 ? (frame.mono ? 17 : 32) : frame.mono ? 9 : 17);
      if (
        xing + 12 <= offset + frame.size &&
        ["Xing", "Info"].includes(ascii(bytes, xing, 4))
      ) {
        const flags = data.getUint32(xing + 4);
        if (flags & 1) declaredFrames = data.getUint32(xing + 8);
        const encoder =
          xing +
          8 +
          (flags & 1 ? 4 : 0) +
          (flags & 2 ? 4 : 0) +
          (flags & 4 ? 100 : 0) +
          (flags & 8 ? 4 : 0);
        if (
          encoder + 24 <= offset + frame.size &&
          ["LAME", "Lavc"].includes(ascii(bytes, encoder, 4))
        ) {
          // Gapless playback discards encoder priming and padding samples.
          const delay =
            bytes[encoder + 21]! * 16 + (bytes[encoder + 22]! >>> 4);
          const padding =
            (bytes[encoder + 22]! & 15) * 256 + bytes[encoder + 23]!;
          trimSamples = delay + padding;
        }
      }
      const vbri = offset + 36;
      if (vbri + 18 <= offset + frame.size && ascii(bytes, vbri, 4) === "VBRI")
        declaredFrames = data.getUint32(vbri + 14);
    } else if (frame.version !== initial.version || frame.rate !== initial.rate)
      invalid(
        "This MP3 changes its audio format partway through. Export a single MP3 or WAV track.",
      );
    seconds += frame.samples / frame.rate;
    // Permit only the bounded encoder header/priming allowance during scanning;
    // the final audible duration below is still capped at exactly 120 seconds.
    if (seconds > 122)
      invalid("This audio file is too long. The maximum is 120 seconds.");
    offset += frame.size;
  }
  if (
    !initial ||
    offset !== end ||
    count > MAX_ELEMENTS ||
    (declaredFrames !== undefined &&
      (!declaredFrames || Math.abs(declaredFrames - count) > 1))
  )
    invalid("This MP3 has inconsistent or incomplete audio timing.");
  if (declaredFrames !== undefined)
    seconds = (declaredFrames * initial.samples - trimSamples) / initial.rate;
  return {
    mime: "audio/mpeg",
    extension: "mp3",
    duration: durationLimit(seconds, 120),
    width: null,
    height: null,
  };
}

type Atom = { type: string; start: number; end: number; body: number };
function uint64(data: DataView, offset: number): number {
  const value =
    data.getUint32(offset) * 4294967296 + data.getUint32(offset + 4);
  if (!Number.isSafeInteger(value))
    invalid("This media file contains an unsupported large value.");
  return value;
}
function mp4(bytes: Uint8Array): MediaInspection {
  const data = view(bytes);
  let atomsSeen = 0;
  function children(start: number, end: number): Atom[] {
    const result: Atom[] = [];
    while (start < end) {
      if (++atomsSeen > MAX_ELEMENTS || end - start < 8)
        invalid("This MP4 has invalid or excessive container data.");
      let size = data.getUint32(start),
        header = 8;
      const type = ascii(bytes, start + 4, 4);
      if (size === 1) {
        if (end - start < 16) invalid("This MP4 is incomplete.");
        size = uint64(data, start + 8);
        header = 16;
      } else if (size === 0) size = end - start;
      if (size < header || size > end - start)
        invalid("This MP4 is incomplete or damaged.");
      result.push({ type, start, body: start + header, end: start + size });
      start += size;
    }
    return result;
  }
  function one(list: Atom[], type: string): Atom {
    const matches = list.filter((atom) => atom.type === type);
    if (matches.length !== 1)
      invalid(
        `This MP4 has no single readable ${type} header. Export it as a standard MP4.`,
      );
    return matches[0]!;
  }
  function timing(atom: Atom): { scale: number; duration: number } {
    const version = bytes[atom.body],
      scaleAt = atom.body + (version === 0 ? 12 : version === 1 ? 20 : -1);
    if (
      (version !== 0 && version !== 1) ||
      atom.end < scaleAt + (version === 1 ? 12 : 8)
    )
      invalid("This MP4 has an invalid duration header.");
    const scale = data.getUint32(scaleAt),
      ticks =
        version === 1 ? uint64(data, scaleAt + 4) : data.getUint32(scaleAt + 4);
    if (!scale || !ticks || ticks === 0xffffffff)
      invalid("This MP4 has no finite duration. Export it again.");
    return { scale, duration: ticks / scale };
  }
  const top = children(0, bytes.length),
    ftyp = one(top, "ftyp"),
    moov = one(top, "moov"),
    mdats = top.filter((atom) => atom.type === "mdat");
  if (
    ftyp.end - ftyp.body < 8 ||
    !mdats.length ||
    top.some((atom) => atom.type === "moof")
  )
    invalid(
      "Use a standard complete MP4 file, rather than a fragmented or streaming MP4.",
    );
  const movie = children(moov.body, moov.end);
  if (movie.some((atom) => atom.type === "mvex"))
    invalid("Use a standard complete MP4 file, rather than a fragmented MP4.");
  const movieTime = timing(one(movie, "mvhd"));
  let seconds = durationLimit(movieTime.duration, 5),
    width = 0,
    height = 0,
    videos = 0;
  const tracks = movie.filter((atom) => atom.type === "trak");
  if (!tracks.length || tracks.length > 16)
    invalid("This MP4 has no supported video track.");
  for (const track of tracks) {
    const trackAtoms = children(track.body, track.end),
      mdia = one(trackAtoms, "mdia"),
      media = children(mdia.body, mdia.end),
      header = one(media, "hdlr");
    if (header.end - header.body < 12)
      invalid("This MP4 has a damaged track header.");
    const mediaTime = timing(one(media, "mdhd"));
    seconds = Math.max(seconds, durationLimit(mediaTime.duration, 5));
    const edts = trackAtoms.find((atom) => atom.type === "edts");
    if (edts) {
      const edit = children(edts.body, edts.end).find(
        (atom) => atom.type === "elst",
      );
      if (edit) {
        if (edit.end - edit.body < 8 || ![0, 1].includes(bytes[edit.body]!))
          invalid("This MP4 has an unsupported edit timeline.");
        const long = bytes[edit.body] === 1,
          count = data.getUint32(edit.body + 4),
          size = long ? 20 : 12;
        if (
          !count ||
          count > MAX_ELEMENTS ||
          edit.body + 8 + count * size !== edit.end
        )
          invalid("This MP4 has an invalid edit timeline.");
        let ticks = 0;
        for (let i = 0; i < count; i++) {
          const at = edit.body + 8 + i * size;
          ticks += long ? uint64(data, at) : data.getUint32(at);
          if (
            data.getInt16(at + (long ? 16 : 8)) !== 1 ||
            data.getInt16(at + (long ? 18 : 10)) !== 0
          )
            invalid(
              "Export this video at normal playback speed before uploading it.",
            );
        }
        seconds = Math.max(seconds, durationLimit(ticks / movieTime.scale, 5));
      }
    }
    if (ascii(bytes, header.body + 8, 4) !== "vide") continue;
    videos++;
    const minf = one(media, "minf"),
      stbl = one(children(minf.body, minf.end), "stbl"),
      tables = children(stbl.body, stbl.end);
    const stts = one(tables, "stts");
    if (stts.end - stts.body < 8) invalid("This MP4 has invalid frame timing.");
    const timeEntries = data.getUint32(stts.body + 4);
    if (
      !timeEntries ||
      timeEntries > MAX_ELEMENTS ||
      stts.body + 8 + timeEntries * 8 !== stts.end
    )
      invalid("This MP4 has invalid frame timing.");
    let ticks = 0,
      samples = 0;
    for (let i = 0; i < timeEntries; i++) {
      const at = stts.body + 8 + i * 8,
        count = data.getUint32(at),
        delta = data.getUint32(at + 4);
      if (!count || !delta) invalid("This MP4 has invalid frame timing.");
      samples += count;
      ticks += count * delta;
      if (!Number.isSafeInteger(ticks) || samples > MAX_ELEMENTS)
        invalid("This MP4 has excessive frame data.");
    }
    const trackDuration = ticks / mediaTime.scale;
    if (
      Math.abs(trackDuration - mediaTime.duration) >
      1 / mediaTime.scale + 0.000001
    )
      invalid("This MP4 has inconsistent video duration metadata.");
    seconds = Math.max(seconds, durationLimit(trackDuration, 5));
    const stsz = one(tables, "stsz");
    if (stsz.end - stsz.body < 12)
      invalid("This MP4 has no valid video samples.");
    const commonSize = data.getUint32(stsz.body + 4),
      sampleCount = data.getUint32(stsz.body + 8);
    if (
      sampleCount !== samples ||
      stsz.body + 12 + (commonSize ? 0 : samples * 4) !== stsz.end
    )
      invalid("This MP4 has inconsistent sample data.");
    const sampleSize = (index: number) =>
      commonSize || data.getUint32(stsz.body + 12 + index * 4);
    const chunkTables = tables.filter(
      (atom) => atom.type === "stco" || atom.type === "co64",
    );
    if (chunkTables.length !== 1)
      invalid("This MP4 has no readable video chunks.");
    const chunks = chunkTables[0]!,
      longOffsets = chunks.type === "co64";
    if (chunks.end - chunks.body < 8)
      invalid("This MP4 has incomplete video chunks.");
    const chunkCount = data.getUint32(chunks.body + 4);
    if (
      !chunkCount ||
      chunkCount > samples ||
      chunks.body + 8 + chunkCount * (longOffsets ? 8 : 4) !== chunks.end
    )
      invalid("This MP4 has invalid video chunks.");
    const stsc = one(tables, "stsc");
    if (stsc.end - stsc.body < 8)
      invalid("This MP4 has no sample-to-chunk table.");
    const maps = data.getUint32(stsc.body + 4);
    if (!maps || maps > chunkCount || stsc.body + 8 + maps * 12 !== stsc.end)
      invalid("This MP4 has an invalid sample-to-chunk table.");
    const map: { first: number; count: number; description: number }[] = [];
    for (let i = 0; i < maps; i++) {
      const at = stsc.body + 8 + i * 12,
        first = data.getUint32(at),
        count = data.getUint32(at + 4),
        description = data.getUint32(at + 8);
      if (
        (!i && first !== 1) ||
        (i && first <= map[i - 1]!.first) ||
        first > chunkCount ||
        !count ||
        count > samples ||
        !description
      )
        invalid("This MP4 has invalid video sample mapping.");
      map.push({ first, count, description });
    }
    const stsd = one(tables, "stsd");
    if (stsd.end - stsd.body < 8 || data.getUint32(stsd.body + 4) !== 1)
      invalid("Export an MP4 with one standard video codec per track.");
    const codec = one(
      children(stsd.body + 8, stsd.end),
      ascii(bytes, stsd.body + 12, 4),
    );
    if (
      !["avc1", "avc3", "hvc1", "hev1", "vp09", "av01", "mp4v"].includes(
        codec.type,
      ) ||
      codec.end - codec.body < 78 ||
      map.some((entry) => entry.description !== 1)
    )
      invalid(
        "Use an MP4 encoded with H.264, H.265, VP9, AV1 or MPEG-4 video.",
      );
    const trackWidth = data.getUint16(codec.body + 24),
      trackHeight = data.getUint16(codec.body + 26);
    dimension(trackWidth, trackHeight);
    if (!width) {
      width = trackWidth;
      height = trackHeight;
    }
    let sample = 0,
      mapIndex = 0;
    for (let i = 0; i < chunkCount; i++) {
      if (map[mapIndex + 1] && i + 1 >= map[mapIndex + 1]!.first) mapIndex++;
      const at = chunks.body + 8 + i * (longOffsets ? 8 : 4),
        start = longOffsets ? uint64(data, at) : data.getUint32(at);
      let size = 0;
      for (let j = 0; j < map[mapIndex]!.count; j++) {
        if (sample >= samples)
          invalid("This MP4 has inconsistent chunk counts.");
        const length = sampleSize(sample++);
        if (!length) invalid("This MP4 contains an empty video sample.");
        size += length;
      }
      if (!mdats.some((mdat) => start >= mdat.body && start + size <= mdat.end))
        invalid("This MP4 points to incomplete video data.");
    }
    if (sample !== samples) invalid("This MP4 has missing video samples.");
  }
  if (!videos || !width) invalid("This MP4 contains no supported video track.");
  return {
    mime: "video/mp4",
    extension: "mp4",
    duration: durationLimit(seconds, 5),
    width,
    height,
  };
}

type Ebml = { id: number; body: number; end: number };
function webm(bytes: Uint8Array): MediaInspection {
  const data = view(bytes);
  let elementsSeen = 0;
  function vint(
    at: number,
    end: number,
    isId = false,
  ): { value: number; length: number; unknown: boolean } {
    if (at >= end || !bytes[at])
      invalid("This WebM contains an invalid EBML value.");
    let length = 1,
      mask = 0x80;
    while (!(bytes[at]! & mask)) {
      length++;
      mask >>>= 1;
    }
    if (length > (isId ? 4 : 8) || at + length > end)
      invalid("This WebM contains an unsupported EBML value.");
    let value = isId ? bytes[at]! : bytes[at]! & (mask - 1),
      unknown = !isId && value === mask - 1;
    for (let i = 1; i < length; i++) {
      value = value * 256 + bytes[at + i]!;
      unknown &&= bytes[at + i] === 255;
    }
    if (!unknown && !Number.isSafeInteger(value))
      invalid("This WebM contains an unsupported large value.");
    return { value, length, unknown };
  }
  function children(
    start: number,
    end: number,
    allowUnknownSegment = false,
  ): Ebml[] {
    const result: Ebml[] = [];
    while (start < end) {
      if (++elementsSeen > MAX_ELEMENTS)
        invalid("This WebM has too many container elements.");
      const id = vint(start, end, true),
        size = vint(start + id.length, end),
        body = start + id.length + size.length;
      if (size.unknown && !(allowUnknownSegment && id.value === 0x18538067))
        invalid(
          "Export this streaming WebM as a complete MP4 or WebM file before uploading.",
        );
      const next = size.unknown ? end : body + size.value;
      if (next > end || next < body) invalid("This WebM is incomplete.");
      result.push({ id: id.value, body, end: next });
      start = next;
    }
    return result;
  }
  function one(list: Ebml[], id: number): Ebml {
    const matches = list.filter((el) => el.id === id);
    if (matches.length !== 1)
      invalid("This WebM has missing or duplicated media headers.");
    return matches[0]!;
  }
  function integer(el: Ebml): number {
    if (el.end <= el.body || el.end - el.body > 8)
      invalid("This WebM has an invalid integer value.");
    let value = 0;
    for (let i = el.body; i < el.end; i++) value = value * 256 + bytes[i]!;
    if (!Number.isSafeInteger(value))
      invalid("This WebM has an unsupported large integer.");
    return value;
  }
  const roots = children(0, bytes.length, true),
    ebml = one(roots, 0x1a45dfa3),
    doc = one(children(ebml.body, ebml.end), 0x4282);
  if (ascii(bytes, doc.body, doc.end - doc.body) !== "webm")
    invalid("Use a WebM or MP4 video file.");
  const segment = one(roots, 0x18538067),
    contents = children(segment.body, segment.end),
    info = one(contents, 0x1549a966),
    infoValues = children(info.body, info.end);
  const scaleEl = infoValues.find((el) => el.id === 0x2ad7b1),
    scale = scaleEl ? integer(scaleEl) : 1_000_000;
  if (scale < 1 || scale > 1_000_000_000)
    invalid("This WebM has an unsupported timestamp scale.");
  const durationEl = one(infoValues, 0x4489),
    durationBytes = durationEl.end - durationEl.body;
  if (![4, 8].includes(durationBytes))
    invalid("This WebM has an invalid duration.");
  const declared =
    ((durationBytes === 4
      ? data.getFloat32(durationEl.body)
      : data.getFloat64(durationEl.body)) *
      scale) /
    1e9;
  durationLimit(declared, 5);
  const tracksEl = one(contents, 0x1654ae6b),
    tracks = children(tracksEl.body, tracksEl.end).filter(
      (el) => el.id === 0xae,
    );
  type Track = {
    video: boolean;
    frameDuration: number;
    starts: number[];
    observedEnd: number;
  };
  const trackMap = new Map<number, Track>();
  let width = 0,
    height = 0;
  if (!tracks.length || tracks.length > 16)
    invalid("This WebM has no supported video track.");
  for (const entry of tracks) {
    const values = children(entry.body, entry.end),
      number = integer(one(values, 0xd7)),
      type = integer(one(values, 0x83));
    if (!number || trackMap.has(number))
      invalid("This WebM has invalid track numbers.");
    const frame = values.find((el) => el.id === 0x23e383),
      frameDuration = frame ? integer(frame) / 1e9 : 0;
    if (frameDuration > 5)
      invalid("This WebM contains a video frame longer than five seconds.");
    trackMap.set(number, {
      video: type === 1,
      frameDuration,
      starts: [],
      observedEnd: 0,
    });
    if (type === 1) {
      const codec = one(values, 0x86);
      if (
        !["V_VP8", "V_VP9", "V_AV1"].includes(
          ascii(bytes, codec.body, codec.end - codec.body),
        )
      )
        invalid("Use WebM video encoded with VP8, VP9 or AV1.");
      const videoEl = one(values, 0xe0),
        video = children(videoEl.body, videoEl.end),
        w = integer(one(video, 0xb0)),
        h = integer(one(video, 0xba));
      dimension(w, h);
      if (!width) {
        width = w;
        height = h;
      }
    }
  }
  if (!width) invalid("This WebM contains no supported video track.");
  function block(el: Ebml, timestamp: number, duration?: number): void {
    const trackId = vint(el.body, el.end),
      at = el.body + trackId.length;
    if (trackId.unknown || at + 3 >= el.end)
      invalid("This WebM contains an invalid media block.");
    const track = trackMap.get(trackId.value);
    if (!track) invalid("This WebM refers to an unknown media track.");
    const start = ((timestamp + data.getInt16(at)) * scale) / 1e9;
    if (start < -1 || start > 5)
      invalid(
        "This WebM contains video or audio outside the five-second limit.",
      );
    const lacing = (bytes[at + 2]! >>> 1) & 3;
    let cursor = at + 3,
      frames = 1;
    if (lacing) {
      frames = bytes[cursor++]! + 1;
      if (cursor >= el.end) invalid("This WebM has invalid laced frames.");
      let used = 0;
      if (lacing === 2) {
        if ((el.end - cursor) % frames || el.end - cursor < frames)
          invalid("This WebM has invalid fixed-size frames.");
      } else {
        let previous = 0;
        for (let i = 0; i < frames - 1; i++) {
          let size = 0;
          if (lacing === 1) {
            let octet: number;
            do {
              if (cursor >= el.end)
                invalid("This WebM has invalid frame lengths.");
              octet = bytes[cursor++]!;
              size += octet;
            } while (octet === 255);
          } else {
            const value = vint(cursor, el.end);
            cursor += value.length;
            if (value.unknown) invalid("This WebM has invalid frame lengths.");
            size =
              i === 0
                ? value.value
                : previous + value.value - (2 ** (7 * value.length - 1) - 1);
          }
          if (size <= 0 || !Number.isSafeInteger(size))
            invalid("This WebM contains an empty or invalid frame.");
          used += size;
          previous = size;
        }
        if (used >= el.end - cursor)
          invalid("This WebM has incomplete laced frames.");
      }
    }
    if (cursor >= el.end) invalid("This WebM contains an empty media block.");
    if (track.video) track.starts.push(Math.max(0, start));
    track.observedEnd = Math.max(
      track.observedEnd,
      start +
        (duration !== undefined
          ? (duration * scale) / 1e9
          : track.frameDuration * frames),
    );
  }
  const clusters = contents.filter((el) => el.id === 0x1f43b675);
  if (!clusters.length) invalid("This WebM has no media data.");
  for (const cluster of clusters) {
    const values = children(cluster.body, cluster.end),
      timestamp = integer(one(values, 0xe7));
    for (const el of values) {
      if (el.id === 0xa3) block(el, timestamp);
      else if (el.id === 0xa0) {
        const group = children(el.body, el.end),
          media = one(group, 0xa1),
          duration = group.find((value) => value.id === 0x9b);
        block(media, timestamp, duration ? integer(duration) : undefined);
      }
    }
  }
  let observed = 0;
  for (const track of trackMap.values()) {
    if (track.video && !track.starts.length)
      invalid("This WebM has an empty video track.");
    if (track.video && !track.frameDuration && track.starts.length > 1) {
      const sorted = [...new Set(track.starts)].sort((a, b) => a - b),
        deltas = sorted
          .slice(1)
          .map((start, i) => start - sorted[i]!)
          .sort((a, b) => a - b);
      const interval = deltas[Math.floor(deltas.length / 2)] ?? 0;
      track.observedEnd = Math.max(
        track.observedEnd,
        sorted[sorted.length - 1]! + interval,
      );
    }
    observed = Math.max(observed, track.observedEnd);
  }
  // WebM block timestamps are quantized to TimestampScale, while DefaultDuration
  // remains in nanoseconds. Allow one timestamp tick of rounding, never a frame.
  if (declared + scale / 1e9 + 0.000001 < observed)
    invalid("This WebM has inconsistent duration metadata. Export it again.");
  return {
    mime: "video/webm",
    extension: "webm",
    duration: durationLimit(declared, 5),
    width,
    height,
  };
}

export async function validateMedia(
  file: File,
  kind: MediaKind,
): Promise<MediaInspection> {
  const maximum = kind === "image" ? 10 * MiB : 16 * MiB;
  if (!file || !Number.isFinite(file.size) || file.size <= 0)
    invalid("Choose a nonempty media file.");
  if (file.size > maximum)
    invalid(
      `The maximum ${kind} upload size is ${kind === "image" ? 10 : 16} MB.`,
    );
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size)
    invalid("The upload is incomplete. Please retry.");
  try {
    if (kind === "image") {
      if (
        bytes.length >= 8 &&
        [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)
      )
        return png(bytes);
      if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes);
      if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP")
        return webp(bytes);
      invalid(
        "Upload a JPG, PNG or still WebP image. Renaming another file does not convert it.",
      );
    }
    if (kind === "audio") {
      if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE")
        return wav(bytes);
      if (
        ascii(bytes, 0, 3) === "ID3" ||
        (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
      )
        return mp3(bytes);
      invalid("Upload an MP3 or WAV audio file.");
    }
    if (kind === "video") {
      if (ascii(bytes, 4, 4) === "ftyp") return mp4(bytes);
      if (bytes.length >= 4 && view(bytes).getUint32(0) === 0x1a45dfa3)
        return webm(bytes);
      invalid(
        "Upload a complete MP4 or WebM video, at most five seconds long.",
      );
    }
    return invalid("Choose a supported media type.");
  } catch (error) {
    if (error instanceof RangeError)
      invalid(
        "This media file is incomplete or damaged. Export it again and retry.",
      );
    throw error;
  }
}
