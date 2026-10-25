/** OpenRouter's dedicated video and image APIs; no provider keys leave this module.
 * Contracts checked 2026-10-25 against the public catalogs and official cookbook.
 * https://openrouter.ai/docs/cookbook/video-generation/provider-specific-video-options
 * https://openrouter.ai/docs/guides/overview/multimodal/image-generation
 */
const API = "https://openrouter.ai/api/v1";
export const MODELS = {
  presenter: "heygen/avatar-iv",
  video_reference: "heygen/heygen-video-1",
  portrait: "black-forest-labs/flux-3-image-klein",
} as const;

export interface OpenRouterEnv {
  OPENROUTER_API_KEY?: string;
  APP_URL: string;
  /** Operator-verified HeyGen voice IDs; no invented catalog IDs. */
  AHAB_AVATAR_VOICES?: string;
  /** Largest output duration actually accepted in a controlled provider test. */
  AHAB_AVATAR_MAX_SECONDS_VERIFIED?: string;
}

export type VideoMode = "presenter" | "video_reference";
export type VideoStatus =
  "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "expired";
export type AvatarVoice = { id: string; label: string };
export type TimedReference = { url: string; duration: number };
export interface VideoRequest {
  mode: VideoMode;
  prompt: string;
  duration: number;
  images: string[];
  audio?: TimedReference;
  video?: TimedReference;
  voiceId?: string;
  captions?: boolean;
  motionPrompt?: string;
}
export interface VideoJob {
  id: string;
  status: VideoStatus;
  costUsd: number | null;
  generationId?: string;
  error?: string;
}

interface VideoMetadata {
  id: string;
  supported_durations: number[] | null;
  supported_resolutions: string[];
  supported_aspect_ratios: string[];
  allowed_passthrough_parameters: string[];
}
interface ImageMetadata {
  id: string;
  supported_parameters: Record<
    string,
    { type: string; values?: string[]; min?: number; max?: number }
  >;
}
export interface ModelCapabilities {
  presenter: VideoMetadata & { durationLimitVerified: false };
  video_reference: VideoMetadata;
  portrait: ImageMetadata;
}

export class OpenRouterError extends Error {
  readonly code: string;
  readonly status: number;
  readonly submissionUncertain: boolean;
  constructor(
    code: string,
    status: number,
    /** Unknown submissions must never be retried or have their allowance restored automatically. */
    submissionUncertain = false,
  ) {
    super(
      code === "submission_uncertain"
        ? "The provider may have accepted this request. It needs reconciliation before another submission."
        : errorMessage(code),
    );
    this.name = "OpenRouterError";
    this.code = code;
    this.status = status;
    this.submissionUncertain = submissionUncertain;
  }
}

function errorMessage(code: string): string {
  const messages: Record<string, string> = {
    provider_unfunded:
      "Generation is paused while provider funding is checked.",
    provider_unavailable: "The generation provider is temporarily unavailable.",
    provider_rejected: "The generation provider rejected this request.",
    invalid_response:
      "The generation provider returned an unexpected response.",
    invalid_request: "The requested generation settings are not supported.",
    missing_key: "Generation is not configured yet.",
    voice_unavailable: "Choose a configured AI voice or upload narration.",
    duration_unverified:
      "This presenter duration is awaiting provider verification.",
    capability_unavailable:
      "The selected model settings are not currently available.",
    invalid_reference: "A reference is invalid or is not served by Ahab.",
  };
  return messages[code] ?? "Generation could not be completed.";
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new OpenRouterError("invalid_response", 502);
  return value as Record<string, unknown>;
}

function cost(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function jobId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) {
    throw new OpenRouterError("invalid_response", 502);
  }
  return value;
}

function job(value: unknown): VideoJob {
  const data = record(value);
  const status = data.status;
  if (
    ![
      "pending",
      "in_progress",
      "completed",
      "failed",
      "cancelled",
      "expired",
    ].includes(status as string)
  ) {
    throw new OpenRouterError("invalid_response", 502);
  }
  const usage =
    data.usage && typeof data.usage === "object"
      ? (data.usage as Record<string, unknown>)
      : {};
  return {
    id: jobId(data.id),
    status: status as VideoStatus,
    costUsd: cost(usage.cost),
    ...(typeof data.generation_id === "string" &&
    /^[A-Za-z0-9_-]{1,200}$/.test(data.generation_id)
      ? { generationId: data.generation_id }
      : {}),
    ...(["failed", "cancelled", "expired"].includes(status as string)
      ? { error: "The provider did not complete this generation." }
      : {}),
  };
}

function headers(env: OpenRouterEnv): Headers {
  if (!env.OPENROUTER_API_KEY) throw new OpenRouterError("missing_key", 503);
  return new Headers({
    Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
    "HTTP-Referer": new URL(env.APP_URL).origin,
    "X-OpenRouter-Title": "Ahab",
  });
}

async function request(
  path: string,
  init: RequestInit,
  submitting = false,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(submitting ? 180_000 : 60_000),
    });
  } catch {
    throw new OpenRouterError(
      submitting ? "submission_uncertain" : "provider_unavailable",
      503,
      submitting,
    );
  }
  if (!response.ok) {
    // Never include provider bodies: errors can contain signed references or keys.
    await response.body?.cancel();
    const uncertain =
      submitting &&
      (response.status >= 500 ||
        response.status === 408 ||
        response.status === 499);
    throw new OpenRouterError(
      uncertain
        ? "submission_uncertain"
        : response.status === 402
          ? "provider_unfunded"
          : response.status === 429 || response.status >= 500
            ? "provider_unavailable"
            : "provider_rejected",
      response.status,
      uncertain,
    );
  }
  return response;
}

async function json(response: Response, submitting = false): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new OpenRouterError(
      submitting ? "submission_uncertain" : "invalid_response",
      502,
      submitting,
    );
  }
}

let catalogCache: { expires: number; value: ModelCapabilities } | undefined;
/** Public model discovery sends no credentials and caches only public metadata. */
export async function modelCapabilities(): Promise<ModelCapabilities> {
  if (catalogCache && catalogCache.expires > Date.now())
    return catalogCache.value;
  const [videos, images] = await Promise.all([
    request("/videos/models", { method: "GET" }).then((r) => json(r)),
    request("/images/models", { method: "GET" }).then((r) => json(r)),
  ]);
  const videoData = record(videos).data;
  const imageData = record(images).data;
  if (!Array.isArray(videoData) || !Array.isArray(imageData))
    throw new OpenRouterError("invalid_response", 502);
  const videoRows: unknown[] = videoData;
  function video(id: string): VideoMetadata {
    const m = record(videoRows.find((v) => record(v).id === id));
    if (
      !(
        m.supported_durations === null || Array.isArray(m.supported_durations)
      ) ||
      !Array.isArray(m.supported_resolutions) ||
      !Array.isArray(m.supported_aspect_ratios) ||
      !Array.isArray(m.allowed_passthrough_parameters)
    )
      throw new OpenRouterError("capability_unavailable", 503);
    return m as unknown as VideoMetadata;
  }
  const portrait = record(
    imageData.find((v) => record(v).id === MODELS.portrait),
  ) as unknown as ImageMetadata;
  if (
    !portrait.supported_parameters ||
    typeof portrait.supported_parameters !== "object"
  ) {
    throw new OpenRouterError("capability_unavailable", 503);
  }
  const value: ModelCapabilities = {
    presenter: { ...video(MODELS.presenter), durationLimitVerified: false },
    video_reference: video(MODELS.video_reference),
    portrait,
  };
  catalogCache = { expires: Date.now() + 5 * 60_000, value };
  return value;
}

export function getAvatarVoices(
  env: Pick<OpenRouterEnv, "AHAB_AVATAR_VOICES">,
): AvatarVoice[] {
  const defaults = [{id:"1bd001e7e50f421d891986aad5c8bbd2",label:"Sara · English"}];
  // HeyGen stock catalog: https://developers.heygen.com/docs/voices/overview
  if (!env.AHAB_AVATAR_VOICES || env.AHAB_AVATAR_VOICES.trim() === "[]") return defaults;
  try {
    const voices: unknown = JSON.parse(env.AHAB_AVATAR_VOICES);
    if (!Array.isArray(voices) || voices.length > 40) return [];
    return voices.flatMap((v) => {
      if (!v || typeof v !== "object") return [];
      const { id, label } = v as Record<string, unknown>;
      return typeof id === "string" &&
        /^[A-Za-z0-9_-]{1,128}$/.test(id) &&
        typeof label === "string" &&
        label.trim().length > 0 &&
        label.length <= 80
        ? [{ id, label: label.trim() }]
        : [];
    });
  } catch {
    return [];
  }
}

function referenceUrl(env: OpenRouterEnv, value: string): string {
  try {
    const url = new URL(value);
    const app = new URL(env.APP_URL);
    // Root supplies expiring Ahab URLs only; never forward a caller-selected destination.
    if (
      url.protocol !== "https:" ||
      url.origin !== app.origin ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new Error();
    }
    return url.toString();
  } catch {
    throw new OpenRouterError("invalid_reference", 400);
  }
}

function prompt(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 12_000)
    throw new OpenRouterError("invalid_request", 400);
  return value.trim();
}

type InputReference =
  | { type: "image_url"; image_url: { url: string } }
  | { type: "audio_url"; audio_url: { url: string } }
  | { type: "video_url"; video_url: { url: string } };

/** Build a previewable body; paid calls additionally check the latest public catalog. */
export function buildVideoRequest(
  env: OpenRouterEnv,
  input: VideoRequest,
): Record<string, unknown> {
  if (
    !["presenter", "video_reference"].includes(input.mode) ||
    !Number.isInteger(input.duration) ||
    !Array.isArray(input.images) ||
    input.images.some((image) => typeof image !== "string")
  ) {
    throw new OpenRouterError("invalid_request", 400);
  }
  const text = prompt(input.prompt);
  const refs: InputReference[] = input.images.map((image) => ({
    type: "image_url",
    image_url: { url: referenceUrl(env, image) },
  }));
  const parameters: Record<string, unknown> = {};
  if (input.mode === "presenter") {
    if (
      input.duration < 1 ||
      input.duration > 120 ||
      input.images.length !== 1 ||
      input.video
    ) {
      throw new OpenRouterError("invalid_request", 400);
    }
    if (input.audio) {
      if (
        !Number.isFinite(input.audio.duration) ||
        input.audio.duration <= 0 ||
        input.audio.duration > input.duration ||
        input.voiceId
      ) {
        throw new OpenRouterError("invalid_request", 400);
      }
    } else {
      if (!getAvatarVoices(env).some((voice) => voice.id === input.voiceId))
        throw new OpenRouterError("voice_unavailable", 503);
      parameters.voice_id = input.voiceId;
    }
    if (typeof input.captions === "boolean")
      parameters.caption = input.captions;
    if (input.motionPrompt) {
      if (input.motionPrompt.length > 1000)
        throw new OpenRouterError("invalid_request", 400);
      parameters.motion_prompt = input.motionPrompt;
    }
  } else {
    if (
      input.duration < 5 ||
      input.duration > 15 ||
      input.images.length > 2 ||
      !input.video ||
      input.voiceId ||
      input.captions ||
      input.motionPrompt
    ) {
      throw new OpenRouterError("invalid_request", 400);
    }
    if (
      !Number.isFinite(input.video.duration) ||
      input.video.duration <= 0 ||
      input.video.duration > 5
    ) {
      throw new OpenRouterError("invalid_request", 400);
    }
    refs.push({
      type: "video_url",
      video_url: { url: referenceUrl(env, input.video.url) },
    });
    if (
      input.audio &&
      (!Number.isFinite(input.audio.duration) ||
        input.audio.duration <= 0 ||
        input.audio.duration > 15)
    ) {
      throw new OpenRouterError("invalid_request", 400);
    }
  }
  if (input.audio)
    refs.push({
      type: "audio_url",
      audio_url: { url: referenceUrl(env, input.audio.url) },
    });
  return {
    model: MODELS[input.mode],
    prompt: text,
    duration: input.duration,
    resolution: input.mode === "presenter" ? "720p" : "768p",
    aspect_ratio: "9:16",
    input_references: refs,
    ...(Object.keys(parameters).length
      ? { provider: { options: { heygen: { parameters } } } }
      : {}),
  };
}

export async function submitVideo(
  env: OpenRouterEnv,
  input: VideoRequest,
): Promise<VideoJob> {
  const body = buildVideoRequest(env, input);
  const capabilities = await modelCapabilities();
  const m = capabilities[input.mode];
  if (
    !m.supported_resolutions.includes(body.resolution as string) ||
    !m.supported_aspect_ratios.includes("9:16") ||
    (m.supported_durations && !m.supported_durations.includes(input.duration))
  ) {
    throw new OpenRouterError("capability_unavailable", 503);
  }
  const provider = body.provider as
    | { options: { heygen: { parameters: Record<string, unknown> } } }
    | undefined;
  if (
    provider &&
    Object.keys(provider.options.heygen.parameters).some(
      (key) => !m.allowed_passthrough_parameters.includes(key),
    )
  ) {
    throw new OpenRouterError("capability_unavailable", 503);
  }
  const response = await request(
    "/videos",
    { method: "POST", headers: headers(env), body: JSON.stringify(body) },
    true,
  );
  try {
    return job(await json(response, true));
  } catch (error) {
    if (error instanceof OpenRouterError && error.submissionUncertain)
      throw error;
    throw new OpenRouterError("submission_uncertain", 502, true);
  }
}

export async function pollVideo(
  env: OpenRouterEnv,
  id: string,
): Promise<VideoJob> {
  const response = await request(`/videos/${jobId(id)}`, {
    method: "GET",
    headers: headers(env),
  });
  const result = job(await json(response));
  if (result.id !== id) throw new OpenRouterError("invalid_response", 502);
  return result;
}

/** Download through the fixed OpenRouter content endpoint, never a returned URL. */
export async function downloadVideo(
  env: OpenRouterEnv,
  id: string,
): Promise<Response> {
  const response = await request(`/videos/${jobId(id)}/content?index=0`, {
    method: "GET",
    headers: headers(env),
  });
  if (
    response.headers.get("content-type")?.split(";")[0].trim() !==
      "video/mp4" ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new OpenRouterError("invalid_response", 502);
  }
  return response;
}

export async function generatePortrait(
  env: OpenRouterEnv,
  input: { prompt: string; imageUrls?: string[] },
): Promise<{
  bytes: Uint8Array;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  costUsd: number | null;
}> {
  const text = prompt(input.prompt);
  const imageUrls = input.imageUrls ?? [];
  if (!Array.isArray(imageUrls) || imageUrls.length > 2)
    throw new OpenRouterError("invalid_request", 400);
  const references = imageUrls.map((url) => ({
    type: "image_url",
    image_url: { url: referenceUrl(env, url) },
  }));
  const m = (await modelCapabilities()).portrait.supported_parameters;
  if (
    !m.resolution?.values?.includes("768") ||
    !m.aspect_ratio?.values?.includes("9:16") ||
    (references.length > 0 &&
      (m.input_references?.max ?? 0) < references.length)
  ) {
    throw new OpenRouterError("capability_unavailable", 503);
  }
  const response = await request(
    "/images",
    {
      method: "POST",
      headers: headers(env),
      body: JSON.stringify({
        model: MODELS.portrait,
        prompt: text,
        resolution: "768",
        aspect_ratio: "9:16",
        n: 1,
        ...(references.length ? { input_references: references } : {}),
      }),
    },
    true,
  );
  try {
    const data = record(await json(response, true));
    if (!Array.isArray(data.data) || data.data.length !== 1) throw new Error();
    const output = record(data.data[0]);
    const type = output.media_type;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(type as string) ||
      typeof output.b64_json !== "string" ||
      output.b64_json.length > 14 * 1024 * 1024
    )
      throw new Error();
    const bytes = Uint8Array.from(atob(output.b64_json), (char) =>
      char.charCodeAt(0),
    );
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error();
    const usage =
      data.usage && typeof data.usage === "object"
        ? (data.usage as Record<string, unknown>)
        : {};
    return {
      bytes,
      mediaType: type as "image/png" | "image/jpeg" | "image/webp",
      costUsd: cost(usage.cost),
    };
  } catch {
    // A malformed successful response may still be billable; do not spend twice.
    throw new OpenRouterError("submission_uncertain", 502, true);
  }
}
