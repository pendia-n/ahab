import type { AhabEnv, AssetRow } from "./types";
import { HttpError, json, textValue, boundedBody } from "./http";
import { LIMITS, DAY, OUTPUT_DAYS } from "./policy";
import { validateMedia } from "./media-validation";
import { verifyJwt } from "./crypto";
export function publicAsset(a: AssetRow) {
  return {
    id: a.id,
    kind: a.kind,
    name: a.name,
    mime: a.mime,
    bytes: a.bytes,
    duration: a.duration,
    width: a.width,
    height: a.height,
    createdAt: a.created_at,
    expiresAt: a.expires_at,
    url: `/api/media/${a.id}`,
  };
}
export async function ownedAsset(
  env: AhabEnv,
  id: string,
  userId: string,
  kind?: string,
) {
  const a = await env.DB.prepare(
    "SELECT * FROM assets WHERE id=? AND user_id=? AND (expires_at IS NULL OR expires_at>?)",
  )
    .bind(id, userId, Date.now())
    .first<AssetRow>();
  if (!a || (kind && a.kind !== kind))
    throw new HttpError(404, "That saved file is no longer available.");
  return a;
}
export function assetStatement(
  env: AhabEnv,
  a: Omit<AssetRow, "created_at" | "expires_at">,
) {
  const now = Date.now(),
    expiry = a.kind === "output" ? now + OUTPUT_DAYS * DAY : null;
  return env.DB.prepare(
    "INSERT OR IGNORE INTO assets(id,user_id,kind,r2_key,name,mime,bytes,duration,width,height,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  ).bind(
    a.id,
    a.user_id,
    a.kind,
    a.r2_key,
    a.name,
    a.mime,
    a.bytes,
    a.duration,
    a.width,
    a.height,
    now,
    expiry,
  );
}
export async function saveAsset(
  env: AhabEnv,
  a: Omit<AssetRow, "created_at" | "expires_at">,
) {
  await assetStatement(env, a).run();
}
export async function deleteOutbox(env: AhabEnv, limit = 100) {
  const rows = await env.DB.prepare(
    "SELECT r2_key FROM deletion_outbox ORDER BY created_at LIMIT ?",
  )
    .bind(limit)
    .all<{ r2_key: string }>();
  for (const row of rows.results) {
    try {
      await env.MEDIA.delete(row.r2_key);
      await env.DB.prepare("DELETE FROM deletion_outbox WHERE r2_key=?")
        .bind(row.r2_key)
        .run();
    } catch {
      await env.DB.prepare(
        "UPDATE deletion_outbox SET attempts=attempts+1 WHERE r2_key=?",
      )
        .bind(row.r2_key)
        .run();
    }
  }
}
export async function expireMedia(env: AhabEnv) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM assets WHERE expires_at<=?").bind(now),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at<=?").bind(now),
    env.DB.prepare("DELETE FROM recovery_tickets WHERE expires_at<=?").bind(
      now,
    ),
    env.DB.prepare("DELETE FROM rate_limits WHERE expires_at<=?").bind(now),
    env.DB.prepare("DELETE FROM password_changes WHERE created_at<?").bind(
      now - DAY,
    ),
    env.DB.prepare(
      "UPDATE jobs SET request_json='{}' WHERE status='uncertain' AND created_at<?",
    ).bind(now - 2 * DAY),
    env.DB.prepare(
      "INSERT OR IGNORE INTO deletion_outbox(r2_key,created_at) SELECT i.r2_key,? FROM job_inputs i JOIN jobs j ON j.id=i.job_id WHERE j.status='uncertain' AND j.created_at<?",
    ).bind(now, now - 2 * DAY),
    env.DB.prepare(
      "DELETE FROM job_inputs WHERE job_id IN(SELECT id FROM jobs WHERE status='uncertain' AND created_at<?)",
    ).bind(now - 2 * DAY),
    env.DB.prepare(
      "INSERT OR IGNORE INTO deletion_outbox(r2_key,created_at) SELECT i.r2_key,? FROM job_inputs i JOIN jobs j ON j.id=i.job_id WHERE j.status IN ('completed','failed')",
    ).bind(now),
    env.DB.prepare(
      "DELETE FROM job_inputs WHERE job_id IN(SELECT id FROM jobs WHERE status IN ('completed','failed'))",
    ),
  ]);
  await deleteOutbox(env);
}
export async function upload(request: Request, env: AhabEnv, userId: string) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 17 * 1024 * 1024)
    throw new HttpError(413, "Choose a file smaller than 16 MB.");
  const bytes = await boundedBody(request, 17 * 1024 * 1024);
  const form = await new Response(bytes, {
      headers: { "Content-Type": request.headers.get("content-type") || "" },
    }).formData(),
    file = form.get("file"),
    kind = form.get("kind");
  if (
    !(file instanceof File) ||
    !["image", "audio", "video"].includes(String(kind))
  )
    throw new HttpError(400, "Choose a supported file.");
  if (file.size > 16 * 1024 * 1024)
    throw new HttpError(413, "Choose a file smaller than 16 MB.");
  let metadata;
  try {
    metadata = await validateMedia(file, kind as "image" | "audio" | "video");
  } catch (e) {
    throw new HttpError(
      400,
      e instanceof Error ? e.message : "That file could not be read.",
    );
  }
  const id = crypto.randomUUID(),
    key = `inputs/${userId}/${id}.${metadata.extension}`;
  await env.MEDIA.put(key, file.stream(), {
    httpMetadata: { contentType: metadata.mime },
  });
  try {
    await saveAsset(env, {
      id,
      user_id: userId,
      kind: kind as AssetRow["kind"],
      r2_key: key,
      name: file.name.slice(0, 160) || `Reference.${metadata.extension}`,
      mime: metadata.mime,
      bytes: file.size,
      duration: metadata.duration,
      width: metadata.width,
      height: metadata.height,
    });
  } catch (e) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO deletion_outbox(r2_key,created_at) VALUES(?,?)",
    )
      .bind(key, Date.now())
      .run();
    throw e;
  }
  await deleteOutbox(env);
  return json({ asset: publicAsset(await ownedAsset(env, id, userId)) }, 201);
}
export async function mediaResponse(
  request: Request,
  env: AhabEnv,
  a: { r2_key: string; mime: string; name: string; expires_at?: number | null },
) {
  if (a.expires_at && a.expires_at <= Date.now())
    throw new HttpError(404, "This video has expired.");
  const head = await env.MEDIA.head(a.r2_key);
  if (!head) throw new HttpError(404, "That file is no longer available.");
  const size = head.size,
    range = request.headers.get("range");
  let offset = 0,
    length = size,
    status = 200;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (!m[1] && !m[2]))
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    if (!m[1]) {
      length = Math.min(size, Number(m[2]));
      offset = size - length;
    } else {
      offset = Number(m[1]);
      const end = m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
      length = end - offset + 1;
    }
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset >= size ||
      length <= 0
    )
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    status = 206;
  }
  const headers: Record<string, string> = {
    "Content-Type": a.mime,
    "Content-Length": String(length),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `${new URL(request.url).searchParams.has("download") ? "attachment" : "inline"}; filename="${a.name.replace(/[^a-zA-Z0-9._ -]/g, "_")}"`,
  };
  if (status === 206)
    headers["Content-Range"] = `bytes ${offset}-${offset + length - 1}/${size}`;
  if (request.method === "HEAD") return new Response(null, { status, headers });
  const object = await env.MEDIA.get(
    a.r2_key,
    range ? { range: { offset, length } } : undefined,
  );
  if (!object) throw new HttpError(404, "That file is no longer available.");
  return new Response(object.body, { status, headers });
}
export async function providerMedia(
  request: Request,
  env: AhabEnv,
  jobId: string,
  assetId: string,
) {
  const token = new URL(request.url).searchParams.get("grant") || "",
    claims = await verifyJwt(token, env.AHAB_JWT_SECRET);
  if (!claims || claims.sub !== jobId || claims.sid !== assetId)
    throw new HttpError(404, "File not found.");
  const input = await env.DB.prepare(
    "SELECT i.r2_key,i.mime FROM job_inputs i JOIN jobs j ON j.id=i.job_id WHERE i.job_id=? AND i.asset_id=? AND j.status NOT IN ('failed','completed')",
  )
    .bind(jobId, assetId)
    .first<{ r2_key: string; mime: string }>();
  if (!input) throw new HttpError(404, "File not found.");
  return mediaResponse(request, env, { ...input, name: assetId });
}
export async function savePrompt(env: AhabEnv, userId: string, text: unknown) {
  const value = textValue(text, 12000, "Prompt"),
    id = crypto.randomUUID(),
    now = Date.now();
  await env.DB.prepare(
    "INSERT INTO prompts(id,user_id,text,created_at) VALUES(?,?,?,?)",
  )
    .bind(id, userId, value, now)
    .run();
  return { id, text: value, createdAt: now };
}
export async function library(env: AhabEnv, userId: string) {
  const [assets, prompts, jobs] = await Promise.all([
    env.DB.prepare(
      "SELECT * FROM assets WHERE user_id=? AND (expires_at IS NULL OR expires_at>?) ORDER BY seq DESC",
    )
      .bind(userId, Date.now())
      .all<AssetRow>(),
    env.DB.prepare(
      "SELECT id,text,created_at AS createdAt FROM prompts WHERE user_id=? ORDER BY seq DESC",
    )
      .bind(userId)
      .all(),
    env.DB.prepare(
      "SELECT id,kind,mode,status,duration,created_at AS createdAt,asset_id AS assetId,error FROM jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 50",
    )
      .bind(userId)
      .all(),
  ]);
  return json({
    assets: assets.results.map(publicAsset),
    prompts: prompts.results,
    jobs: jobs.results,
    limits: LIMITS,
  });
}
