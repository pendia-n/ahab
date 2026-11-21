import assert from "node:assert/strict";
import { test } from "node:test";
import Stripe from "stripe";
import { fulfillEvent, webhook } from "../src/lib/payments";
import { fixture, seedUser } from "./helpers";

const session = {
  id: "cs_owned", client_reference_id: "user-a", currency: "usd",
  amount_total: 3400, payment_status: "paid",
  metadata: { purchaseId: "owned", userId: "user-a", packageId: "cart" },
};
const eventFor = (object: any) => ({ id: "evt_ownership", type: "checkout.session.completed", data: { object } });

for (const app of [undefined, "ahab", "meida", "hitlam"]) {
  test(`purchase ownership handles ${app || "legacy untagged"} event`, async () => {
    const f = fixture();
    try {
      await seedUser(f.db);
      await f.db.prepare("INSERT INTO purchases(id,user_id,package_id,amount_cents,created_at,stripe_session_id) VALUES('owned','user-a','cart',3400,?,'cs_owned')").bind(Date.now()).run();
      await fulfillEvent(f.env, eventFor({ ...session, metadata: { ...session.metadata, ...(app ? { app } : {}) } }));
      assert.equal(f.db.row<any>("SELECT status FROM purchases WHERE id='owned'")!.status, !app || app === "ahab" ? "paid" : "pending");
      assert.equal(f.db.rows("SELECT * FROM webhook_events").length, !app || app === "ahab" ? 1 : 0);
    } finally { f.close(); }
  });
}

test("owned events still reject incorrect amounts and unmatched tagged purchases", async () => {
  const f = fixture();
  try {
    await seedUser(f.db);
    await f.db.prepare("INSERT INTO purchases(id,user_id,package_id,amount_cents,created_at,stripe_session_id) VALUES('owned','user-a','cart',3400,?,'cs_owned')").bind(Date.now()).run();
    await assert.rejects(fulfillEvent(f.env, eventFor({ ...session, amount_total: 1 })), /total could not be verified/);
    await assert.rejects(fulfillEvent(f.env, eventFor({ ...session, metadata: { ...session.metadata, app: "ahab", purchaseId: "missing" } })), /could not be matched/);
  } finally { f.close(); }
});

test("signed unrelated Checkout receives HTTP 200; invalid signature remains rejected", async () => {
  const f = fixture();
  try {
    const secret = "whsec_fixture_only";
    const env = { ...f.env, STRIPE_SECRET_KEY: "sk_test_fixture_only", STRIPE_WEBHOOK_SECRET: secret };
    const payload = JSON.stringify(eventFor({ ...session, metadata: {} }));
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    const request = (sig: string) => new Request("https://ahab.example/api/webhooks/stripe", { method: "POST", body: payload, headers: { "Stripe-Signature": sig } });
    assert.equal((await webhook(request(signature), env)).status, 200);
    await assert.rejects(webhook(request("invalid"), env), /Invalid payment signature/);
    assert.equal(f.db.rows("SELECT * FROM allowances").length, 0);
  } finally { f.close(); }
});
