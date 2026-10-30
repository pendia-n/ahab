import {
  OFFER_VERSION,
  validateOffer,
  generatedDuration,
  RATES,
  type Quote,
  type Service,
} from "./offers";
import type { AhabEnv } from "./types";
import { HttpError, json, readJson } from "./http";
export function expressEnabled(env: Pick<AhabEnv, "EXPRESS_VERIFIED">) {
  return env.EXPRESS_VERIFIED === "true";
}
/** Complete planned first pass, including a portrait, text, funding and media headroom. */
export function plannedCostCents(
  service: Service,
  duration: number,
  resolution: string,
) {
  const perSecond =
    service === "presenter"
      ? 5
      : service === "express"
        ? resolution === "720p"
          ? 14
          : 28
        : resolution === "720p"
          ? 10
          : 20;
  return service === "image"
    ? 8
    : Math.ceil((duration * perSecond * 1055) / 1000) + 10;
}
export function makeQuote(
  raw: unknown,
  express = false,
  now = Date.now(),
): Quote {
  if (!Array.isArray(raw) || !raw.length || raw.length > 12)
    throw new Error("Add 1–12 configurations to your purchase.");
  const inputs = raw.map((v) => validateOffer(v, express));
  const count = inputs.reduce((s, v) => s + v.quantity, 0);
  if (count > 50) throw new Error("Buy up to 50 allowances at a time.");
  const eligible = inputs
    .filter((v) => v.service !== "image" && v.duration <= 30)
    .reduce((s, v) => s + v.quantity, 0);
  const items = inputs.map((v) => {
    const generated =
      v.service === "image"
        ? 0
        : generatedDuration(v.taskType, v.duration, v.service);
    const bulk = v.service !== "image" && v.duration <= 30 && eligible >= 2;
    const rates = v.service === "image" ? null : RATES[v.service];
    let base = rates
      ? Math.round((v.duration * rates[bulk ? "multiple" : "single"]) / 100)
      : 100;
    // This is an explicit merchant discount, not a generic whole-dollar rounding rule.
    if (v.service === "express" && v.duration === 30) base = 1100;
    const minimum = Math.ceil(
      ((plannedCostCents(v.service, generated, "1080p") + 81 + 30 / count) *
        10000) /
        9710,
    );
    const unit = Math.max(base, minimum);
    if (v.service === "express" && v.duration === 30 && unit !== 1100)
      throw new Error(
        "This discounted configuration is temporarily unavailable.",
      );
    return {
      ...v,
      generatedDuration: generated,
      unitAmountCents: unit,
      lineAmountCents: unit * v.quantity,
      minimumApplied: minimum > base,
      name:
        v.service === "image"
          ? "Image preparation"
          : `${v.service === "presenter" ? "Presenter" : v.service === "express" ? "Express scene" : "Scene"} · ${v.duration}s · ${v.resolution}`,
    };
  });
  return {
    version: OFFER_VERSION,
    items,
    amountCents: items.reduce((s, v) => s + v.lineAmountCents, 0),
    currency: "usd",
    expiresAt: now + 30 * 60000,
  };
}
export async function createQuote(
  request: Request,
  env: AhabEnv,
  userId: string,
) {
  const b = await readJson(request);
  let quote: Quote;
  try {
    quote = makeQuote(b.items, expressEnabled(env));
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO quotes(id,user_id,snapshot_json,amount_cents,expires_at,created_at) VALUES(?,?,?,?,?,?)",
  )
    .bind(
      id,
      userId,
      JSON.stringify(quote),
      quote.amountCents,
      quote.expiresAt,
      Date.now(),
    )
    .run();
  return json({ quoteId: id, ...quote }, 201);
}
