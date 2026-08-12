# prospect-line-worker

Cloudflare Worker for the Prospect LINE webhook gateway, LIFF trial reservation form, and event/tournament application form.

## Production Worker

- Worker name: `prospect-line-webhook`
- Entry point: `src/index.js`
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
