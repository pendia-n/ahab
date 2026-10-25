import assert from "node:assert/strict";
import { afterEach, mock, test, type TestContext } from "node:test";
import {
  deleteOutbox,
  expireMedia,
  library,
  mediaResponse,
  ownedAsset,
  saveAsset,
  savePrompt,
} from "../src/lib/media";
import { fulfillEvent, checkoutParams } from "../src/lib/payments";
import { DAY, LIMITS, OUTPUT_DAYS, PACKAGES } from "../src/lib/policy";
import { HttpError } from "../src/lib/http";
import {
  fixture,
  seedAllowance,
  seedPurchase,
  seedUser,
  type TestDatabase,
} from "./helpers";

afterEach(() => mock.restoreAll());
function setup(t: TestContext) {
  const f = fixture();
  t.after(() => f.close());
  return f;
}
function count(
  db: TestDatabase,
  table: string,
  clause = "",
  ...values: (string | number)[]
) {
  return db.row<{ n: number }>(
    `SELECT count(*) AS n FROM ${table} ${clause}`,
    ...values,
  )!.n;
}
async function job(
  db: TestDatabase,
  id: string,
  kind = "video",
  estimate = 100,
  allowance = "purchase-a",
  userId = "user-a",
) {
  return db
    .prepare(
      "INSERT INTO jobs(id,user_id,allowance_id,kind,mode,duration,request_json,estimate_cents,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      id,
      userId,
      allowance,
      kind,
      kind === "video" ? "presenter" : "portrait",
      kind === "video" ? 30 : 0,
      "{}",
      estimate,
      Date.now(),
      Date.now(),
    )
    .run();
}
function allowance(db: TestDatabase, id = "purchase-a") {
  return db.row<{ videos_remaining: number; portraits_remaining: number }>(
    "SELECT videos_remaining,portraits_remaining FROM allowances WHERE id=?",
    id,
  )!;
}
function budget(db: TestDatabase) {
  return db.row<{
    reserved_cents: number;
    spent_cents: number;
    paused: number;
    consecutive_failures: number;
  }>("SELECT * FROM provider_budget WHERE id=1")!;
}
function paymentEvent(
  type: string,
  id: string,
  packageId = "starter",
  amount = 1100,
  paymentStatus = "paid",
) {
  return {
    id,
    type,
    data: {
      object: {
        id: "cs_fixture",
        client_reference_id: "user-a",
        currency: "usd",
        amount_total: amount,
        payment_status: paymentStatus,
        metadata: { purchaseId: "purchase-a", userId: "user-a", packageId },
      },
    },
  };
}

test("the 81st manual prompt evicts exactly the first prompt, per user, with stable insertion order", async (t) => {
  const { db, env } = setup(t);
  await seedUser(db);
  await seedUser(db, "user-b", "CreatorB");
  const first = await savePrompt(env, "user-a", "First saved manual prompt");
  for (let i = 1; i <= 80; i++)
    await savePrompt(env, "user-a", `Saved prompt ${i}`);
  await savePrompt(env, "user-b", "Other creator prompt");
  assert.equal(count(db, "prompts", "WHERE user_id=?", "user-a"), 80);
  assert.equal(
    db.row("SELECT id FROM prompts WHERE id=?", first.id),
    undefined,
  );
  assert.equal(
    db.row<{ text: string }>(
      "SELECT text FROM prompts WHERE user_id=? ORDER BY seq LIMIT 1",
      "user-a",
    )!.text,
    "Saved prompt 1",
  );
  assert.equal(count(db, "prompts", "WHERE user_id=?", "user-b"), 1);
  await library(env, "user-a");
  assert.equal(count(db, "prompts", "WHERE user_id=?", "user-a"), 80);
});

test("41st image, 21st audio, 11th input video and 24th output each evict their own oldest object", async (t) => {
  const { db, env, media } = setup(t);
  await seedUser(db);
  await seedUser(db, "user-b", "CreatorB");
  for (const kind of ["image", "audio", "video", "output"] as const) {
    for (let i = 0; i <= LIMITS[kind]; i++) {
      const id = `${kind}-${i}`;
      await media.put(id, "fixture-content");
      await saveAsset(env, {
        id,
        user_id: "user-a",
        kind,
        r2_key: id,
        name: id,
        mime:
          kind === "image"
            ? "image/png"
            : kind === "audio"
              ? "audio/mpeg"
              : "video/mp4",
        bytes: 15,
        duration: kind === "image" ? null : 5,
        width: null,
        height: null,
      });
    }
    assert.equal(
      count(db, "assets", "WHERE user_id=? AND kind=?", "user-a", kind),
      LIMITS[kind],
    );
    assert.equal(
      db.row("SELECT id FROM assets WHERE id=?", `${kind}-0`),
      undefined,
    );
    assert.equal(
      count(db, "deletion_outbox", "WHERE r2_key=?", `${kind}-0`),
      1,
    );
    assert.equal(
      db.row<{ id: string }>(
        "SELECT id FROM assets WHERE user_id=? AND kind=? ORDER BY seq LIMIT 1",
        "user-a",
        kind,
      )!.id,
      `${kind}-1`,
    );
  }
  await saveAsset(env, {
    id: "other-image",
    user_id: "user-b",
    kind: "image",
    r2_key: "other-image",
    name: "Other",
    mime: "image/png",
    bytes: 4,
    duration: null,
    width: null,
    height: null,
  });
  assert.equal(count(db, "assets", "WHERE user_id=?", "user-b"), 1);
  await deleteOutbox(env);
  assert.equal(count(db, "deletion_outbox"), 0);
  for (const kind of ["image", "audio", "video", "output"]) {
    assert.equal(media.objects.has(`${kind}-0`), false);
    assert.equal(media.objects.has(`${kind}-1`), true);
  }
});

test("R2 deletion failures stay in the outbox and retry without losing the saved asset", async (t) => {
  const { db, media, env } = setup(t);
  await seedUser(db);
  await saveAsset(env, {
    id: "delete-me",
    user_id: "user-a",
    kind: "image",
    r2_key: "delete-me",
    name: "Delete me",
    mime: "image/png",
    bytes: 2,
    duration: null,
    width: null,
    height: null,
  });
  await media.put("delete-me", "ok");
  media.failDelete.add("delete-me");
  await db.prepare("DELETE FROM assets WHERE id=?").bind("delete-me").run();
  await deleteOutbox(env);
  assert.equal(
    db.row<{ attempts: number }>(
      "SELECT attempts FROM deletion_outbox WHERE r2_key=?",
      "delete-me",
    )!.attempts,
    1,
  );
  assert.equal(media.objects.has("delete-me"), true);
  media.failDelete.clear();
  await deleteOutbox(env);
  assert.equal(count(db, "deletion_outbox"), 0);
  assert.equal(media.objects.has("delete-me"), false);
});

test("outputs become unreadable at exactly 121 days before scheduled cleanup physically deletes them", async (t) => {
  const { db, media, env } = setup(t);
  await seedUser(db);
  const start = Date.now();
  mock.method(Date, "now", () => start);
  await media.put("generated/output", "video");
  await saveAsset(env, {
    id: "output",
    user_id: "user-a",
    kind: "output",
    r2_key: "generated/output",
    name: "My take.mp4",
    mime: "video/mp4",
    bytes: 5,
    duration: 30,
    width: null,
    height: null,
  });
  const output = await ownedAsset(env, "output", "user-a");
  assert.equal(output.expires_at, start + OUTPUT_DAYS * DAY);
  mock.restoreAll();
  mock.method(Date, "now", () => start + 121 * DAY);
  await assert.rejects(
    ownedAsset(env, "output", "user-a"),
    (e: unknown) => e instanceof HttpError && e.status === 404,
  );
  await assert.rejects(
    mediaResponse(
      new Request("https://ahab.example/api/media/output"),
      env,
      output,
    ),
    (e: unknown) => e instanceof HttpError && e.status === 404,
  );
  const data = (await (await library(env, "user-a")).json()) as {
    assets: unknown[];
  };
  assert.equal(data.assets.length, 0);
  assert.equal(media.objects.has("generated/output"), true);
  await expireMedia(env);
  assert.equal(count(db, "assets"), 0);
  assert.equal(count(db, "deletion_outbox"), 0);
  assert.equal(media.objects.has("generated/output"), false);
});

test("private media refuses another user and supports bounded and suffix seeking ranges", async (t) => {
  const { db, media, env } = setup(t);
  await seedUser(db);
  await seedUser(db, "user-b", "CreatorB");
  await media.put("range-video", "0123456789");
  await saveAsset(env, {
    id: "range-video",
    user_id: "user-a",
    kind: "video",
    r2_key: "range-video",
    name: "Sample.mp4",
    mime: "video/mp4",
    bytes: 10,
    duration: 5,
    width: null,
    height: null,
  });
  await assert.rejects(
    ownedAsset(env, "range-video", "user-b"),
    (e: unknown) => e instanceof HttpError && e.status === 404,
  );
  const a = await ownedAsset(env, "range-video", "user-a");
  for (const [range, text, contentRange] of [
    ["bytes=2-5", "2345", "bytes 2-5/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
  ]) {
    const result = await mediaResponse(
      new Request("https://ahab.example/api/media/range-video", {
        headers: { Range: range },
      }),
      env,
      a,
    );
    assert.equal(result.status, 206);
    assert.equal(await result.text(), text);
    assert.equal(result.headers.get("content-range"), contentRange);
    assert.equal(result.headers.get("cache-control"), "private, no-store");
  }
  const bad = await mediaResponse(
    new Request("https://ahab.example/api/media/range-video", {
      headers: { Range: "bytes=100-" },
    }),
    env,
    a,
  );
  assert.equal(bad.status, 416);
});

test("paid Stripe webhook fulfillment grants each exact package once and ignores delayed failure after success", async (t) => {
  const { db, env } = setup(t);
  await seedUser(db);
  for (const pack of PACKAGES) {
    await seedPurchase(db, "user-a", pack.id);
    await fulfillEvent(
      env,
      paymentEvent(
        "checkout.session.completed",
        `evt-${pack.id}-unpaid`,
        pack.id,
        pack.priceCents,
        "unpaid",
      ),
    );
    assert.equal(count(db, "allowances"), 0);
    const event = paymentEvent(
      "checkout.session.async_payment_succeeded",
      `evt-${pack.id}-paid`,
      pack.id,
      pack.priceCents,
    );
    await fulfillEvent(env, event);
    await fulfillEvent(env, event);
    await fulfillEvent(
      env,
      paymentEvent(
        "checkout.session.completed",
        `evt-${pack.id}-duplicate-success`,
        pack.id,
        pack.priceCents,
      ),
    );
    await fulfillEvent(
      env,
      paymentEvent(
        "checkout.session.async_payment_failed",
        `evt-${pack.id}-late-failure`,
        pack.id,
        pack.priceCents,
        "unpaid",
      ),
    );
    const row = db.row<{
      videos_remaining: number;
      portraits_remaining: number;
      max_duration: number;
    }>("SELECT * FROM allowances WHERE id=?", "purchase-a")!;
    assert.equal(row.videos_remaining, pack.videos);
    assert.equal(row.portraits_remaining, pack.portraits);
    assert.equal(row.max_duration, pack.maxDuration);
    assert.equal(count(db, "allowances"), 1);
    assert.equal(
      db.row<{ status: string }>(
        "SELECT status FROM purchases WHERE id=?",
        "purchase-a",
      )!.status,
      "paid",
    );
    await db
      .prepare("DELETE FROM allowances WHERE id=?")
      .bind("purchase-a")
      .run();
    await db
      .prepare("DELETE FROM purchases WHERE id=?")
      .bind("purchase-a")
      .run();
  }
});

test("wrong Stripe price, currency, account or session cannot grant generation credit", async (t) => {
  const { db, env } = setup(t);
  await seedUser(db);
  await seedPurchase(db);
  for (const patch of [
    { amount_total: 1 },
    { currency: "eur" },
    { client_reference_id: "user-b" },
    {
      metadata: {
        purchaseId: "purchase-a",
        userId: "user-a",
        packageId: "campaign",
      },
    },
  ]) {
    const event = paymentEvent(
      "checkout.session.completed",
      crypto.randomUUID(),
    );
    Object.assign(event.data.object, patch);
    await assert.rejects(fulfillEvent(env, event), HttpError);
    assert.equal(count(db, "allowances"), 0);
  }
  await db
    .prepare("UPDATE purchases SET stripe_session_id=? WHERE id=?")
    .bind("cs_other", "purchase-a")
    .run();
  await assert.rejects(
    fulfillEvent(
      env,
      paymentEvent("checkout.session.completed", "evt-wrong-session"),
    ),
    HttpError,
  );
  assert.equal(count(db, "allowances"), 0);
});

test("Checkout uses server USD prices and dynamic payment methods without subscriptions", () => {
  for (const pack of PACKAGES) {
    const params = checkoutParams(
      "https://ahab.example",
      "purchase-a",
      "user-a",
      pack,
    );
    assert.equal(params.mode, "payment");
    const line = params.line_items![0];
    assert.equal(line.price_data!.unit_amount, pack.priceCents);
    assert.equal(line.price_data!.currency, "usd");
    assert.equal("payment_method_types" in params, false);
    assert.equal("subscription_data" in params, false);
  }
});

test("failed funding reservation rolls back the allowance and leaves no job", async (t) => {
  const { db } = setup(t);
  await seedUser(db);
  await seedAllowance(db, "user-a", "studio");
  await db
    .prepare("UPDATE provider_budget SET funded_cents=99 WHERE id=1")
    .run();
  await assert.rejects(
    job(db, "no-funding", "video", 100),
    /temporarily unavailable/,
  );
  assert.equal(allowance(db).videos_remaining, 3);
  assert.equal(count(db, "jobs"), 0);
  assert.equal(budget(db).reserved_cents, 0);
  await db
    .prepare("UPDATE provider_budget SET funded_cents=1000,paused=1 WHERE id=1")
    .run();
  await assert.rejects(
    job(db, "paused", "video", 100),
    /temporarily unavailable/,
  );
  assert.equal(allowance(db).videos_remaining, 3);
});

test("simultaneous generation attempts cannot overdraw package allowance or shared funding", async (t) => {
  const { db } = setup(t);
  await seedUser(db);
  await seedAllowance(db, "user-a", "studio");
  await db
    .prepare("UPDATE provider_budget SET funded_cents=350 WHERE id=1")
    .run();
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) => job(db, `attempt-${i}`, "video", 100)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal(count(db, "jobs"), 3);
  assert.equal(allowance(db).videos_remaining, 0);
  assert.equal(budget(db).reserved_cents, 300);
});

test("confirmed failure restores only its own allowance exactly once; successful portrait stays consumed", async (t) => {
  const { db } = setup(t);
  await seedUser(db);
  await seedAllowance(db);
  await db
    .prepare("UPDATE provider_budget SET funded_cents=1000 WHERE id=1")
    .run();
  await job(db, "portrait-a", "portrait", 5);
  await db
    .prepare("UPDATE jobs SET status='completed',actual_cents=1 WHERE id=?")
    .bind("portrait-a")
    .run();
  await job(db, "video-a", "video", 100);
  assert.deepEqual(allowance(db), {
    videos_remaining: 0,
    portraits_remaining: 0,
  });
  await db
    .prepare("UPDATE jobs SET status='failed',actual_cents=10 WHERE id=?")
    .bind("video-a")
    .run();
  await db
    .prepare("UPDATE jobs SET status='failed' WHERE id=?")
    .bind("video-a")
    .run();
  assert.deepEqual(allowance(db), {
    videos_remaining: 1,
    portraits_remaining: 0,
  });
  assert.equal(budget(db).reserved_cents, 0);
  assert.equal(budget(db).spent_cents, 11);
  assert.equal(
    db.row<{ released: number }>(
      "SELECT released FROM jobs WHERE id=?",
      "video-a",
    )!.released,
    1,
  );
});

test("completed jobs never restore allowances and a lost submission remains reserved for reconciliation", async (t) => {
  const { db } = setup(t);
  await seedUser(db);
  await seedAllowance(db, "user-a", "studio");
  await db
    .prepare("UPDATE provider_budget SET funded_cents=1000 WHERE id=1")
    .run();
  await job(db, "completed");
  await job(db, "uncertain");
  await db
    .prepare("UPDATE jobs SET status='completed',actual_cents=80 WHERE id=?")
    .bind("completed")
    .run();
  await db
    .prepare("UPDATE jobs SET status='uncertain' WHERE id=?")
    .bind("uncertain")
    .run();
  await db
    .prepare("UPDATE jobs SET status='failed' WHERE id=?")
    .bind("completed")
    .run();
  assert.equal(allowance(db).videos_remaining, 1);
  assert.equal(budget(db).spent_cents, 80);
  assert.equal(budget(db).reserved_cents, 100);
});

test("three confirmed provider failures pause further spending", async (t) => {
  const { db } = setup(t);
  await seedUser(db);
  await seedAllowance(db);
  await db
    .prepare("UPDATE provider_budget SET funded_cents=1000 WHERE id=1")
    .run();
  for (let i = 0; i < 3; i++) {
    await job(db, `failure-${i}`);
    await db
      .prepare("UPDATE jobs SET status='failed' WHERE id=?")
      .bind(`failure-${i}`)
      .run();
  }
  assert.equal(budget(db).paused, 1);
  assert.equal(budget(db).consecutive_failures, 3);
  await assert.rejects(
    job(db, "blocked-after-failures"),
    /temporarily unavailable/,
  );
  assert.equal(allowance(db).videos_remaining, 1);
});
