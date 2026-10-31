import type { AhabEnv, JobRow, AssetRow } from "./types";
import { HttpError, json, readJson, textValue } from "./http";
import { ownedAsset, savePrompt } from "./media";
import {
  buildVideoRequest,
  getAvatarVoices,
  OpenRouterError,
} from "./openrouter";
import { signJwt } from "./crypto";
import { readiness } from "./payments";
import {
  validateOffer,
  generatedDuration,
  compatible,
  type TaskType,
  type Service,
  type Resolution,
} from "./offers";
import { plannedCostCents, expressEnabled } from "./quotes";
export async function jobById(env: AhabEnv, id: string) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id=?")
    .bind(id)
    .first<JobRow>();
}
export function publicJob(j: JobRow) {
  return {
    id: j.id,
    kind: j.kind,
    mode: j.mode === "video_reference" ? "scene" : j.mode,
    taskType: j.task_type,
    selectedDuration: j.selected_duration,
    resolution: j.resolution,
    service: j.service,
    duration: j.selected_duration ?? j.duration,
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
    mode: (job.service || job.mode) as
      "presenter" | "scene" | "express" | "video_reference",
    resolution: (job.resolution || "1080p") as Resolution,
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
  const b = await readJson(request);
  const requestKey =
    typeof b.requestKey === "string" &&
    /^[a-zA-Z0-9_-]{12,100}$/.test(b.requestKey)
      ? b.requestKey
      : null;
  if (!requestKey)
    throw new HttpError(400, "Refresh the studio before generating.");
  const prior = await env.DB.prepare(
    "SELECT * FROM jobs WHERE user_id=? AND request_key=?",
  )
    .bind(userId, requestKey)
    .first<JobRow>();
  if (prior) return json({ job: publicJob(prior) }, 202);
  const prompt = textValue(
    b.prompt,
    kind === "portrait" ? 6000 : 2000,
    "Creative direction",
  );
  const allowance = await env.DB.prepare(
    "SELECT * FROM allowances WHERE id=? AND user_id=?",
  )
    .bind(typeof b.allowanceId === "string" ? b.allowanceId : "", userId)
    .first<any>();
  if (!allowance) throw new HttpError(400, "Choose an available allowance.");
  let mode = kind === "portrait" ? "portrait" : b.service;
  let duration = 0;
  let selected = 0;
  let task: TaskType = "presenter";
  let resolution: Resolution = "1080p";
  const assets: AssetRow[] = [];
  const input: any = { prompt, imageIds: [], edit: !!b.modify };
  if (kind === "video") {
    let choice;
    try {
      choice = validateOffer({ ...b, quantity: 1 }, expressEnabled(env));
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    if (choice.service === "image")
      throw new HttpError(400, "Choose a video format.");
    task = choice.taskType;
    mode = choice.service;
    selected = choice.duration;
    resolution = choice.resolution;
    duration = generatedDuration(task, selected, mode as Service);
    if (
      !compatible(
        {
          service: allowance.service,
          maxDuration: allowance.max_duration,
          generatedCapacity: allowance.generated_capacity,
          resolution: allowance.resolution,
          legacy: allowance.service === "legacy",
        },
        task,
        mode as Service,
        selected,
        resolution,
      )
    )
      throw new HttpError(
        400,
        "Choose an allowance that covers this format, duration and resolution.",
      );
    if (b.approved !== true)
      throw new HttpError(
        400,
        "Review and approve your script and references first.",
      );
  }
  if (
    !Array.isArray(b.imageIds) ||
    b.imageIds.length > (kind === "portrait" ? 2 : 1) ||
    b.imageIds.some((v: unknown) => typeof v !== "string") ||
    new Set(b.imageIds).size !== b.imageIds.length
  )
    throw new HttpError(
      400,
      "Choose one master reference image, or up to two images for preparation.",
    );
  for (const id of b.imageIds) {
    assets.push(await ownedAsset(env, id, userId, "image"));
    input.imageIds.push(id);
  }
  if (kind === "video") {
    if (mode === "presenter" && input.imageIds.length !== 1)
      throw new HttpError(400, "Choose an approved portrait first.");
    if (
      ["demo", "unboxing", "showcase"].includes(task) &&
      !input.imageIds.length
    )
      throw new HttpError(
        400,
        "Choose a product reference or an approved combined image.",
      );
    if (b.videoId)
      throw new HttpError(
        400,
        "Video-reference generation is not yet available for this service.",
      );
    if (b.audioId) {
      if (mode !== "presenter")
        throw new HttpError(
          400,
          "Uploaded narration is available for presenter videos.",
        );
      const a = await ownedAsset(env, String(b.audioId), userId, "audio");
      if (!a.duration || a.duration > duration)
        throw new HttpError(
          400,
          "Choose narration that fits your selected video length.",
        );
      assets.push(a);
      input.audioId = a.id;
      input.audioDuration = a.duration;
    }
    if (mode === "presenter") {
      input.script = input.audioId
        ? typeof b.script === "string"
          ? b.script.trim().slice(0, 12000)
          : ""
        : textValue(b.script, 12000, "Approved script");
      input.caption = !!b.caption;
      if (!input.audioId) {
        if (!getAvatarVoices(env).some((v) => v.id === b.voiceId))
          throw new HttpError(
            400,
            "Choose an available AI voice or upload narration.",
          );
        input.voiceId = b.voiceId;
      }
    } else {
      const script =
        typeof b.script === "string" ? b.script.trim().slice(0, 12000) : "";
      const shots = Array.isArray(b.shots)
        ? b.shots
            .filter((s: unknown) => typeof s === "string")
            .slice(0, 6)
            .map((s: string) => s.slice(0, 500))
        : [];
      input.prompt = `${prompt}\n${script ? "Approved dialogue: " + script + "." : "No spoken dialogue."} ${shots.length ? "Shot plan: " + shots.join(" Then ") : ""} Keep product details and character identity consistent. No background music. No invented product claims.`;
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
      mode: mode as any,
      duration,
      service: kind === "video" ? mode : undefined,
      resolution,
      selected_duration: selected,
      task_type: task,
      request_json: JSON.stringify(input),
      status: "queued",
      provider_id: null,
      asset_id: null,
      estimate_cents:
        kind === "portrait"
          ? 8
          : plannedCostCents(mode as Service, duration, resolution),
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
        mode: mode as "presenter" | "scene" | "express",
        resolution,
        prompt: input.script || input.prompt,
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
        "INSERT INTO jobs(id,user_id,allowance_id,kind,mode,duration,request_json,estimate_cents,created_at,updated_at,selected_duration,task_type,service,resolution,request_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
        selected,
        task,
        kind === "video" ? mode : null,
        resolution,
        requestKey,
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
    const duplicate = await env.DB.prepare(
      "SELECT * FROM jobs WHERE user_id=? AND request_key=?",
    )
      .bind(userId, requestKey)
      .first<JobRow>();
    if (duplicate) return json({ job: publicJob(duplicate) }, 202);
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
  if (typeof b.userPrompt === "string" && b.userPrompt.trim())
    await savePrompt(env, userId, b.userPrompt).catch(() => {});
  // A failed dispatch leaves a durable queued job. Scheduled reconciliation safely starts it.
  try {
    await env.GENERATION.create({ id, params: { jobId: id } });
  } catch {}
  return json({ job: publicJob((await jobById(env, id))!) }, 202);
}
