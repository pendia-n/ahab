# Ahab

A personal AI video studio built with Astro, Cloudflare Workers, D1, R2, Workflows, Stripe and OpenRouter.

See [APP.md](APP.md) for setup, pricing, retention, launch switches and verification limits.

Use Node 22.23.4+ and pnpm 10.34.5. Run `pnpm install`, `pnpm check`, `pnpm test`, and `pnpm build`. Start development with `pnpm dev --background`.

## Task-based allowance update

The app now quotes six video formats with a selected duration, bonus generation target, resolution and quantity. Customers can buy mixed configurations and use each allowance later. Read [APP.md](APP.md) for current routing, rates, complete-cost minimums and the additive migration. Old fixed packages are preserved for existing paid customers but no longer sold. Express and scene audio/video references remain unavailable until their advertised behavior is verified. No paid render or live payment is claimed by the automated tests.
