import assert from "node:assert/strict";
import { test } from "node:test";
import {
  generatedDuration,
  compatible,
  validateOffer,
} from "../src/lib/offers";
import { makeQuote } from "../src/lib/quotes";
import { fulfillEvent, checkout } from "../src/lib/payments";
import { fixture, seedUser } from "./helpers";
const item = (
  taskType = "presenter",
  duration = 30,
  service = "presenter",
  quantity = 1,
) => ({ taskType, duration, service, quantity, resolution: "1080p" });
test("bonus rules belong to the product and preserve all requested boundaries", () => {
  for (const [task, selected, service, actual] of [
    ["presenter", 5, "presenter", 8],
    ["presenter", 7, "presenter", 8],
    ["presenter", 8, "presenter", 8],
    ["presenter", 115, "presenter", 115],
    ["presenter", 116, "presenter", 121],
    ["presenter", 120, "presenter", 121],
    ["demo", 5, "scene", 8],
    ["demo", 24, "scene", 24],
    ["demo", 25, "scene", 29],
    ["unboxing", 5, "scene", 7],
    ["reaction", 5, "scene", 14],
    ["reaction", 14, "scene", 14],
    ["showcase", 10, "scene", 12],
    ["showcase", 25, "scene", 25],
    ["explainer", 5, "presenter", 12],
    ["explainer", 99, "presenter", 99],
    ["explainer", 100, "presenter", 106],
    ["explainer", 30, "scene", 30],
  ] as const)
    assert.equal(generatedDuration(task, selected, service), actual);
});
test("routing rejects presenter scenes, unverified Express and overlong visual explainers", () => {
  for (const v of [
    item("presenter", 30, "scene"),
    item("demo", 15, "presenter"),
    item("demo", 15, "express"),
    item("explainer", 31, "scene"),
    item("showcase", 9, "scene"),
  ])
    assert.throws(() => validateOffer(v));
  assert.equal(
    validateOffer(item("demo", 15, "express"), true).service,
    "express",
  );
});
test("rates use selected time, bonuses are included and deliberate 30s Express discount is $11", () => {
  assert.equal(makeQuote([item()]).items[0].unitAmountCents, 289);
  assert.equal(
    makeQuote([item("demo", 25, "scene")]).items[0].unitAmountCents,
    755,
  );
  const q = makeQuote([item("explainer", 30, "express")], true);
  assert.equal(q.amountCents, 1100);
  assert.equal(
    makeQuote([item("explainer", 30, "express", 3)], true).amountCents,
    3300,
  );
  assert.equal(
    makeQuote([item("presenter", 120)]).items[0].generatedDuration,
    121,
  );
});
test("multiple purchases discount eligible short videos, with no all-at-once use condition", () => {
  assert.equal(
    makeQuote([item("presenter", 30, "presenter", 2)]).items[0].unitAmountCents,
    285,
  );
  assert.equal(
    makeQuote([item("presenter", 60, "presenter", 2)]).items[0].unitAmountCents,
    575,
  );
  const q = makeQuote([item("presenter", 15), item("demo", 15, "scene")]);
  assert.equal(q.items.length, 2);
  assert.ok(q.items[0].minimumApplied);
  assert.ok(makeQuote([item("presenter", 5)]).amountCents > 100);
});
test("compatibility checks actual bonus capacity and purchased resolution and service", () => {
  const a = {
    service: "scene",
    maxDuration: 10,
    generatedCapacity: 10,
    resolution: "1080p",
  };
  assert.equal(compatible(a, "demo", "scene", 10, "1080p"), true);
  assert.equal(compatible(a, "reaction", "scene", 5, "1080p"), false);
  assert.equal(compatible(a, "demo", "express", 10, "1080p"), false);
  assert.equal(compatible(a, "demo", "scene", 10, "720p"), false);
});
test("new mixed-cart fulfillment is paid-only, atomic and duplicate-safe without starting generation", async () => {
  const f = fixture();
  try {
    await seedUser(f.db);
    const q = makeQuote([
      item("presenter", 30, "presenter", 2),
      item("demo", 25, "scene"),
    ]);
    await f.db
      .prepare(
        "INSERT INTO purchases(id,user_id,package_id,amount_cents,created_at,stripe_session_id) VALUES('order','user-a','cart',?,?,'cs_order')",
      )
      .bind(q.amountCents, Date.now())
      .run();
    for (const [i, v] of q.items.entries()) {
      await f.db
        .prepare(
          "INSERT INTO purchases(id,user_id,package_id,amount_cents,created_at,parent_id) VALUES(?,'user-a','allowance_v2',?,?,'order')",
        )
        .bind("item-" + i, v.lineAmountCents, Date.now())
        .run();
      await f.db
        .prepare("INSERT INTO purchase_items VALUES(?,?,?,?)")
        .bind("item-" + i, "order", JSON.stringify(v), v.quantity)
        .run();
    }
    const event = {
      id: "evt_new",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_order",
          currency: "usd",
          amount_total: q.amountCents,
          client_reference_id: "user-a",
          metadata: {
            purchaseId: "order",
            userId: "user-a",
            packageId: "cart",
          },
          payment_status: "unpaid",
        },
      },
    };
    await fulfillEvent(f.env, event);
    assert.equal(f.db.rows("SELECT * FROM allowances").length, 0);
    event.data.object.payment_status = "paid";
    event.id = "evt_paid";
    await fulfillEvent(f.env, event);
    await fulfillEvent(f.env, event);
    const a = f.db.rows<any>("SELECT * FROM allowances ORDER BY id");
    assert.equal(a.length, 2);
    assert.equal(a[0].videos_remaining, 2);
    assert.equal(a[1].generated_capacity, 29);
    assert.equal(a[0].portraits_remaining, 2);
    assert.equal(f.db.rows("SELECT * FROM jobs").length, 0);
    await f.db
      .prepare(
        "INSERT INTO preparations(id,user_id,allowance_id,request_key,raw_text,status,created_at) VALUES('prep','user-a','item-0','request-first','raw','submitting',?)",
      )
      .bind(Date.now())
      .run();
    assert.equal(
      f.db.row<any>("SELECT text_used FROM allowances WHERE id='item-0'")!
        .text_used,
      1,
    );
  } finally {
    f.close();
  }
});
test("old packages cannot be purchased through the new checkout", async () => {
  const f = fixture();
  try {
    const env = {
      ...f.env,
      CHECKOUT_ENABLED: "true",
      GENERATION_ENABLED: "true",
      OPENROUTER_API_KEY: "fixture",
      STRIPE_SECRET_KEY: "fixture",
      STRIPE_WEBHOOK_SECRET: "fixture",
    };
    await assert.rejects(
      checkout(
        new Request("https://ahab.example/api/checkout", {
          method: "POST",
          body: JSON.stringify({ packageId: "starter" }),
        }),
        env,
        "user-a",
      ),
      /current price/,
    );
  } finally {
    f.close();
  }
});
