import type { AhabEnv, JobRow, AssetRow } from "./types";
import { HttpError, json, readJson, textValue } from "./http";
import { estimateCents, validateDuration } from "./policy";
import { ownedAsset, savePrompt } from "./media";
import {
  buildVideoRequest,
  getAvatarVoices,
  OpenRouterError,
} from "./openrouter";
import { signJwt } from "./crypto";
import { readiness } from "./payments";
export async function jobById(env: AhabEnv, id: string) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id=?")
    .bind(id)
    .first<JobRow>();
}
export function publicJob(j: JobRow) {
  return {
    id: j.id,
    kind: j.kind,
    mode: j.mode,
    duration: j.duration,
    status: j.status,
    assetId: j.asset_id,
    error: j.error,
    createdAt: j.created_at,
  };
}
export async function jobRequest(env: AhabEnv, job: JobRow) {
  const input = JSON.parse(job.request_json),
    rows = await env.DB.prepare("SELECT * FROM job_inputs WHERE job_id=?")
      .bind(job.id)
      .all<{ asset_id: string; kind: string }>();
  const urls = new Map<string, string>();
  for (const row of rows.results) {
    const grant = await signJwt(
      {
        sub: job.id,
        sid: row.asset_id,
        exp: Math.floor(Date.now() / 1000) + 6 * 3600,
        iss: "ahab",
        aud: "ahab",
      },
      env.AHAB_JWT_SECRET,
    );
    urls.set(
      row.asset_id,
      `${env.APP_URL}/api/provider/${job.id}/${row.asset_id}?grant=${grant}`,
    );
  }
  return {
    mode: job.mode as "presenter" | "video_reference",
    prompt: input.script || input.prompt,
    duration: job.duration,
    images: input.imageIds.map((id: string) => urls.get(id)),
    audio: input.audioId
      ? { url: urls.get(input.audioId)!, duration: input.audioDuration }
      : undefined,
    video: input.videoId
      ? { url: urls.get(input.videoId)!, duration: input.videoDuration }
      : undefined,
    voiceId: input.voiceId || undefined,
    captions: job.mode === "presenter" ? !!input.caption : undefined,
    motionPrompt: job.mode === "presenter" ? input.prompt : undefined,
  };
}
export async function createGeneration(
  request: Request,
  env: AhabEnv,
  userId: string,
  kind: "video" | "portrait",
) {
  if (!(await readiness(env)).generationEnabled)
    throw new HttpError(
      503,
      "Generation is temporarily unavailable. Your allowance has not changed.",
    );
  const b = await readJson(request),
    prompt = textValue(
      b.prompt,
      kind === "portrait" ? 6000 : 1000,
      "Creative direction",
    );
  const allowance = await env.DB.prepare(
    "SELECT * FROM allowances WHERE id=? AND user_id=?",
  )
    .bind(typeof b.allowanceId === "string" ? b.allowanceId : "", userId)
    .first<{ id: string; max_duration: number }>();
  if (!allowance) throw new HttpError(400, "Choose an available package.");
  const mode = kind === "portrait" ? "portrait" : b.mode;
  let duration = 0;
  const assets: AssetRow[] = [];
  const input: any = { prompt, imageIds: [] };
  if (kind === "video") {
    try {
      duration = validateDuration(mode, b.duration, allowance.max_duration);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    if (b.aspectRatio && b.aspectRatio !== "9:16")
      throw new HttpError(400, "Choose the vertical 9:16 format.");
    if (
      !Array.isArray(b.imageIds) ||
      b.imageIds.length > (mode === "presenter" ? 1 : 2) ||
      b.imageIds.some((v: unknown) => typeof v !== "string")
    )
      throw new HttpError(400, "Choose supported reference images.");
    if (mode === "presenter" && b.imageIds.length !== 1)
      throw new HttpError(400, "Choose one face image.");
    if (new Set(b.imageIds).size !== b.imageIds.length)
      throw new HttpError(400, "Choose each reference image once.");
    for (const id of b.imageIds) {
      assets.push(await ownedAsset(env, id, userId, "image"));
      input.imageIds.push(id);
    }
    if (b.audioId) {
      const a = await ownedAsset(env, String(b.audioId), userId, "audio");
      const cap = mode === "presenter" ? duration : 15;
      if (!a.duration || a.duration > cap)
        throw new HttpError(
          400,
          `The selected audio must be ${cap} seconds or shorter.`,
        );
      assets.push(a);
      input.audioId = a.id;
      input.audioDuration = a.duration;
    }
    if (mode === "video_reference") {
      if (!b.videoId) throw new HttpError(400, "Choose a video reference.");
      const a = await ownedAsset(env, String(b.videoId), userId, "video");
      if (!a.duration || a.duration > 5)
        throw new HttpError(
          400,
          "Video references must be 5 seconds or shorter.",
        );
      assets.push(a);
      input.videoId = a.id;
      input.videoDuration = a.duration;
      if (b.voiceId || b.caption)
        throw new HttpError(
          400,
          "Voice selection and captions are available for presenter videos.",
        );
    } else {
      if (b.videoId)
        throw new HttpError(
          400,
          "Choose video-reference mode to use a video input.",
        );
      input.script = textValue(b.script || b.prompt, 12000, "Approved script");
      input.caption = !!b.caption;
      if (!input.audioId) {
        if (!getAvatarVoices(env).some((v) => v.id === b.voiceId))
          throw new HttpError(
            400,
            "Choose an available AI voice or upload narration.",
          );
        input.voiceId = b.voiceId;
      }
    }
  }
  const id = crypto.randomUUID(),
    now = Date.now(),
    copies: string[] = [];
  try {
    for (const a of assets) {
      const object = await env.MEDIA.get(a.r2_key);
      if (!object)
        throw new HttpError(
          404,
          "A reference was removed. Please select it again.",
        );
      const key = `processing/${id}/${a.id}`;
      await env.MEDIA.put(key, object.body, {
        httpMetadata: { contentType: a.mime },
      });
      copies.push(key);
    }
    const job: JobRow = {
      id,
      user_id: userId,
      allowance_id: allowance.id,
      kind,
      mode,
      duration,
      request_json: JSON.stringify(input),
      status: "queued",
      provider_id: null,
      asset_id: null,
      estimate_cents: estimateCents(kind, mode, duration),
      actual_cents: null,
      released: 0,
      error: null,
      created_at: now,
      updated_at: now,
    };
    // Validate adapter settings before reserving money; all URLs here are private signed copies.
    if (kind === "video") {
      const fakeUrl = `${env.APP_URL}/api/provider/${id}/validation`;
      buildVideoRequest(env, {
        mode,
        prompt: input.script || prompt,
        duration,
        images: input.imageIds.map(() => fakeUrl),
        audio: input.audioId
          ? { url: fakeUrl, duration: input.audioDuration }
          : undefined,
        video: input.videoId
          ? { url: fakeUrl, duration: input.videoDuration }
          : undefined,
        voiceId: input.voiceId,
        captions: mode === "presenter" ? input.caption : undefined,
        motionPrompt: mode === "presenter" ? prompt : undefined,
      });
    }
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO jobs(id,user_id,allowance_id,kind,mode,duration,request_json,estimate_cents,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        id,
        userId,
        allowance.id,
        kind,
        mode,
        duration,
        job.request_json,
        job.estimate_cents,
        now,
        now,
      ),
      ...assets.map((a, i) =>
        env.DB.prepare("INSERT INTO job_inputs VALUES(?,?,?,?,?)").bind(
          id,
          a.id,
          copies[i],
          a.mime,
          a.kind,
        ),
      ),
    ]);
  } catch (e) {
    for (const key of copies) {
      try {
        await env.MEDIA.delete(key);
      } catch {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO deletion_outbox(r2_key,created_at) VALUES(?,?)",
        )
          .bind(key, now)
          .run();
      }
    }
    if (e instanceof HttpError) throw e;
    if (e instanceof OpenRouterError) throw new HttpError(e.status, e.message);
    if (String(e).includes("No generation allowance"))
      throw new HttpError(409, "That package has no remaining allowance.");
    if (String(e).includes("Generation is temporarily"))
      throw new HttpError(
        503,
        "Generation is temporarily unavailable. Your allowance has not changed.",
      );
    throw e;
  }
  await savePrompt(env, userId, prompt);
  // A failed dispatch leaves a durable queued job. Scheduled reconciliation safely starts it.
  try {
    await env.GENERATION.create({ id, params: { jobId: id } });
  } catch {}
  return json({ job: publicJob((await jobById(env, id))!) }, 202);
}
