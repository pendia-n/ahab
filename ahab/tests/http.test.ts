import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedBody, HttpError, readJson } from "../src/lib/http";

function streamedRequest(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
) {
  let index = 0,
    cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++]);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request("https://ahab.example/api/test", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
  return { request, cancelled: () => cancelled, consumed: () => index };
}
const encoded = (text: string) => new TextEncoder().encode(text);
const isTooLarge = (error: unknown) =>
  error instanceof HttpError && error.status === 413;

test("boundedBody reads chunked bodies up to the exact byte limit", async () => {
  const { request } = streamedRequest([
    encoded("abc"),
    encoded("defg"),
    encoded("hij"),
  ]);
  assert.equal(
    new TextDecoder().decode(await boundedBody(request, 10)),
    "abcdefghij",
  );
  assert.equal(request.body!.locked, false);
});

test("oversized chunked input is rejected and the unread stream is cancelled immediately", async () => {
  const input = streamedRequest([
    encoded("12345"),
    encoded("678901"),
    encoded("must not be read"),
  ]);
  await assert.rejects(boundedBody(input.request, 10), isTooLarge);
  assert.equal(input.cancelled(), true);
  assert.equal(input.consumed(), 2);
  assert.equal(input.request.body!.locked, false);
});

test("a forged smaller Content-Length cannot bypass the actual streamed byte limit", async () => {
  const input = streamedRequest(
    [new Uint8Array(16_000), new Uint8Array(16_001), encoded("unread")],
    {
      "Content-Length": "1",
      "Content-Type": "application/json",
    },
  );
  await assert.rejects(readJson(input.request), isTooLarge);
  assert.equal(input.cancelled(), true);
  assert.equal(input.consumed(), 2);
});

test("an oversized advertised Content-Length is rejected without consuming the body", async () => {
  const input = streamedRequest([encoded("{}")], {
    "Content-Length": "32001",
    "Content-Type": "application/json",
  });
  await assert.rejects(readJson(input.request), isTooLarge);
  assert.equal(input.consumed(), 0);
});

test("JSON accepts exactly 32000 UTF-8 bytes and rejects the next byte", async () => {
  const text = JSON.stringify({
    text: "a".repeat(32_000 - JSON.stringify({ text: "" }).length),
  });
  assert.equal(encoded(text).byteLength, 32_000);
  assert.equal(
    (await readJson(streamedRequest([encoded(text)]).request)).text.length,
    31_989,
  );
  await assert.rejects(
    readJson(streamedRequest([encoded(text + " ")]).request),
    isTooLarge,
  );
});

test("the limit counts UTF-8 bytes rather than JavaScript characters", async () => {
  const text = JSON.stringify({ text: "界".repeat(11_000) });
  assert.ok(text.length < 32_000);
  assert.ok(encoded(text).byteLength > 32_000);
  await assert.rejects(
    readJson(streamedRequest([encoded(text)]).request),
    isTooLarge,
  );
});

test("malformed JSON and non-object payloads fail cleanly without including submitted content", async () => {
  for (const text of [
    '{"private":"do-not-echo",',
    "[]",
    "null",
    "123",
    '"text"',
    "",
  ]) {
    await assert.rejects(
      readJson(streamedRequest([encoded(text)]).request),
      (error: unknown) =>
        error instanceof HttpError &&
        error.status === 400 &&
        !error.message.includes("do-not-echo"),
    );
  }
  await assert.rejects(
    readJson(new Request("https://ahab.example/api/test", { method: "POST" })),
    (error: unknown) => error instanceof HttpError && error.status === 400,
  );
});
