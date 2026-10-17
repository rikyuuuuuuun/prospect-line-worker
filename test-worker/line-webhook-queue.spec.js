import { env, exports } from 'cloudflare:workers';
import { createMessageBatch, createExecutionContext, getQueueResult, reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/worker.js';

const QUEUE = 'prospect-line-webhook-events';
const route = 'b/tsuruse';
const chat = { type: 'message', webhookEventId: '01SYNTHETIC', source: { userId: 'U' + '3'.repeat(32) },
  message: { type: 'text', text: 'synthetic chat' } };
let network;
beforeEach(() => { network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External traffic disabled')); });
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

async function signedRequest(events, secret = env.LINE_SECRET_B_TSURUSE) {
  const body = JSON.stringify({ destination: 'synthetic', events });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return { body, request: new Request('https://fixture.invalid/line/' + route,
    { method: 'POST', body, headers: { 'x-line-signature': btoa(String.fromCharCode(...bytes)) } }) };
}
function message(id, body, attempts = 1) { return { id, timestamp: new Date(), attempts, body }; }
async function consume(messages, inspect) {
  const batch = createMessageBatch(QUEUE, messages);
  if (inspect) inspect(batch);
  const ctx = createExecutionContext();
  await worker.queue(batch, env, ctx);
  return getQueueResult(batch, ctx);
}

it('acknowledges a verified webhook after enqueueing it, without waiting for GAS', async () => {
  const send = vi.spyOn(env.LINE_WEBHOOK_QUEUE, 'send').mockResolvedValue(undefined);
  const { body, request } = await signedRequest([chat]);
  const response = await exports.default.fetch(request);
  expect(response.status).toBe(200);
  expect(network).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toMatchObject({ v: 1, route, body });
});

it('rejects an invalid signature before anything is enqueued', async () => {
  const send = vi.spyOn(env.LINE_WEBHOOK_QUEUE, 'send').mockResolvedValue(undefined);
  const { request } = await signedRequest([chat], 'wrong-secret');
  expect((await exports.default.fetch(request)).status).toBe(401);
  expect(send).not.toHaveBeenCalled();
});

it('falls back to the synchronous GAS forward when the enqueue fails', async () => {
  vi.spyOn(env.LINE_WEBHOOK_QUEUE, 'send').mockRejectedValue(new Error('queue unavailable'));
  network.mockImplementation(async () => Response.json({ ok: true }));
  const { body, request } = await signedRequest([chat]);
  expect((await exports.default.fetch(request)).status).toBe(200);
  expect(network).toHaveBeenCalledTimes(1);
  expect(network.mock.calls[0][1].body).toBe(body);
});

it('LINE_WEBHOOK_MODE=sync keeps the original path, including 502 for LINE redelivery', async () => {
  const send = vi.spyOn(env.LINE_WEBHOOK_QUEUE, 'send').mockResolvedValue(undefined);
  network.mockImplementation(async () => Response.json({ ok: false, message: 'unauthorized' }));
  const { request } = await signedRequest([chat]);
  const response = await worker.fetch(request, { ...env, LINE_WEBHOOK_MODE: 'sync' }, createExecutionContext());
  expect(response.status).toBe(502);
  expect(send).not.toHaveBeenCalled();
});

it('the consumer forwards to GAS once per attempt and acknowledges on success', async () => {
  network.mockImplementation(async () => Response.json({ ok: true, processed: 1 }));
  const { body } = await signedRequest([chat]);
  const result = await consume([message('ok', { v: 1, route, body, receivedAt: Date.now() })]);
  expect(result.explicitAcks).toEqual(['ok']);
  expect(result.retryMessages).toEqual([]);
  expect(network).toHaveBeenCalledTimes(1);
  const url = new URL(network.mock.calls[0][0]);
  expect(url.searchParams.get('route')).toBe(route);
  expect(network.mock.calls[0][1].body).toBe(body);
});

it('retries only the failed message with exponential backoff capped at five minutes', async () => {
  const { body } = await signedRequest([chat]);
  network.mockImplementationOnce(async () => new Response('busy', { status: 503 }))
    .mockImplementationOnce(async () => Response.json({ ok: true }))
    .mockImplementationOnce(async () => Response.json({ ok: false, message: 'lock timeout' }));
  const retries = [];
  const result = await consume([
    message('first', { v: 1, route, body }, 1),
    message('second', { v: 1, route, body }, 1),
    message('late', { v: 1, route, body }, 9),
  ], batch => batch.messages.forEach(item => {
    const retry = item.retry.bind(item);
    item.retry = options => { retries.push([item.id, options]); return retry(options); };
  }));
  expect(result.explicitAcks).toEqual(['second']);
  expect(result.retryMessages.map(item => item.msgId)).toEqual(['first', 'late']);
  expect(retries).toEqual([['first', { delaySeconds: 15 }], ['late', { delaySeconds: 300 }]]);
});

it('drops malformed queue messages instead of retrying them forever', async () => {
  const result = await consume([message('bad', { v: 99, route, body: '{}' }), message('route', { v: 1, route: 'x/unknown', body: '{}' })]);
  expect(result.explicitAcks).toEqual(['bad', 'route']);
  expect(network).not.toHaveBeenCalled();
});
