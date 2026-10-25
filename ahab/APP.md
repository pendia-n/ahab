# Ahab

A responsive Astro PWA on Cloudflare Workers. Customers create a talking presenter or a short reference-guided scene using OpenRouter. Stripe Checkout sells one-time allowances; D1 tracks accounts, purchases and durable jobs; private R2 stores media.

## Packages

| Package      | Price | Separate videos | Maximum presenter length per video | AI portraits |
| ------------ | ----: | --------------: | ---------------------------------: | -----------: |
| First take   |   $11 |               1 |                         30 seconds |            1 |
| Creator set  |   $22 |               3 |                         80 seconds |            3 |
| Campaign set |   $47 |               5 |                        120 seconds |            5 |

Allowances do not expire. Short-scene mode always produces one 5–15 second, 768p clip and consumes one video allowance. Presenter mode uses 720p vertical video. Speech timing is approximate. No subscriptions, stitching, standalone speech generation or voice cloning are implemented.

## Development

Use Node 22.23.4+ or 24, and pnpm 10.34.5 (pinned in package.json). `pnpm install`, `pnpm check`, `pnpm test`, then `pnpm build`. Astro's checker currently requires TypeScript 6; TypeScript 7 is not supported by this checker.

Start the development server with `pnpm dev --background`; manage it with `pnpm astro dev status`, `pnpm astro dev logs`, and `pnpm astro dev stop`. If the shell cannot write Wrangler's global registry/logs, point `WRANGLER_LOG_PATH`, `WRANGLER_REGISTRY_PATH` and `MINIFLARE_REGISTRY_PATH` at writable temporary locations. Never dump logs or environment files containing secrets.

Apply local migrations with `pnpm exec wrangler d1 migrations apply ahab-db --local`. Apply production migrations with `--remote` only after checking `pnpm exec wrangler whoami`. `pnpm deploy` builds and deploys the custom Worker including its Workflow and scheduled cleanup.

## Secrets and launch switches

The ignored `.env` holds `AHAB_JWT_SECRET`, `OPENROUTER_API_KEY`, `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. The signing key is generated locally with cryptographic randomness. Never commit, print or paste any of these values. `pnpm secrets:publish` sends populated values directly to Cloudflare with output suppressed; it reports secret names only. Empty provider values are omitted.

The production deployment uses the following nonsecret settings:

- `APP_URL`: the exact deployed public HTTPS origin, without a trailing slash.
- `AHAB_AVATAR_VOICES`: optional custom stock voice list, shaped `[{"id":"voice-id","label":"Voice name"}]`. When absent or `[]`, the app supplies Sara from HeyGen’s documented stock catalog. All generation still goes through OpenRouter.
- Presenter duration is governed by the purchased package (30, 80 or 120 seconds) and current provider metadata. The legacy `AHAB_AVATAR_MAX_SECONDS_VERIFIED` setting is ignored. These are Ahab package limits, not a claim that OpenRouter publishes an Avatar IV maximum.
- `GENERATION_ENABLED=true`: enables generation with the configured OpenRouter API key. OpenRouter handles credit availability and billing; there is no separate D1 funding requirement.
- `CHECKOUT_ENABLED=true`: requires the Stripe API and webhook secrets, plus enabled OpenRouter generation. No manual budget, voice list, or duration-verification switch blocks checkout.
- `USDC_ENABLED=true`: display USDC availability only after enabling and verifying eligible stablecoin payments in this US Stripe account. Checkout uses dynamic payment methods; no payment method type is forced.

D1 atomically reserves customer allowances and records estimated/actual costs. The legacy `provider_budget` table is retained as a cost ledger only; its funding and pause values do not gate purchases or generation. Confirmed provider failures restore the relevant allowance exactly once. OpenRouter credit limits are managed in OpenRouter. There is no automatic top-up.

Register the Stripe webhook URL `/api/webhooks/stripe` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, and `checkout.session.expired`. Use the signing secret for this exact destination. Only signed, matched USD payments with the exact server-side total grant allowances. A return URL never grants credit. No voluntary cash-refund endpoint is provided; mandatory rights remain applicable.

## Retention and privacy

All limits are per account, ordered by original save order with a stable sequence tie-breaker. Viewing or reusing a file does not refresh its position.

| Saved item                           | Limit | Age limit                              |
| ------------------------------------ | ----: | -------------------------------------- |
| Manually entered prompts             |    80 | Until FIFO eviction or manual deletion |
| Input images and generated portraits |    40 | Until FIFO eviction or manual deletion |
| Uploaded audio                       |    20 | Until FIFO eviction or manual deletion |
| Uploaded video references            |    10 | Until FIFO eviction or manual deletion |
| Generated video outputs              |    23 | 121 days, whichever limit occurs first |

Prompts are saved on explicit Save/Generate, not keystrokes. SQL triggers make FIFO eviction and allowance updates atomic. Evicted media is immediately removed from the readable library and entered in a deletion outbox; failed R2 deletes retry on subsequent writes and every 15 minutes. Expired videos are denied immediately, before physical cleanup. The private bucket has a 121-day lifecycle backstop on `outputs/` only.

Validated job references are copied to a temporary private processing prefix, so FIFO or manual deletion cannot break a job in progress. Terminal jobs delete processing references through the outbox and clear their raw request text rather than retaining a hidden prompt archive. Uncertain submissions hold allowance and budget until reconciled; they must never be resubmitted automatically. Stale uncertain payloads and processing copies are removed after 48 hours; provider IDs and financial metadata remain for reconciliation. OpenRouter/provider processing has its own retention rules; this app does not claim zero retention by external providers.

Upload validation inspects actual bytes and timing tables: JPG/PNG/WebP up to 10 MB; WAV/MP3 up to 16 MB and 120 seconds stored, with the purchased video duration enforced at generation; MP4/WebM video references up to 16 MB and 5 seconds; scene audio references up to 15 seconds. Browser checks are only convenience checks. Unsupported streaming/fragmented containers are rejected with a message. These parsers inspect containers and frame timing, not a full codec decode. References do not guarantee exact product handling, unboxing, reactions, narrator replacement or lip-sync in scene mode.

Private downloads verify ownership and support video byte ranges. Provider copies use signed six-hour URLs tied to a specific job/file. API responses and private pages are never stored in the service-worker cache. Only public static assets and the offline information screen are cached.

## Authentication

Usernames are case-insensitive and unique (3–24 letters, digits or underscores). Passwords are 7–18 characters containing a letter and digit. Web Crypto PBKDF2-HMAC-SHA-256 uses 100,000 iterations and a random salt per password/passcode. Optional recovery uses an eight-character lowercase alphanumeric passcode, separately hashed, a ten-minute single-use reset ticket and rate limits. Skipping recovery means signed-out recovery is unavailable.

Signed JWTs are kept in a Secure, HttpOnly, host-only SameSite=Lax cookie, with a 270-day absolute lifetime and D1 session revocation. The same token can authorize API clients with Bearer authentication; the browser never stores it in localStorage. Password reset/change revokes sessions and outstanding recovery tickets. Authenticated password changes are limited to four successful changes per rolling 24 hours. Browser writes require same-origin proof and a custom request header.

## Job recovery and verification status

Workflow callbacks claim queued submissions atomically before making a paid request. A restart after a lost submission cannot claim it again. Provider job IDs are saved durably; polling and downloads retry the same job. Ambiguous timeouts remain held for manual reconciliation. Queued jobs and jobs with provider IDs are revisited by scheduled reconciliation; it never creates a second paid submission for a claimed job. A job completes only after R2 storage and asset/job metadata commit together.

Unit/integration tests use real in-memory SQLite and mocked OpenRouter/Stripe events. Live money movement, real USDC checkout and paid OpenRouter generation require separate controlled acceptance tests and an explicit spending cap. A passing build or deployed health route does not establish those transactions work.

Official contracts: [OpenRouter video API](https://openrouter.ai/docs/guides/overview/multimodal/video-generation), [provider options](https://openrouter.ai/docs/cookbook/video-generation/provider-specific-video-options), [image API](https://openrouter.ai/docs/guides/overview/multimodal/image-generation), [Stripe stablecoins](https://docs.stripe.com/payments/stablecoin-payments), [Cloudflare Workflows](https://developers.cloudflare.com/workflows/).

## Release verification

Deployed at https://ahab.pendia-community.workers.dev. All 62 automated tests pass, Astro reports no diagnostics, and the production build succeeds. A real local browser verified signup, 270-day cookie flags, private image upload/ranges, prompt save/deletion, recovery, desktop/tablet/mobile layouts and offline behavior. Paid provider calls and real Stripe/USDC transactions have not been run. The manual funding and duration launch gates have been removed; configured production secrets and enabled switches now activate checkout and generation.
