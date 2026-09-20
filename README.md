# prospect-line-worker

Cloudflare Worker for the Prospect LINE webhook gateway, LIFF trial reservation form, and event/tournament application form.

## Production Worker

- Worker name: `prospect-line-webhook`
- Entry point: `src/worker.js` (reservation/activity core: `src/index.js`)
- Deploy: `npm run deploy`
- Dry run: `npm run check`

## Required Cloudflare bindings / secrets

Keep secrets in Cloudflare. Do not commit secret values to GitHub.

- `GAS_WEBHOOK_URL`
- `GAS_FORWARD_KEY`
- `LIFF_ID`
- `LINE_LOGIN_CHANNEL_ID`
- `LINE_SECRET_*` bindings used by the enabled venue routes

The current Worker source also supports the legacy `LINE_CHANNEL_SECRET` fallback for `a/saitama-shibakawa`.

## GitHub / Cloudflare deployment model

1. Make code changes on a branch.
2. Open a pull request.
3. Validate the Worker.
4. Merge to `main`.
5. Cloudflare Workers Builds deploys `main` automatically.

Do not move secret values into `wrangler.jsonc`, source code, or `.env` files committed to GitHub.

## Deployment status

GitHub-to-Cloudflare automatic deployment is enabled for the `main` branch.

## Reservation performance

See [persistent trial config](docs/persistent-trial-config.md) for the startup path, GAS change synchronization, measurement results and required activation sequence. Config has no TTL; the independently issued submission proof remains valid for 24 hours. The reservation outbox, identity validation and receipt flow remain as described in [submission redesign](docs/reservation-submit-redesign.md).

**Release prerequisite:** seed and validate the persistent configuration before switching production traffic. `main` deploys automatically; this change must not be merged with an empty config store or without the GAS synchronizer installed. No browser request falls back to Sheets to bootstrap an empty store.
