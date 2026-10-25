import Stripe from "stripe";
import type { AhabEnv } from "./types";
import { PACKAGES, packageById } from "./policy";
import { HttpError, json, readJson, boundedBody } from "./http";
import { getAvatarVoices } from "./openrouter";
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
  const generationEnabled = env.GENERATION_ENABLED === "true" && !!env.OPENROUTER_API_KEY;
  const voices = getAvatarVoices(env).map(v => ({id:v.id,name:v.label}));
  const checkoutEnabled = env.CHECKOUT_ENABLED === "true" && !!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET && generationEnabled;
  const generationReason = env.GENERATION_ENABLED !== "true" ? "Generation is currently turned off." : !env.OPENROUTER_API_KEY ? "The generation service is not configured." : undefined;
  const checkoutReason = env.CHECKOUT_ENABLED !== "true" ? "Purchases are currently turned off." : !env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET ? "Payment setup is incomplete." : generationReason;
  return {generationEnabled,checkoutEnabled,usdcEnabled:checkoutEnabled && env.USDC_ENABLED === "true",voices,maxPresenterDuration:120,reason:generationReason,checkoutReason};
}
export async function purchases(env: AhabEnv, userId: string) {
  const [p, a, config] = await Promise.all([
    env.DB.prepare(
      "SELECT id,package_id AS packageId,amount_cents AS amountCents,status,created_at AS createdAt FROM purchases WHERE user_id=? ORDER BY created_at DESC",
    )
      .bind(userId)
      .all<any>(),
    env.DB.prepare(
      "SELECT id,package_id AS packageId,videos_remaining AS videosRemaining,portraits_remaining AS portraitsRemaining,max_duration AS maxDuration,created_at AS createdAt FROM allowances WHERE user_id=? ORDER BY created_at DESC",
    )
      .bind(userId)
      .all<any>(),
    readiness(env),
  ]);
  return json({
    purchases: p.results.map((row) => ({
      ...row,
      name: packageById(row.packageId)?.name,
    })),
    allowances: a.results.map((row) => ({
      ...row,
      name: packageById(row.packageId)?.name,
      remaining: row.videosRemaining,
    })),
    packages: PACKAGES,
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
  const b = await readJson(request),
    pack = packageById(b.packageId);
  if (!pack) throw new HttpError(400, "Choose a valid package.");
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO purchases(id,user_id,package_id,amount_cents,created_at) VALUES(?,?,?,?,?)",
  )
    .bind(id, userId, pack.id, pack.priceCents, Date.now())
    .run();
  try {
    const session = await stripe(env).checkout.sessions.create(
      checkoutParams(env.APP_URL, id, userId, pack),
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
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO webhook_events VALUES(?,?,?)").bind(
      event.id,
      event.type,
      Date.now(),
    ),
    env.DB.prepare(
      "UPDATE purchases SET status=?,paid_at=CASE WHEN ?='paid' THEN ? ELSE paid_at END,stripe_session_id=COALESCE(stripe_session_id,?) WHERE id=? AND status!='paid'",
    ).bind(status, status, Date.now(), session.id, row.id),
  ]);
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
