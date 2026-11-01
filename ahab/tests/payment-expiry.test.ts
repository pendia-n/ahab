import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { CHECKOUT_OPEN_MS, reconcilePurchases } from "../src/lib/payments";
import { fixture, seedUser } from "./helpers";

afterEach(() => mock.restoreAll());

for (const scenario of [
  "abandoned",
  "paid",
  "processing",
  "race",
  "unavailable",
] as const) {
  test(`nine-minute reconciliation handles ${scenario} checkout without inventing payment status`, async () => {
    const f = fixture();
    try {
      await seedUser(f.db);
      const now = Date.now();
      for (const [id, age, session] of [
        ["old", CHECKOUT_OPEN_MS + 1, "cs_old"],
        ["young", CHECKOUT_OPEN_MS - 60_000, "cs_young"],
        ["orphan", CHECKOUT_OPEN_MS + 1, null],
      ] as const) {
        await f.db
          .prepare(
            "INSERT INTO purchases(id,user_id,package_id,amount_cents,created_at,stripe_session_id) VALUES(?,?,?,?,?,?)",
          )
          .bind(id, "user-a", "cart", 3400, now - age, session)
          .run();
      }
      const base = {
        id: "cs_old",
        object: "checkout.session",
        amount_total: 3400,
        currency: "usd",
        client_reference_id: "user-a",
        metadata: { purchaseId: "old", userId: "user-a", packageId: "cart" },
      };
      let reads = 0,
        expires = 0;
      mock.method(globalThis, "fetch", async (url: any) => {
        assert.ok(String(url).includes("/checkout/sessions/cs_old"));
        if (scenario === "unavailable")
          return Response.json(
            {
              error: {
                message: "fixture unavailable",
                type: "invalid_request_error",
              },
            },
            { status: 400 },
          );
        if (String(url).endsWith("/expire")) {
          expires++;
          if (scenario === "race")
            return Response.json(
              {
                error: {
                  message: "already complete",
                  type: "invalid_request_error",
                },
              },
              { status: 400 },
            );
          return Response.json({
            ...base,
            status: "expired",
            payment_status: "unpaid",
          });
        }
        reads++;
        const paid = scenario === "paid" || (scenario === "race" && reads > 1);
        return Response.json({
          ...base,
          status: paid || scenario === "processing" ? "complete" : "open",
          payment_status: paid ? "paid" : "unpaid",
        });
      });
      await reconcilePurchases(
        { ...f.env, STRIPE_SECRET_KEY: "sk_test_fixture_only" },
        "user-a",
      );
      const expected = {
        abandoned: "expired",
        paid: "paid",
        processing: "processing",
        race: "paid",
        unavailable: "pending",
      }[scenario];
      assert.equal(
        f.db.row<any>("SELECT status FROM purchases WHERE id='old'")!.status,
        expected,
      );
      assert.equal(
        f.db.row<any>("SELECT status FROM purchases WHERE id='young'")!.status,
        "pending",
      );
      assert.equal(
        f.db.row<any>("SELECT status FROM purchases WHERE id='orphan'")!.status,
        "expired",
      );
      assert.equal(expires, ["abandoned", "race"].includes(scenario) ? 1 : 0);
      assert.equal(f.db.rows("SELECT * FROM allowances").length, 0);
    } finally {
      f.close();
    }
  });
}

test("purchase-history reconciliation cannot expire another user’s checkout", async () => {
  const f = fixture();
  try {
    await seedUser(f.db);
    await seedUser(f.db, "user-b", "CreatorB");
    await f.db
      .prepare(
        "INSERT INTO purchases(id,user_id,package_id,amount_cents,created_at,stripe_session_id) VALUES('other','user-b','cart',3400,?,'cs_other')",
      )
      .bind(Date.now() - CHECKOUT_OPEN_MS - 1)
      .run();
    mock.method(globalThis, "fetch", async () => {
      throw new Error("Must not call another user’s session");
    });
    await reconcilePurchases(
      { ...f.env, STRIPE_SECRET_KEY: "sk_test_fixture_only" },
      "user-a",
    );
    assert.equal(
      f.db.row<any>("SELECT status FROM purchases WHERE id='other'")!.status,
      "pending",
    );
  } finally {
    f.close();
  }
});
