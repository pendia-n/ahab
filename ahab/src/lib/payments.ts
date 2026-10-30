import Stripe from "stripe";
import type { AhabEnv } from "./types";
import { PACKAGES, packageById } from "./policy";
import { HttpError, json, readJson, boundedBody } from "./http";
import { getAvatarVoices } from "./openrouter";
import { TASKS, type Quote } from "./offers";
import { expressEnabled } from "./quotes";
function stripe(env: AhabEnv) {
  if (!env.STRIPE_SECRET_KEY)
    throw new HttpError(503, "Checkout is not available yet.");
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
    telemetry: false,
  });
}
export async function readiness(env: AhabEnv) {
  const generationEnabled =
    env.GENERATION_ENABLED === "true" && !!env.OPENROUTER_API_KEY;
  const voices = getAvatarVoices(env).map((v) => ({ id: v.id, name: v.label }));
  const checkoutEnabled =
    env.CHECKOUT_ENABLED === "true" &&
    !!env.STRIPE_SECRET_KEY &&
    !!env.STRIPE_WEBHOOK_SECRET &&
    generationEnabled;
  const generationReason =
    env.GENERATION_ENABLED !== "true"
      ? "Generation is currently turned off."
      : !env.OPENROUTER_API_KEY
        ? "The generation service is not configured."
        : undefined;
  const checkoutReason =
    env.CHECKOUT_ENABLED !== "true"
      ? "Purchases are currently turned off."
      : !env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET
        ? "Payment setup is incomplete."
        : generationReason;
  return {
    generationEnabled,
    checkoutEnabled,
    usdcEnabled: checkoutEnabled && env.USDC_ENABLED === "true",
    voices,
    maxPresenterDuration: 120,
    tasks: TASKS,
    expressEnabled: expressEnabled(env),
    sceneReferencesEnabled: false,
    reason: generationReason,
    checkoutReason,
  };
}
export async function purchases(env: AhabEnv, userId: string) {
  const [p, a, config] = await Promise.all([
    env.DB.prepare(
      "SELECT id,package_id AS packageId,amount_cents AS amountCents,status,created_at AS createdAt FROM purchases WHERE user_id=? AND parent_id IS NULL ORDER BY created_at DESC",
    )
      .bind(userId)
      .all<any>(),
    env.DB.prepare(
      "SELECT id,package_id AS packageId,videos_remaining AS videosRemaining,portraits_remaining AS portraitsRemaining,max_duration AS maxDuration,created_at AS createdAt,service,resolution,generated_capacity AS generatedCapacity,task_type AS taskType,snapshot_json AS snapshot FROM allowances WHERE user_id=? ORDER BY created_at DESC",
    )
      .bind(userId)
      .all<any>(),
    readiness(env),
  ]);
  return json({
    purchases: p.results.map((row) => ({
      ...row,
      name: packageById(row.packageId)?.name || "Video allowances",
    })),
    allowances: a.results.map((row) => ({
      ...row,
      name:
        packageById(row.packageId)?.name ||
        (row.snapshot ? JSON.parse(row.snapshot).name : "Video allowance"),
      remaining: row.videosRemaining,
      legacy: row.service === "legacy",
      snapshot: undefined,
    })),
    ...config,
  });
}
export function checkoutParams(
  appUrl: string,
  purchaseId: string,
  userId: string,
  pack: (typeof PACKAGES)[number],
): Stripe.Checkout.SessionCreateParams {
  return {
    mode: "payment",
    client_reference_id: userId,
    metadata: { purchaseId, userId, packageId: pack.id },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: pack.priceCents,
          product_data: {
            name: `Ahab · ${pack.name}`,
            description: `${pack.videos} separate videos, each up to ${pack.maxDuration}s, plus ${pack.portraits} AI portrait${pack.portraits > 1 ? "s" : ""}.`,
          },
        },
      },
    ],
    success_url: `${appUrl}/purchases?checkout=success`,
    cancel_url: `${appUrl}/purchases?checkout=cancelled`,
    custom_text: {
      submit: {
        message:
          "One-time purchase. No voluntary cash refunds. Confirmed generation failures restore the affected allowance. Mandatory consumer rights still apply.",
      },
    },
    expires_at: Math.floor(Date.now() / 1000) + 1800,
  };
}
export async function checkout(request: Request, env: AhabEnv, userId: string) {
  if (!(await readiness(env)).checkoutEnabled)
    throw new HttpError(
      503,
      "Checkout is being prepared. Please check back soon.",
    );
  const b = await readJson(request);
  const q = await env.DB.prepare(
    "SELECT * FROM quotes WHERE id=? AND user_id=? AND expires_at>?",
  )
    .bind(typeof b.quoteId === "string" ? b.quoteId : "", userId, Date.now())
    .first<{ id: string; snapshot_json: string; amount_cents: number }>();
  if (!q)
    throw new HttpError(400, "Review your purchase to get a current price.");
  const quote = JSON.parse(q.snapshot_json) as Quote;
  if (quote.items.some((i) => i.service === "express") && !expressEnabled(env))
    throw new HttpError(400, "Express is currently unavailable.");
  const existing = await env.DB.prepare(
    "SELECT id,stripe_session_id FROM purchases WHERE quote_id=?",
  )
    .bind(q.id)
    .first<{ id: string; stripe_session_id: string | null }>();
  if (existing?.stripe_session_id) {
    const session = await stripe(env).checkout.sessions.retrieve(
      existing.stripe_session_id,
    );
    if (session.status === "open" && session.url)
      return json({ url: session.url });
    throw new HttpError(409, "This checkout has ended. Review a new purchase.");
  }
  if (existing)
    throw new HttpError(
      409,
      "This purchase is being prepared. Please try again shortly.",
    );
  const id = crypto.randomUUID();
  const inserts = [
    env.DB.prepare(
      "INSERT INTO purchases(id,user_id,package_id,amount_cents,created_at,quote_id) VALUES(?,?,?,?,?,?)",
    ).bind(id, userId, "cart", quote.amountCents, Date.now(), q.id),
  ];
  for (const item of quote.items) {
    const child = crypto.randomUUID();
    inserts.push(
      env.DB.prepare(
        "INSERT INTO purchases(id,user_id,package_id,amount_cents,created_at,parent_id) VALUES(?,?,?,?,?,?)",
      ).bind(
        child,
        userId,
        "allowance_v2",
        item.lineAmountCents,
        Date.now(),
        id,
      ),
      env.DB.prepare("INSERT INTO purchase_items VALUES(?,?,?,?)").bind(
        child,
        id,
        JSON.stringify(item),
        item.quantity,
      ),
    );
  }
  await env.DB.batch(inserts);
  try {
    const session = await stripe(env).checkout.sessions.create(
      {
        mode: "payment",
        client_reference_id: userId,
        metadata: { purchaseId: id, userId, packageId: "cart" },
        line_items: quote.items.map((i) => ({
          quantity: i.quantity,
          price_data: {
            currency: "usd",
            unit_amount: i.unitAmountCents,
            product_data: {
              name: `Ahab · ${i.name}`,
              description:
                i.service === "image"
                  ? "One image preparation. Use whenever you are ready."
                  : `One separate generation. Selected ${i.duration}s; target ${i.generatedDuration}s. Includes one optional image preparation. No expiry.`,
            },
          },
        })),
        success_url: `${env.APP_URL}/purchases?checkout=success`,
        cancel_url: `${env.APP_URL}/purchases?checkout=cancelled`,
        expires_at: Math.floor(Date.now() / 1000) + 1800,
        custom_text: {
          submit: {
            message:
              "One-time purchase. Use allowances separately, whenever you are ready. No voluntary cash refunds; confirmed technical failures restore the affected allowance. Mandatory rights still apply.",
          },
        },
        ...(env.USDC_ENABLED === "true"
          ? {}
          : { excluded_payment_method_types: ["crypto"] }),
      },
      { idempotencyKey: `ahab-checkout-${id}` },
    );
    await env.DB.prepare("UPDATE purchases SET stripe_session_id=? WHERE id=?")
      .bind(session.id, id)
      .run();
    return json({ url: session.url });
  } catch {
    throw new HttpError(
      502,
      "Checkout could not be opened. No generation allowance has been charged.",
    );
  }
}
export async function fulfillEvent(
  env: AhabEnv,
  event: { id: string; type: string; data: { object: any } },
) {
  const allowed = [
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
    "checkout.session.expired",
  ];
  if (!allowed.includes(event.type)) return;
  const session = event.data.object,
    meta = session.metadata || {};
  const row = await env.DB.prepare("SELECT * FROM purchases WHERE id=?")
    .bind(meta.purchaseId || "")
    .first<{
      id: string;
      user_id: string;
      package_id: string;
      amount_cents: number;
      stripe_session_id: string | null;
    }>();
  if (
    !row ||
    session.client_reference_id !== row.user_id ||
    meta.userId !== row.user_id ||
    meta.packageId !== row.package_id ||
    (row.stripe_session_id && row.stripe_session_id !== session.id)
  )
    throw new HttpError(400, "Payment could not be matched.");
  if (session.currency !== "usd" || session.amount_total !== row.amount_cents)
    throw new HttpError(400, "Payment total could not be verified.");
  const paid =
    [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
    ].includes(event.type) && session.payment_status === "paid";
  const status = paid
    ? "paid"
    : event.type === "checkout.session.expired"
      ? "expired"
      : event.type === "checkout.session.async_payment_failed"
        ? "failed"
        : "pending";
  const statements = [
    env.DB.prepare("INSERT OR IGNORE INTO webhook_events VALUES(?,?,?)").bind(
      event.id,
      event.type,
      Date.now(),
    ),
    env.DB.prepare(
      "UPDATE purchases SET status=?,paid_at=CASE WHEN ?='paid' THEN ? ELSE paid_at END,stripe_session_id=COALESCE(stripe_session_id,?) WHERE id=? AND status!='paid'",
    ).bind(status, status, Date.now(), session.id, row.id),
  ];
  if (paid && row.package_id === "cart") {
    const items = await env.DB.prepare(
      "SELECT * FROM purchase_items WHERE purchase_id=?",
    )
      .bind(row.id)
      .all<{ id: string; snapshot_json: string; quantity: number }>();
    for (const child of items.results) {
      const item = JSON.parse(child.snapshot_json) as Quote["items"][number];
      statements.push(
        env.DB.prepare(
          "UPDATE purchases SET status='paid',paid_at=COALESCE(paid_at,?) WHERE id=? AND status!='paid'",
        ).bind(Date.now(), child.id),
        env.DB.prepare(
          "INSERT OR IGNORE INTO allowances(id,user_id,package_id,videos_remaining,portraits_remaining,max_duration,created_at,service,resolution,generated_capacity,task_type,policy_version,snapshot_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).bind(
          child.id,
          row.user_id,
          "allowance_v2",
          item.service === "image" ? 0 : child.quantity,
          child.quantity,
          item.duration,
          Date.now(),
          item.service,
          item.resolution,
          item.generatedDuration,
          item.taskType,
          1,
          child.snapshot_json,
        ),
      );
    }
  }
  await env.DB.batch(statements);
}
export async function reconcilePurchases(env: AhabEnv) {
  if (!env.STRIPE_SECRET_KEY) return;
  await env.DB.prepare(
    "UPDATE purchases SET status='expired' WHERE parent_id IS NULL AND status='pending' AND stripe_session_id IS NULL AND created_at<?",
  )
    .bind(Date.now() - 30 * 60000)
    .run();
  const rows = await env.DB.prepare(
    "SELECT id,stripe_session_id FROM purchases WHERE parent_id IS NULL AND status='pending' AND stripe_session_id IS NOT NULL AND created_at<? LIMIT 20",
  )
    .bind(Date.now() - 30 * 60000)
    .all<{ id: string; stripe_session_id: string }>();
  for (const row of rows.results) {
    try {
      const s = await stripe(env).checkout.sessions.retrieve(
        row.stripe_session_id,
      );
      if (s.payment_status === "paid" || s.status === "expired")
        await fulfillEvent(env, {
          id: `reconcile-${s.id}-${s.payment_status}`,
          type:
            s.payment_status === "paid"
              ? "checkout.session.completed"
              : "checkout.session.expired",
          data: { object: s },
        });
    } catch {}
  }
}
export async function webhook(request: Request, env: AhabEnv) {
  if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY)
    throw new HttpError(503, "Payment verification is not configured.");
  if (Number(request.headers.get("content-length") || 0) > 1024 * 1024)
    throw new HttpError(413, "Payload too large.");
  const body = new TextDecoder().decode(
    await boundedBody(request, 1024 * 1024),
  );
  let event: Stripe.Event;
  try {
    event = await stripe(env).webhooks.constructEventAsync(
      body,
      request.headers.get("Stripe-Signature") || "",
      env.STRIPE_WEBHOOK_SECRET,
      300,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    throw new HttpError(400, "Invalid payment signature.");
  }
  await fulfillEvent(env, event);
  return json({ received: true });
}
