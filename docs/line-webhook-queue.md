# LINE webhook queue (fast acknowledgement)

## Why

LINE waits **2 seconds** for a webhook response ("Request timeout" in the LINE webhook error
statistics). The GAS intake (`doPost`, GAS-002) takes 2–6 seconds because it serialises every
intake behind `LockService.getScriptLock()` and writes to Sheets. Until 2026-10-18 the Worker
awaited GAS before answering LINE, so in the week of 2026-10-11 about 86% of
`prospect-line-webhook` invocations ended as `clientDisconnected` (LINE gave up at ~2 s).
GAS usually still processed the message, but LINE counted a failure, and a real GAS failure
had no reliable retry.

## Flow

1. `POST /line/<team>/<venue>`: verify `x-line-signature` (unchanged), then
   `LINE_WEBHOOK_QUEUE.send({ v: 1, route, body, receivedAt })` and return `200` immediately.
2. Queue consumer (`queue()` in `src/worker.js` → `consumeLineWebhookBatch_` in `src/index.js`):
   for each message, apply the existing early-receipt suppression and the optional A-team
   assistant mirror, then forward the original envelope to GAS with one attempt.
3. Success → `ack`. Network error, HTTP error or `{ ok: false }` from GAS → `retry` that
   message only, backoff 15 s, 30 s, 60 s … capped at 300 s.
4. After 100 attempts (about 8 hours) the message moves to `prospect-line-webhook-events-dlq`.

At-least-once delivery is safe: GAS skips events whose `webhookEventId` already exists in the
intake sheet. GAS does not use `replyToken`, so queue latency does not affect any reply.

## Configuration

| Item | Value |
|---|---|
| Producer binding | `LINE_WEBHOOK_QUEUE` → `prospect-line-webhook-events` |
| Consumer | batch 10, timeout 1 s, `max_concurrency` 1 (GAS is single-lock), `max_retries` 100 |
| Dead-letter queue | `prospect-line-webhook-events-dlq`, retention 14 days (Workers Paid; Free is fixed at 24 h) |
| Switch | `LINE_WEBHOOK_MODE` var: `queue` (default) or `sync` (original synchronous path) |

If the enqueue itself fails, or a body is larger than 120 KB, the request falls back to the
original synchronous forward, which answers `502` on GAS failure so LINE redelivery can apply.

## Operations

- Logs (Workers Logs): `line_webhook_forwarded` (with `queueMs`, `attempts`),
  `line_webhook_forward_retry`, `line_webhook_enqueue_failed`, `line_webhook_message_invalid`.
- Queue depth / DLQ: Cloudflare dashboard → Queues. Messages in the DLQ have no consumer;
  inspect them there before deciding whether to replay.
- The hourly GitHub health monitor also checks `GET /health/gas`, so a GAS outage that would
  make the queue retry produces a failed run (and an email) within an hour.

## Rollback

- Behaviour only: set `LINE_WEBHOOK_MODE` to `sync` in `wrangler.jsonc` and merge.
- Full: Cloudflare dashboard → Workers → `prospect-line-webhook` → Deployments → roll back.
  Messages already queued stay in the queue and are delivered once a version with the
  consumer is active again.
