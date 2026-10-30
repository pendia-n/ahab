import assert from "node:assert/strict";
import test from "node:test";
import { validateMedia } from "../src/lib/media-validation.ts";

const join = (...parts: Uint8Array[]) =>
  Uint8Array.from(parts.flatMap((part) => Array.from(part)));
const str = (value: string) => new TextEncoder().encode(value);
const u32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
};
const file = (bytes: Uint8Array, name = "upload", type = "") =>
  new File([Uint8Array.from(bytes)], name, { type });

function wav(seconds: number): Uint8Array {
  const size = Math.round(seconds * 8000),
    bytes = new Uint8Array(44 + size),
    data = new DataView(bytes.buffer);
  bytes.set(str("RIFF"));
  data.setUint32(4, 36 + size, true);
  bytes.set(str("WAVEfmt "), 8);
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, 8000, true);
  data.setUint32(28, 8000, true);
  data.setUint16(32, 1, true);
  data.setUint16(34, 8, true);
  bytes.set(str("data"), 36);
  data.setUint32(40, size, true);
  bytes.fill(128, 44);
  return bytes;
}
function mp3(frames: number, variable = false): Uint8Array {
  const result: Uint8Array[] = [];
  for (let i = 0; i < frames; i++) {
    const bitrate = variable && i % 2 ? 192000 : 128000,
      frame = new Uint8Array(Math.floor((144 * bitrate) / 44100));
    frame.set([0xff, 0xfb, variable && i % 2 ? 0xb0 : 0x90, 0]);
    result.push(frame);
  }
  return join(...result);
}
const atom = (type: string, ...parts: Uint8Array[]) => {
  const body = join(...parts);
  return join(u32(body.length + 8), str(type), body);
};
function mp4(
  seconds: number,
  options: {
    declaredSeconds?: number;
    badOffset?: boolean;
    samples?: number;
    fragmented?: boolean;
  } = {},
): Uint8Array {
  const count = options.samples ?? 10,
    duration = Math.round(seconds * 1000);
  const time = (ticks: number) =>
    join(new Uint8Array(12), u32(1000), u32(ticks));
  const ftyp = atom("ftyp", str("isom"), u32(0), str("isommp42")),
    mdat = atom("mdat", new Uint8Array(count));
  const visual = new Uint8Array(78),
    visualView = new DataView(visual.buffer);
  visualView.setUint16(6, 1);
  visualView.setUint16(24, 720);
  visualView.setUint16(26, 1280);
  const stbl = atom(
    "stbl",
    atom("stsd", u32(0), u32(1), atom("avc1", visual)),
    atom("stts", u32(0), u32(1), u32(count), u32(duration / count)),
    atom("stsz", u32(0), u32(1), u32(count)),
    atom("stsc", u32(0), u32(1), u32(1), u32(count), u32(1)),
    atom("stco", u32(0), u32(1), u32(options.badOffset ? 4 : ftyp.length + 8)),
  );
  const track = atom(
    "trak",
    atom(
      "mdia",
      atom("mdhd", time(duration)),
      atom("hdlr", u32(0), u32(0), str("vide")),
      atom("minf", stbl),
    ),
  );
  const movie = atom(
    "moov",
    atom("mvhd", time(Math.round((options.declaredSeconds ?? seconds) * 1000))),
    track,
    ...(options.fragmented ? [atom("mvex")] : []),
  );
  return join(ftyp, mdat, movie);
}
function sizeVint(size: number): Uint8Array {
  for (let length = 1; length <= 4; length++) {
    if (size < 2 ** (length * 7) - 1) {
      const out = new Uint8Array(length);
      let remaining = size;
      for (let i = length - 1; i >= 0; i--) {
        out[i] = remaining & 255;
        remaining = Math.floor(remaining / 256);
      }
      out[0]! |= 1 << (8 - length);
      return out;
    }
  }
  throw new Error("Fixture too large");
}
function ebml(id: number, ...parts: Uint8Array[]): Uint8Array {
  const body = join(...parts),
    hex = id
      .toString(16)
      .padStart(id.toString(16).length + (id.toString(16).length % 2), "0");
  return join(
    Uint8Array.from(Buffer.from(hex, "hex")),
    sizeVint(body.length),
    body,
  );
}
function webm(
  seconds: number,
  declared = seconds,
  extraBlockTimestamp?: number,
): Uint8Array {
  const duration = new Uint8Array(8);
  new DataView(duration.buffer).setFloat64(0, declared * 1000);
  const header = ebml(0x1a45dfa3, ebml(0x4282, str("webm")));
  const info = ebml(
    0x1549a966,
    ebml(0x2ad7b1, Uint8Array.of(0x0f, 0x42, 0x40)),
    ebml(0x4489, duration),
  );
  const tracks = ebml(
    0x1654ae6b,
    ebml(
      0xae,
      ebml(0xd7, Uint8Array.of(1)),
      ebml(0x83, Uint8Array.of(1)),
      ebml(0x86, str("V_VP9")),
      ebml(0x23e383, u32(500_000_000)),
      ebml(
        0xe0,
        ebml(0xb0, Uint8Array.of(2, 208)),
        ebml(0xba, Uint8Array.of(5, 0)),
      ),
    ),
  );
  const blocks: Uint8Array[] = [];
  const add = (timestamp: number) => {
    const value = new Uint8Array(5);
    value[0] = 0x81;
    new DataView(value.buffer).setInt16(1, timestamp);
    value[3] = 0x80;
    value[4] = 1;
    blocks.push(ebml(0xa3, value));
  };
  for (let milliseconds = 0; milliseconds < seconds * 1000; milliseconds += 500)
    add(milliseconds);
  if (extraBlockTimestamp !== undefined) add(extraBlockTimestamp);
  const cluster = ebml(0x1f43b675, ebml(0xe7, Uint8Array.of(0)), ...blocks);
  return join(header, ebml(0x18538067, info, tracks, cluster));
}

test("does not trust a browser MIME or renamed extension", async () => {
  await assert.rejects(
    validateMedia(
      file(str("<script>bad()</script>"), "portrait.png", "image/png"),
      "image",
    ),
    /JPG, PNG/,
  );
  const audio = await validateMedia(
    file(wav(1), "fake.jpg", "image/jpeg"),
    "audio",
  );
  assert.equal(audio.mime, "audio/wav");
  assert.equal(audio.duration, 1);
});
test("empty and oversized uploads are rejected before parsing", async () => {
  await assert.rejects(
    validateMedia(file(new Uint8Array()), "image"),
    /nonempty/,
  );
  await assert.rejects(
    validateMedia(file(new Uint8Array(10 * 1024 * 1024 + 1)), "image"),
    /10 MB/,
  );
  await assert.rejects(
    validateMedia(file(new Uint8Array(16 * 1024 * 1024 + 1)), "video"),
    /16 MB/,
  );
});
test("reads a real PNG and rejects damaged CRC data", async () => {
  const bytes = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  assert.deepEqual(await validateMedia(file(bytes), "image"), {
    mime: "image/png",
    extension: "png",
    width: 1,
    height: 1,
    duration: null,
  });
  bytes[20] = 1;
  await assert.rejects(validateMedia(file(bytes), "image"), /damaged/);
});
test("WAV duration is computed from audio data and accepts the 121 second boundary", async () => {
  assert.equal((await validateMedia(file(wav(121)), "audio")).duration, 121);
  await assert.rejects(
    validateMedia(file(wav(121.001)), "audio"),
    /121 seconds/,
  );
});
test("WAV rejects forged byte rates and truncated chunks", async () => {
  const wrongRate = wav(2);
  new DataView(wrongRate.buffer).setUint32(28, 16000, true);
  await assert.rejects(
    validateMedia(file(wrongRate), "audio"),
    /inconsistent audio timing/,
  );
  await assert.rejects(
    validateMedia(file(wav(1).subarray(0, 100)), "audio"),
    /incomplete/,
  );
});
test("MP3 duration uses every frame including variable bit rates", async () => {
  const result = await validateMedia(file(mp3(100, true)), "audio");
  assert.equal(result.mime, "audio/mpeg");
  assert.ok(Math.abs(result.duration! - (100 * 1152) / 44100) < 1e-8);
});
test("MP3 does not accept a spoofed Xing frame count or truncated final frame", async () => {
  const spoofed = mp3(100);
  spoofed.set(str("Xing"), 36);
  new DataView(spoofed.buffer).setUint32(40, 1);
  new DataView(spoofed.buffer).setUint32(44, 10);
  await assert.rejects(validateMedia(file(spoofed), "audio"), /inconsistent/);
  await assert.rejects(
    validateMedia(file(mp3(10).subarray(0, -1)), "audio"),
    /incomplete/,
  );
});
test("MP3 actual frames enforce the duration cap", async () => {
  await assert.rejects(validateMedia(file(mp3(4633)), "audio"), /121 seconds/);
});
test("MP4 uses video sample timing and accepts a complete five second file", async () => {
  assert.deepEqual(await validateMedia(file(mp4(5)), "video"), {
    mime: "video/mp4",
    extension: "mp4",
    width: 720,
    height: 1280,
    duration: 5,
  });
});
test("MP4 cannot bypass the five second cap with a shorter movie header", async () => {
  await assert.rejects(
    validateMedia(file(mp4(6, { declaredSeconds: 1 })), "video"),
    /5 seconds/,
  );
});
test("MP4 rejects missing sample data, inconsistent frame times and streaming files", async () => {
  await assert.rejects(
    validateMedia(file(mp4(2, { badOffset: true })), "video"),
    /incomplete video data/,
  );
  const wrongTimes = mp4(2),
    typeAt = Buffer.from(wrongTimes).indexOf("stts");
  new DataView(wrongTimes.buffer).setUint32(typeAt + 16, 300);
  await assert.rejects(
    validateMedia(file(wrongTimes), "video"),
    /inconsistent video duration/,
  );
  await assert.rejects(
    validateMedia(file(mp4(2, { fragmented: true })), "video"),
    /fragmented/,
  );
});
test("WebM duration is checked against its video blocks", async () => {
  assert.deepEqual(await validateMedia(file(webm(5)), "video"), {
    mime: "video/webm",
    extension: "webm",
    width: 720,
    height: 1280,
    duration: 5,
  });
  await assert.rejects(
    validateMedia(file(webm(6, 1)), "video"),
    /outside the five-second limit|inconsistent duration/,
  );
  await assert.rejects(
    validateMedia(file(webm(5, 1)), "video"),
    /inconsistent duration/,
  );
});
test("WebM rejects extra late blocks and truncated containers", async () => {
  await assert.rejects(
    validateMedia(file(webm(2, 2, 6000)), "video"),
    /outside the five-second limit/,
  );
  await assert.rejects(
    validateMedia(file(webm(2).subarray(0, -1)), "video"),
    /incomplete/,
  );
});
test("parsers turn malformed container offsets into readable errors", async () => {
  const malformed = join(
    str("RIFF"),
    Uint8Array.of(255, 255, 255, 255),
    str("WEBPVP8 "),
  );
  await assert.rejects(
    validateMedia(file(malformed), "image"),
    /incomplete|damaged/,
  );
  await assert.rejects(
    validateMedia(file(Uint8Array.of(0xff, 0xd8, 0xff)), "image"),
    /incomplete/,
  );
});
