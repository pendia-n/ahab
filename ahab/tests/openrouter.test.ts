import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import {
  buildVideoRequest,
  downloadVideo,
  generatePortrait,
  getAvatarVoices,
  MODELS,
  modelCapabilities,
  OpenRouterError,
  pollVideo,
  submitVideo,
} from "../src/lib/openrouter.ts";

const env = {
  APP_URL: "https://ahab.example",
  OPENROUTER_API_KEY: "test-only-not-a-real-key",
  AHAB_AVATAR_MAX_SECONDS_VERIFIED: "120",
  AHAB_AVATAR_VOICES: JSON.stringify([
    { id: "operator-verified-voice", label: "Configured voice" },
  ]),
};
const image = `${env.APP_URL}/api/provider-media/image?token=expiring-test-token`;
const audio = `${env.APP_URL}/api/provider-media/audio?token=expiring-test-token`;
const video = `${env.APP_URL}/api/provider-media/video?token=expiring-test-token`;
const presenter = {
  mode: "presenter" as const,
  prompt: "The exact approved script.",
  duration: 30,
  images: [image],
  voiceId: "operator-verified-voice",
  captions: true,
};
const reference = {
  mode: "scene" as const,
  prompt: "A short vertical product reaction.",
  duration: 15,
  images: [image],
};

afterEach(() => mock.restoreAll());

function mockCatalogAndCall(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  return mock.method(
    globalThis,
    "fetch",
    async (value: string | URL | Request, init: RequestInit = {}) => {
      const url = String(value);
      if (url.endsWith("/videos/models")) {
        assert.equal(new Headers(init.headers).has("authorization"), false);
        return Response.json({
          data: [
            {
              id: MODELS.presenter,
              supported_durations: null,
              supported_resolutions: ["720p", "1080p"],
              supported_aspect_ratios: ["9:16"],
              allowed_passthrough_parameters: [
                "voice_id",
                "caption",
                "motion_prompt",
              ],
            },
            {
              id: MODELS.video_reference,
              supported_durations: Array.from({ length: 29 }, (_, i) => i + 2),
              supported_resolutions: ["720p", "1080p"],
              supported_aspect_ratios: ["9:16"],
              allowed_passthrough_parameters: ["prompt_enhancement"],
            },
          ],
        });
      }
      if (url.endsWith("/images/models"))
        return Response.json({
          data: [
            {
              id: MODELS.portrait,
              supported_parameters: {
                resolution: { type: "enum", values: ["1K"] },
                aspect_ratio: { type: "enum", values: ["9:16"] },
                n: { type: "range", min: 1, max: 1 },
                input_references: { type: "range", min: 0, max: 10 },
              },
            },
            {
              id: MODELS.image_edit,
              supported_parameters: {
                resolution: { type: "enum", values: ["1K"] },
                aspect_ratio: { type: "enum", values: ["9:16"] },
                n: { type: "range", min: 1, max: 1 },
                input_references: { type: "range", min: 0, max: 14 },
              },
            },
          ],
        });
      return handler(url, init);
    },
  );
}

test("Avatar IV directly voices the approved text using a configured voice", () => {
  const body = buildVideoRequest(env, presenter);
  assert.equal(body.model, MODELS.presenter);
  assert.equal(body.prompt, presenter.prompt);
  assert.equal(body.resolution, "1080p");
  assert.equal(body.aspect_ratio, "9:16");
  assert.deepEqual(body.input_references, [
    { type: "image_url", image_url: { url: image } },
  ]);
  assert.deepEqual(body.provider, {
    options: {
      heygen: { parameters: { voice_id: presenter.voiceId, caption: true } },
    },
  });
  assert.equal("generate_audio" in body, false);
});

test("uploaded narration remains audio input and does not request another TTS voice", () => {
  const body = buildVideoRequest(env, {
    ...presenter,
    voiceId: undefined,
    audio: { url: audio, duration: 27 },
  });
  assert.deepEqual((body.input_references as unknown[])[1], {
    type: "audio_url",
    audio_url: { url: audio },
  });
  assert.deepEqual(body.provider, {
    options: { heygen: { parameters: { caption: true } } },
  });
  assert.throws(
    () =>
      buildVideoRequest(env, {
        ...presenter,
        audio: { url: audio, duration: 27 },
      }),
    OpenRouterError,
  );
});

test("null public Avatar duration metadata is not turned into an invented 30-second limit", async () => {
  mockCatalogAndCall(() => {
    throw new Error("No paid call is allowed.");
  });
  assert.equal((await modelCapabilities()).presenter.supported_durations, null);
  assert.equal(
    (await modelCapabilities()).presenter.durationLimitVerified,
    false,
  );
  for (const duration of [30, 80, 120])
    assert.equal(
      buildVideoRequest(env, { ...presenter, duration }).duration,
      duration,
    );
  assert.equal(
    buildVideoRequest(
      { ...env, AHAB_AVATAR_MAX_SECONDS_VERIFIED: "0" },
      { ...presenter, duration: 120 },
    ).duration,
    120,
  );
});

test("scene mode uses one first frame and generated audio without unsupported references", () => {
  const body = buildVideoRequest(env, reference);
  assert.equal(body.model, MODELS.scene);
  assert.equal(body.resolution, "1080p");
  assert.equal(body.generate_audio, true);
  assert.deepEqual(body.frame_images, [
    { type: "image_url", frame_type: "first_frame", image_url: { url: image } },
  ]);
  assert.equal("input_references" in body, false);
});
test("scene and presenter input bounds reject unsupported references before spending", () => {
  for (const input of [
    { ...reference, duration: 31 },
    { ...reference, duration: 1 },
    { ...reference, images: [image, image] },
    { ...reference, video: { url: video, duration: 5 } },
    { ...reference, audio: { url: audio, duration: 15 } },
    { ...reference, captions: true },
    { ...presenter, duration: 122 },
    { ...presenter, images: [] },
    { ...presenter, voiceId: "unconfigured" },
    { ...presenter, images: ["https://other.example/photo.jpg"] },
    { ...presenter, images: ["https://ahab.example@other.example/photo.jpg"] },
    {
      ...presenter,
      voiceId: undefined,
      audio: { url: audio, duration: 30.01 },
    },
  ])
    assert.throws(() => buildVideoRequest(env, input), OpenRouterError);
  assert.equal(
    buildVideoRequest(env, { ...presenter, duration: 121 }).duration,
    121,
  );
});

test("voice labels come only from the server allowlist", () => {
  assert.equal(getAvatarVoices({})[0].id, "1bd001e7e50f421d891986aad5c8bbd2");
  assert.equal(getAvatarVoices({ AHAB_AVATAR_VOICES: "[]" }).length, 1);
  assert.deepEqual(
    getAvatarVoices({ AHAB_AVATAR_VOICES: '[{"id":"a","label":"A"}]' }),
    [{ id: "a", label: "A" }],
  );
  assert.deepEqual(getAvatarVoices({ AHAB_AVATAR_VOICES: "not JSON" }), []);
  assert.deepEqual(
    getAvatarVoices({
      AHAB_AVATAR_VOICES: '[{"id":"https://bad","label":"A"}]',
    }),
    [],
  );
});

test("a network failure after submission is uncertain and never automatically retried", async () => {
  let paidCalls = 0;
  mockCatalogAndCall(() => {
    paidCalls++;
    throw new Error(`Provider private ${audio}`);
  });
  await assert.rejects(
    submitVideo(env, reference),
    (error: unknown) =>
      error instanceof OpenRouterError &&
      error.submissionUncertain &&
      !error.message.includes("expiring-test-token"),
  );
  assert.equal(paidCalls, 1);
});

test("submit stores only the job identity and cost, never provider download links", async () => {
  mockCatalogAndCall((url, init) => {
    assert.equal(url, "https://openrouter.ai/api/v1/videos");
    assert.equal(init.redirect, "manual");
    assert.equal(
      new Headers(init.headers).get("authorization"),
      `Bearer ${env.OPENROUTER_API_KEY}`,
    );
    return Response.json(
      {
        id: "job-123",
        status: "pending",
        polling_url: "https://other.example/steal",
        urls: [audio],
        usage: { cost: "0.75" },
      },
      { status: 202 },
    );
  });
  assert.deepEqual(await submitVideo(env, reference), {
    id: "job-123",
    status: "pending",
    costUsd: 0.75,
  });
});

test("polling and downloads use fixed OpenRouter routes and sanitize provider errors", async () => {
  mockCatalogAndCall((url) => {
    assert.equal(url, "https://openrouter.ai/api/v1/videos/job-123");
    return Response.json({
      id: "job-123",
      status: "failed",
      error: `Private URL ${audio}`,
      usage: { cost: 0.1 },
    });
  });
  assert.deepEqual(await pollVideo(env, "job-123"), {
    id: "job-123",
    status: "failed",
    costUsd: 0.1,
    error: "The provider did not complete this generation.",
  });
  mock.restoreAll();
  mockCatalogAndCall((url, init) => {
    assert.equal(
      url,
      "https://openrouter.ai/api/v1/videos/job-123/content?index=0",
    );
    assert.equal(init.redirect, "manual");
    return new Response(new Uint8Array([0, 0, 0, 24]), {
      headers: { "content-type": "video/mp4" },
    });
  });
  assert.equal(
    (await downloadVideo(env, "job-123")).headers.get("content-type"),
    "video/mp4",
  );
  await assert.rejects(
    downloadVideo(env, "https://other.example"),
    OpenRouterError,
  );
});

test("portrait uses the dedicated image API with n=1, 1K and optional reference images", async () => {
  mockCatalogAndCall((url, init) => {
    assert.equal(url, "https://openrouter.ai/api/v1/images");
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, MODELS.portrait);
    assert.equal(body.resolution, "1K");
    assert.equal(body.n, 1);
    assert.deepEqual(body.input_references, [
      { type: "image_url", image_url: { url: image } },
    ]);
    return Response.json({
      data: [{ b64_json: btoa("image-bytes"), media_type: "image/png" }],
      usage: { cost: 0.008 },
    });
  });
  const output = await generatePortrait(env, {
    prompt: "A natural, fictional portrait.",
    imageUrls: [image],
  });
  assert.equal(output.mediaType, "image/png");
  assert.equal(output.costUsd, 0.008);
  assert.equal(new TextDecoder().decode(output.bytes), "image-bytes");
});

test("HTTP provider errors never expose their body and ambiguous 5xx is held for reconciliation", async () => {
  mockCatalogAndCall(() => new Response(`Secrets ${audio}`, { status: 503 }));
  await assert.rejects(
    submitVideo(env, reference),
    (error: unknown) =>
      error instanceof OpenRouterError &&
      error.submissionUncertain &&
      !error.message.includes("Secrets"),
  );
});

test("image adapters forward the catalog reference maximum and request one output", async () => {
  let calls = 0;
  mockCatalogAndCall((url, init) => {
    assert.equal(url, "https://openrouter.ai/api/v1/images");
    const body = JSON.parse(String(init.body));
    const edit = body.model === MODELS.image_edit;
    assert.equal(body.input_references.length, edit ? 14 : 10);
    assert.equal(body.n, 1);
    calls++;
    return Response.json({
      data: [{ b64_json: btoa("image"), media_type: "image/png" }],
    });
  });
  for (const [edit, max] of [
    [false, 10],
    [true, 14],
  ] as const) {
    const refs = Array.from({ length: max }, (_, i) => image + "&ref=" + i);
    await generatePortrait(env, {
      prompt: "Combine the supplied references.",
      imageUrls: refs,
      edit,
    });
    await assert.rejects(
      generatePortrait(env, {
        prompt: "Combine.",
        imageUrls: [...refs, image],
        edit,
      }),
      OpenRouterError,
    );
  }
  assert.equal(calls, 2);
});
