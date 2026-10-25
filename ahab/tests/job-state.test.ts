import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { jobById, jobRequest } from "../src/lib/generation";
import { expireMedia, providerMedia, saveAsset } from "../src/lib/media";
import { verifyJwt } from "../src/lib/crypto";
import { fixture, seedAllowance, seedUser, type TestDatabase } from "./helpers";

function setup(t: TestContext) {
  const f = fixture();
  t.after(() => f.close());
  return f;
}
async function insertJob(
  db: TestDatabase,
  id = "job-a",
  payload = JSON.stringify({
    prompt: "Private creative direction",
    script: "Approved spoken script",
    imageIds: ["face-a"],
    voiceId: "configured-voice",
  }),
) {
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,allowance_id,kind,mode,duration,request_json,estimate_cents,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      id,
      "user-a",
      "purchase-a",
      "video",
      "presenter",
      30,
      payload,
      160,
      Date.now(),
      Date.now(),
    )
    .run();
}
async function prepareJob(t: TestContext) {
  const f = setup(t);
  await seedUser(f.db);
  await seedAllowance(f.db, "user-a", "studio");
  await f.db
    .prepare("UPDATE provider_budget SET funded_cents=2000 WHERE id=1")
    .run();
  return f;
}
async function claim(db: TestDatabase, id: string) {
  return db
    .prepare(
      "UPDATE jobs SET status='submitting',updated_at=? WHERE id=? AND status='queued' RETURNING id",
    )
    .bind(Date.now(), id)
    .first<{ id: string }>();
}

test("only one durable queued-job claim wins across simultaneous dispatch attempts", async (t) => {
  const { db, env } = await prepareJob(t);
  await insertJob(db);
  const claims = await Promise.all(
    Array.from({ length: 8 }, () => claim(db, "job-a")),
  );
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal((await jobById(env, "job-a"))!.status, "submitting");
  assert.equal(
    db.row<{ reserved_cents: number }>(
      "SELECT reserved_cents FROM provider_budget",
    )!.reserved_cents,
    160,
  );
  assert.equal(
    db.row<{ videos_remaining: number }>(
      "SELECT videos_remaining FROM allowances",
    )!.videos_remaining,
    2,
  );
});

test("a process restart after claim cannot claim again or reserve a second generation", async (t) => {
  const { db, env } = await prepareJob(t);
  await insertJob(db);
  await claim(db, "job-a");
  // The recovered process gets its entire state from D1 rather than a local job object.
  const restarted = await jobById({ ...env }, "job-a");
  assert.equal(restarted!.status, "submitting");
  assert.equal(restarted!.provider_id, null);
  assert.equal(await claim(db, restarted!.id), null);
  await db
    .prepare(
      "UPDATE jobs SET status='uncertain' WHERE id=? AND status='submitting'",
    )
    .bind("job-a")
    .run();
  assert.equal(await claim(db, "job-a"), null);
  assert.equal(
    db.row<{ reserved_cents: number }>(
      "SELECT reserved_cents FROM provider_budget",
    )!.reserved_cents,
    160,
  );
  assert.equal(
    db.row<{ videos_remaining: number }>(
      "SELECT videos_remaining FROM allowances",
    )!.videos_remaining,
    2,
  );
});

test("a saved provider identity survives restart and is used for polling without a new queued claim", async (t) => {
  const { db, env } = await prepareJob(t);
  await insertJob(db);
  await claim(db, "job-a");
  await db
    .prepare(
      "UPDATE jobs SET provider_id=?,status='in_progress',actual_cents=12 WHERE id=?",
    )
    .bind("provider-job-a", "job-a")
    .run();
  const restarted = await jobById({ ...env }, "job-a");
  assert.equal(restarted!.provider_id, "provider-job-a");
  assert.equal(restarted!.actual_cents, 12);
  assert.equal(await claim(db, "job-a"), null);
  assert.equal(db.row<{ n: number }>("SELECT count(*) AS n FROM jobs")!.n, 1);
});

test("active processing copies survive reference deletion and use short-lived signed provider grants", async (t) => {
  const { db, env, media } = await prepareJob(t);
  await insertJob(db);
  await media.put("inputs/original-face", "original-image");
  await media.put("processing/job-a/face-a", "protected-copy");
  await saveAsset(env, {
    id: "face-a",
    user_id: "user-a",
    kind: "image",
    r2_key: "inputs/original-face",
    name: "Face.png",
    mime: "image/png",
    bytes: 14,
    duration: null,
    width: 512,
    height: 512,
  });
  await db
    .prepare("INSERT INTO job_inputs VALUES(?,?,?,?,?)")
    .bind("job-a", "face-a", "processing/job-a/face-a", "image/png", "image")
    .run();
  await db.prepare("DELETE FROM assets WHERE id=?").bind("face-a").run();
  await expireMedia(env);
  assert.equal(media.objects.has("inputs/original-face"), false);
  assert.equal(media.objects.has("processing/job-a/face-a"), true);
  assert.equal(
    db.row<{ n: number }>("SELECT count(*) AS n FROM job_inputs")!.n,
    1,
  );
  const input = await jobRequest(env, (await jobById(env, "job-a"))!);
  assert.equal(input.prompt, "Approved spoken script");
  const url = new URL(input.images[0]);
  assert.equal(url.origin, "https://ahab.example");
  assert.equal(url.pathname, "/api/provider/job-a/face-a");
  const claims = await verifyJwt(
    url.searchParams.get("grant")!,
    env.AHAB_JWT_SECRET,
  );
  assert.equal(claims!.sub, "job-a");
  assert.equal(claims!.sid, "face-a");
  assert.ok(claims!.exp - Date.now() / 1000 <= 6 * 3600);
  assert.equal(
    await (
      await providerMedia(new Request(url), env, "job-a", "face-a")
    ).text(),
    "protected-copy",
  );
  await assert.rejects(
    providerMedia(new Request(url), env, "other-job", "face-a"),
  );
});

test("completion and confirmed failure purge raw payloads and enqueue only their processing copies for deletion", async (t) => {
  const { db, env, media } = await prepareJob(t);
  for (const [id, terminal] of [
    ["completed-job", "completed"],
    ["failed-job", "failed"],
  ]) {
    await insertJob(db, id);
    const key = `processing/${id}/face-a`;
    await media.put(key, "processing-copy");
    await db
      .prepare("INSERT INTO job_inputs VALUES(?,?,?,?,?)")
      .bind(id, "face-a", key, "image/png", "image")
      .run();
    await db
      .prepare("UPDATE jobs SET status=?,actual_cents=12 WHERE id=?")
      .bind(terminal, id)
      .run();
    const ended = await jobById(env, id);
    assert.equal(ended!.request_json, "{}");
    assert.equal(
      db.row<{ n: number }>(
        "SELECT count(*) AS n FROM job_inputs WHERE job_id=?",
        id,
      )!.n,
      0,
    );
    assert.equal(
      db.row<{ n: number }>(
        "SELECT count(*) AS n FROM deletion_outbox WHERE r2_key=?",
        key,
      )!.n,
      1,
    );
    assert.equal(media.objects.has(key), true);
  }
  await insertJob(db, "active-job");
  await media.put("processing/active-job/face-a", "active-copy");
  await db
    .prepare("INSERT INTO job_inputs VALUES(?,?,?,?,?)")
    .bind(
      "active-job",
      "face-a",
      "processing/active-job/face-a",
      "image/png",
      "image",
    )
    .run();
  await db
    .prepare("UPDATE jobs SET status='uncertain' WHERE id=?")
    .bind("active-job")
    .run();
  await expireMedia(env);
  assert.equal(media.objects.has("processing/completed-job/face-a"), false);
  assert.equal(media.objects.has("processing/failed-job/face-a"), false);
  assert.equal(media.objects.has("processing/active-job/face-a"), true);
  assert.notEqual((await jobById(env, "active-job"))!.request_json, "{}");
});

test("reconciliation without new usage preserves known cost and settles it exactly once", async (t) => {
  const { db, env } = await prepareJob(t);
  await insertJob(db);
  await claim(db, "job-a");
  await db
    .prepare(
      "UPDATE jobs SET provider_id=?,status='uncertain',actual_cents=47 WHERE id=?",
    )
    .bind("provider-job-a", "job-a")
    .run();
  await db
    .prepare(
      "UPDATE jobs SET status='in_progress',actual_cents=COALESCE(?,actual_cents) WHERE id=? AND status NOT IN ('completed','failed')",
    )
    .bind(null, "job-a")
    .run();
  assert.equal((await jobById(env, "job-a"))!.actual_cents, 47);
  await db
    .prepare(
      "UPDATE jobs SET status='completed' WHERE id=? AND status NOT IN ('completed','failed')",
    )
    .bind("job-a")
    .run();
  await db
    .prepare(
      "UPDATE jobs SET status='completed' WHERE id=? AND status NOT IN ('completed','failed')",
    )
    .bind("job-a")
    .run();
  assert.equal(
    db.row<{ spent_cents: number }>("SELECT spent_cents FROM provider_budget")!
      .spent_cents,
    47,
  );
  assert.equal(
    db.row<{ reserved_cents: number }>(
      "SELECT reserved_cents FROM provider_budget",
    )!.reserved_cents,
    0,
  );
  const ledger = db.row<{
    actual_cents: number;
    released: number;
    status: string;
  }>("SELECT * FROM cost_ledger WHERE job_id=?", "job-a")!;
  assert.equal(ledger.actual_cents, 47);
  assert.equal(ledger.released, 1);
  assert.equal(ledger.status, "completed");
  assert.equal((await jobById(env, "job-a"))!.request_json, "{}");
});
