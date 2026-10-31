# Ahab

Ahab is a small AI-assisted video studio for founders, creators and businesses without a production team. It turns an approved brief, optional portrait/product preparation and a suitable reference into one downloadable vertical MP4. Customers choose the deliverable rather than navigating a model catalog. Review before spending, clear storage limits and reusable prepaid allowances keep the next step predictable.

## Purchase and create

Choose one of six formats, a selected duration, 720p or 1080p, available delivery and quantity. Add different configurations to one purchase. Anyone can review an exact server-calculated quote; sign in before checkout. Payment grants allowances without starting generation. Single and multiple purchases never expire and can be used separately. One video consumes one compatible allowance even when shorter; unused seconds are not a wallet. Allowances include one optional successful image operation and three writing preparations per video. Additional image operations can be purchased separately. Existing paid packages and receipts retain their allowances; no new legacy-package sales.

Formats: talking presenter, demo/tutorial, unboxing, scripted reaction, showcase/lifestyle, explainer. Explainers select presenter-led or scene-led delivery. Presenter uses Avatar IV; standard scenes use Wan 3.0. Express is implemented with Wan 3.0 Prime but unavailable until `EXPRESS_VERIFIED=true` confirms an actual speed benefit and supported inputs. Model names stay server-side. A higher price is not a promise of better visual quality.

## Duration policy

| Format               | Selected seconds | Generation target                                             |
| -------------------- | ---------------- | ------------------------------------------------------------- |
| Presenter            | 5–120            | Below 8 becomes 8; above 115 becomes 121; otherwise unchanged |
| Demo                 | 5–25             | Below 8 becomes 8; 25 becomes 29                              |
| Unboxing             | 5–25             | Below 7 becomes 7; 25 becomes 29                              |
| Reaction             | 5–25             | Below 14 becomes 14; 25 becomes 29                            |
| Showcase             | 10–25            | Below 12 becomes 12                                           |
| Explainer, presenter | 5–100            | Below 12 becomes 12; 100 becomes 106                          |
| Explainer, scenes    | 5–30             | Below 12 becomes 12                                           |

These are Ahab bonuses, not provider duration restrictions. Customer-facing pages, carts, quotes, checkout and job summaries show only the selected length. Duration adjustments are internal passive bonuses and are never advertised. Speech timing can vary; actual downloaded MP4 metadata is inspected and stored. Public Avatar metadata publishes no maximum. The adapter accepts Ahab's 121-second target, without claiming an end-to-end long-duration provider test. Both scene models list 2–30 seconds and 720p/1080p.

## Pricing

USD rates: presenter $0.0959/s single and $0.095/s multiple; scene $0.2729/$0.272; Express $0.3709/$0.370. Two or more video allowances selected at up to 30 seconds qualify for multiple rates; longer items do not. Charge selected time, including bonus time without a separate charge. Normal amounts round to cents; Express 30 seconds has an explicit $11 unit-price override for either quantity. Quotes also enforce the agreed complete-cost minimum: planned native video plus optional image/text/media headroom, 5.5% provider funding assumption, the merchant-supplied 2.9% + $0.30 payment assumption and $0.81 contribution per video. These are planning inputs, not measured universal fees. Minimums are calculated using 1080p cost for either resolution to keep retail prices equal. Current regular catalog cost inputs are presenter $0.05/s, scene $0.20/s at 1080p and $0.10/s at 720p, Express $0.28/$0.14. Recheck before changing prices. No extra render fee. Each video includes one optional image preparation and three writing preparations; standalone image purchases are not offered. Existing purchased image entitlements remain recorded.

## Creative preparation

All AI calls use OpenRouter. GLM 5.3 Flash supports keep exact dialogue, polish, or draft from supplied facts, using a shared instruction and format context. Exact dialogue is preserved in code. The user approves the final script and references. No invented testimonials, measured benefits or spontaneous customer experience.

Use a suitable authorized portrait directly. Optional image generation or single-reference editing uses FLUX 3 Image Klein; combining 2–14 references uses Seedream 5.0 Flash. OpenRouter API catalog checked 2026-10-31: Klein accepts up to 10 references, Flash up to 14, and both have n=1 maximum. Ahab routes multiple references to Flash and allows up to 14 preparation inputs for every task. Generate at 1K, retain the original, and prepare a 540×960 master in the browser using canvas before uploading it as an ordinary private image. If that browser preparation fails, the original remains available; the UI reports the failure and requests manual preparation. This is deterministic resizing, not another AI charge. Review the composition before video. Video receives at most one approved master image. Preparing an image uses the optional image preparation included in the selected video allowance, selected automatically. The generation-mode control is hidden unless multiple choices are available; Fast is a speed mode, not a quality guarantee.

Presenter speech uses a configured HeyGen voice or uploaded MP3/WAV, up to the selected generation target and a 121-second storage ceiling. Audio duration is checked from actual container/frame timing. No standalone voice model or music model.

Scene generation uses text and an optional first-frame image, with native generated audio. Audio/video-reference forwarding stays disabled because OpenRouter's generic modality list does not prove the provider honors those fields. Uploaded video remains available from existing libraries; unsupported inputs are rejected rather than ignored. No universal five-second claim is made about Wan's reference consumption.

A-roll/B-roll is a concise native shot brief for a single scene generation. It does not imply an external timeline editor. Avatar output remains a presenter video. No separate-track assembly, FFmpeg, music mixing, voice cloning or autonomous paid rerolls.

## Payments and recovery

One-time Stripe Checkout, inline `price_data`, USD and dynamic payment methods. USDC is eligible only if Stripe has enabled crypto for the merchant/customer; `USDC_ENABLED=false` excludes crypto. Webhook: `/api/webhooks/stripe`. Verify signature, ownership, session, currency, total and paid status. Handle completed, asynchronous success/failure and expired events idempotently. Reconcile pending sessions after their 30-minute expiry; failed/cancelled unpaid checkouts never block new purchases. Browser return pages do not grant allowances. No voluntary cash refunds; technical failures restore the affected allowance once, subject to mandatory rights.

Generation and preparation request keys prevent duplicate paid submissions. Reserve video/image allowance atomically in D1. A queued job survives dispatch failure. Unknown provider acceptance is held for reconciliation without blind resubmission. A successful image remains available if video fails. The existing cost ledger records estimated/actual cost without requiring manually funded D1 balances.

## Accounts and media

Username/password with Worker-compatible PBKDF2, optional hashed eight-character recovery passcode, signed JWT authorization and secure HttpOnly SameSite=Lax cookies lasting 270 days. Every page is session aware; signed-in users are redirected away from sign-in/signup/recovery. Secrets remain deployed Worker secrets and are never returned to clients. Do not read or publish credential files.

Private R2 with ownership checks, range responses and expiring provider grants. FIFO: 80 manually entered prompts in D1, 40 images, 20 audio files, 10 videos and 23 generated videos. Generated videos also expire after 121 days. Keep processing copies until the job reaches a terminal state. Deletion outbox retries failed storage deletes. Deleting output does not delete receipts or unused allowances.

## Development and release

Node 22.23.4+ or 24 and pnpm 10.34.5. Run `pnpm check`, `pnpm test`, `pnpm build`. Start local development with `astro dev --background`; stop using `astro dev stop`. Apply D1 migrations locally before UI testing, then apply compatible migration 0003 remotely before deploying the new Worker. Preserve the existing secrets and bindings. Authenticate with Wrangler before deployment. Do not publish `.dev.vars` fixtures.

Public APIs: `GET /api/config`; public `POST /api/quote-preview`; authenticated `POST /api/quotes`, `/api/checkout`, `/api/prepare`, `/api/generate`, `/api/portraits`; `GET /api/purchases`, `/api/library`, `/api/jobs/:id`; existing auth/media endpoints and Stripe webhook. Model IDs are internal adapter details.

Validation status: automated tests exercise real SQLite migrations, pricing, legacy/new fulfillment, concurrency, request idempotency, exact script preservation, media validation and navigation. Paid provider generation, real-card payment and USDC wallet transactions must not be inferred from those tests. Express remains off until verified.
