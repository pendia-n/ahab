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
export function expressEnabled(_env: Pick<AhabEnv, "EXPRESS_VERIFIED">) {
  return true;
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
/** Merchant policy: round the combined purchase down once to whole USD. */
export function roundPurchaseCents(subtotalCents: number) {
  return Math.floor(subtotalCents / 100) * 100;
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
    // Rates use 1/10000 USD. Keep sub-cent precision until the whole cart is priced.
    const baseSubcents = rates
      ? v.duration * rates[bulk ? "multiple" : "single"]
      : 10000;
    const minimum = Math.ceil(
      ((plannedCostCents(v.service, generated, "1080p") + 81 + 30 / count) *
        10000) /
        9710,
    );
    const unitSubcents = Math.max(baseSubcents, minimum * 100);
    const unit = Math.round(unitSubcents / 100);
    return {
      ...v,
      generatedDuration: generated,
      unitAmountCents: unit,
      lineAmountCents: unit * v.quantity,
      pricingSubcents: unitSubcents * v.quantity,
      minimumApplied: minimum * 100 > baseSubcents,
      name:
        v.service === "image"
          ? "Image preparation"
          : `${v.service === "presenter" ? "Presenter" : v.service === "express" ? "Plus scene" : "Scene"} · ${v.duration}s · ${v.resolution}`,
    };
  });
  const subtotalSubcents = items.reduce(
    (sum, item) => sum + item.pricingSubcents,
    0,
  );
  const amountCents = roundPurchaseCents(subtotalSubcents / 100);
  // Distribute the final charge across receipt rows in cents. Never floor individual rows.
  const allocations = items.map((item) =>
    Math.floor((item.pricingSubcents * amountCents) / subtotalSubcents),
  );
  let remaining = amountCents - allocations.reduce((sum, n) => sum + n, 0);
  const order = items
    .map((item, i) => ({
      i,
      remainder: (item.pricingSubcents * amountCents) % subtotalSubcents,
    }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (const { i } of order) {
    if (remaining <= 0) break;
    allocations[i]++;
    remaining--;
  }
  const subtotalCents = Math.round(subtotalSubcents / 100);
  return {
    version: OFFER_VERSION,
    items: items.map(({ pricingSubcents: _precision, ...item }, i) => ({
      ...item,
      lineAmountCents: allocations[i],
    })),
    subtotalCents,
    roundingDiscountCents: subtotalCents - amountCents,
    amountCents,
    currency: "usd",
    expiresAt: now + 30 * 60000,
  };
}
/** Duration adjustments remain internal; customers choose and see their requested length. */
export function publicQuote(quote: Quote) {
  return {
    ...quote,
    items: quote.items.map(
      ({ generatedDuration: _internalDuration, ...item }) => item,
    ),
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
  return json({ quoteId: id, ...publicQuote(quote) }, 201);
}
