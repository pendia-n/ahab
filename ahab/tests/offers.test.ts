import assert from "node:assert/strict";
import { test, mock, afterEach } from "node:test";
import {
  generatedDuration,
  compatible,
  validateOffer,
} from "../src/lib/offers";
import { makeQuote, publicQuote, roundPurchaseCents } from "../src/lib/quotes";
import { fulfillEvent, checkout } from "../src/lib/payments";
import { fixture, seedUser } from "./helpers";
afterEach(() => mock.restoreAll());
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
test("routing rejects incompatible modes and allows Plus without an operator gate", () => {
  for (const v of [
    item("presenter", 30, "scene"),
    item("demo", 15, "presenter"),
    item("explainer", 31, "scene"),
    item("showcase", 9, "scene"),
  ])
    assert.throws(() => validateOffer(v));
  assert.equal(
    validateOffer(item("demo", 15, "express"), true).service,
    "express",
  );
});
test("rates use selected time and the combined total is floored for every route", () => {
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
test("customer quotes expose selected length while keeping internal duration adjustments private", () => {
  const internal = makeQuote([item("demo", 25, "scene")]);
  const visible = publicQuote(internal);
  assert.equal(internal.items[0].generatedDuration, 29);
  assert.equal(visible.items[0].duration, 25);
  assert.equal("generatedDuration" in visible.items[0], false);
  assert.equal(visible.amountCents, internal.amountCents);
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
  assert.ok(makeQuote([item("presenter", 5)]).amountCents >= 100);
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

test("standalone image purchases are rejected because images are included with video", () => {
  assert.throws(
    () => makeQuote([{ service: "image", quantity: 1 }]),
    /included with each video/,
  );
});

test("Plus is available for tasks 2–5 and only scene-based short explainers", () => {
  for (const task of ["demo", "unboxing", "reaction", "showcase"]) {
    assert.equal(
      validateOffer({ ...item(task, 15, "express"), theme: "presenter" }, false)
        .service,
      "express",
    );
  }
  for (const theme of ["demo", "story", "features"]) {
    assert.equal(
      validateOffer({ ...item("explainer", 30, "express"), theme }, false)
        .service,
      "express",
    );
    assert.throws(() =>
      validateOffer({ ...item("explainer", 31, "express"), theme }),
    );
    assert.equal(
      validateOffer({ ...item("explainer", 31, "presenter"), theme }).service,
      "presenter",
    );
  }
  assert.throws(() =>
    validateOffer({ ...item("explainer", 15, "express"), theme: "presenter" }),
  );
});

test("whole-purchase rounding follows the merchant examples and preserves whole dollars", () => {
  for (const [subtotal, expected] of [
    [1590, 1500],
    [1320, 1300],
    [1500, 1500],
    [1599, 1500],
    [1600, 1600],
  ])
    assert.equal(roundPurchaseCents(subtotal), expected);
});
test("two videos are rounded together, never individually, and sub-cent rates are preserved", () => {
  const q = makeQuote([item("presenter", 83, "presenter", 2)]);
  assert.equal(q.amountCents, 1500);
  assert.equal(q.subtotalCents, 1592);
  assert.equal(q.items[0].quantity, 2);
  const split = makeQuote([item("presenter", 83), item("presenter", 83)]);
  assert.equal(split.amountCents, 1500);
  assert.equal(
    split.items.reduce((sum, i) => sum + i.lineAmountCents, 0),
    1500,
  );
  assert.equal(makeQuote([item("explainer", 100)]).amountCents, 900);
  assert.equal(
    makeQuote([
      item("showcase", 25, "scene", 2),
      { ...item("showcase", 25, "scene"), resolution: "720p" },
    ]).amountCents,
    2000,
  );
});
test("all model routes and mixed carts have one whole-dollar final total and matching receipt amounts", () => {
  for (const duration of [10, 15, 20, 25]) {
    const q = makeQuote([
      item("presenter", duration, "presenter", 3),
      item("showcase", duration, "scene", 2),
      item("showcase", duration, "express"),
    ]);
    assert.equal(q.amountCents % 100, 0);
    assert.equal(
      q.items.reduce((sum, i) => sum + i.lineAmountCents, 0),
      q.amountCents,
    );
    assert.ok(q.amountCents <= q.subtotalCents!);
    assert.ok(q.subtotalCents! - q.amountCents < 100);
  }
});
test("Stripe charges exactly the rounded cart total while fulfillment retains every purchased allowance", async () => {
  const f = fixture();
  try {
    await seedUser(f.db);
    const q = makeQuote([
      item("presenter", 83, "presenter", 2),
      item("demo", 25, "scene", 3),
    ]);
    await f.db
      .prepare(
        "INSERT INTO quotes(id,user_id,snapshot_json,amount_cents,expires_at,created_at) VALUES('rounded-quote','user-a',?,?,?,?)",
      )
      .bind(JSON.stringify(q), q.amountCents, q.expiresAt, Date.now())
      .run();
    let captured: URLSearchParams | undefined;
    mock.method(globalThis, "fetch", async (value: any, init: any) => {
      assert.ok(
        String(value).startsWith("https://api.stripe.com/v1/checkout/sessions"),
      );
      captured = new URLSearchParams(String(init.body));
      return Response.json({
        id: "cs_rounded_fixture",
        object: "checkout.session",
        url: "https://checkout.stripe.com/fixture",
        status: "open",
      });
    });
    const env = {
      ...f.env,
      CHECKOUT_ENABLED: "true",
      GENERATION_ENABLED: "true",
      OPENROUTER_API_KEY: "fixture",
      STRIPE_SECRET_KEY: "sk_test_fixture_only",
      STRIPE_WEBHOOK_SECRET: "fixture",
    };
    const response = await checkout(
      new Request("https://ahab.example/api/checkout", {
        method: "POST",
        body: JSON.stringify({ quoteId: "rounded-quote" }),
      }),
      env,
      "user-a",
    );
    assert.equal(response.status, 200);
    assert.ok(captured);
    let total = 0;
    q.items.forEach((i, index) => {
      assert.equal(captured!.get(`line_items[${index}][quantity]`), "1");
      const amount = Number(
        captured!.get(`line_items[${index}][price_data][unit_amount]`),
      );
      assert.equal(amount, i.lineAmountCents);
      total += amount;
    });
    assert.equal(total, q.amountCents);
    const parent = f.db.row<any>(
      "SELECT * FROM purchases WHERE parent_id IS NULL",
    )!;
    assert.equal(parent.amount_cents, total);
    const children = f.db.rows<any>(
      "SELECT * FROM purchases WHERE parent_id IS NOT NULL",
    );
    assert.equal(
      children.reduce((sum, p) => sum + p.amount_cents, 0),
      total,
    );
    assert.deepEqual(
      f.db
        .rows<any>("SELECT quantity FROM purchase_items ORDER BY rowid")
        .map((i) => i.quantity),
      [2, 3],
    );
    await fulfillEvent(env, {
      id: "evt_rounded_paid",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_rounded_fixture",
          currency: "usd",
          amount_total: total,
          client_reference_id: "user-a",
          metadata: {
            purchaseId: parent.id,
            userId: "user-a",
            packageId: "cart",
          },
          payment_status: "paid",
        },
      },
    });
    assert.equal(
      f.db
        .rows<any>("SELECT * FROM allowances")
        .reduce((sum, a) => sum + a.videos_remaining, 0),
      5,
    );
  } finally {
    f.close();
  }
});
