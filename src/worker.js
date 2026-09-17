import core, { ReservationOutbox } from './index.js';
import { AvailabilitySnapshot } from './availability-snapshot.js';

export { ReservationOutbox, AvailabilitySnapshot };

const RESERVATION_ROUTES = Object.freeze([
  'a/saitama-shibakawa', 'a/sugishita', 'a/mizuhodai', 'a/kamekubo',
  'a/ageo-fujimi', 'a/ageo-shibakawa', 'a/kasumigaseki-nishi',
  'b/tsuruse', 'b/meiho', 'b/omiya-higashi', 'b/tsurugashima-daiichi',
  'b/okegawa-nishi', 'b/kitamoto-higashi', 'b/kamihira-kita',
  'c/katayanagi', 'c/muneoka-daini', 'c/kamine', 'c/kumagaya-nishi',
  'c/gyoda-nishi', 'c/asaka-dai10', 'c/tokorozawa-minami', 'c/kurohama-minami',
  'd/obukuro-higashi', 'd/shimooshi', 'd/izumi', 'd/yagisaki',
  'd/nakano', 'd/ebinuma', 'd/komatsu', 'd/shima',
]);
const ROUTE_SET = new Set(RESERVATION_ROUTES);
const SNAPSHOT_MIN_REMAINING_MS = 60000;

function availabilitySnapshot_(ctx, routeKey) {
  if (!ctx?.exports?.AvailabilitySnapshot) return null;
  return ctx.exports.AvailabilitySnapshot.getByName(
    JSON.stringify(['daily-availability-v1', routeKey]),
    { locationHint: 'apac' }
  );
}

async function requestRoute_(request) {
  try {
    const text = await request.clone().text();
    if (!text || text.length > 32000) return '';
    const route = String(JSON.parse(text)?.route || '').toLowerCase().replace(/^\/+|\/+$/g, '');
    return ROUTE_SET.has(route) ? route : '';
  } catch (_) {
    return '';
  }
}

async function readDailySnapshot_(ctx, routeKey, startedAt) {
  const object = availabilitySnapshot_(ctx, routeKey);
  if (!object) return null;
  try {
    const record = await object.get();
    if (!record || typeof record.body !== 'string' ||
        !Number.isFinite(record.policyExpiresAt) ||
        record.policyExpiresAt <= Date.now() + SNAPSHOT_MIN_REMAINING_MS) return null;
    let payload;
    try { payload = JSON.parse(record.body); } catch (_) { return null; }
    if (!payload || payload.ok !== true || !Array.isArray(payload.dates) ||
        !Array.isArray(payload.classes) || !payload.availabilityProof) return null;
    return new Response(record.body, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-prospect-cache': 'DAILY-SNAPSHOT',
        'server-timing': 'availability;dur=' + Math.max(0, Date.now() - startedAt),
      },
    });
  } catch (error) {
    console.warn(JSON.stringify({ event: 'availability_snapshot_read_failed', route: routeKey,
      message: String(error?.message || 'snapshot_read_failed') }));
    return null;
  }
}

async function snapshotRecordFromResponse_(response, source) {
  if (!response || !response.ok) return null;
  const body = await response.clone().text();
  if (!body || body.length > 20000) return null;
  let payload;
  try { payload = JSON.parse(body); } catch (_) { return null; }
  const generatedAt = Number(payload?.generatedAt);
  const policyExpiresAt = Number(payload?.policyExpiresAt);
  if (payload?.ok !== true || !Number.isFinite(generatedAt) || !Number.isFinite(policyExpiresAt) ||
      policyExpiresAt <= Date.now() + SNAPSHOT_MIN_REMAINING_MS || !payload.availabilityProof) return null;
  return { body, generatedAt, policyExpiresAt, refreshedAt: Date.now(), source };
}

async function storeDailySnapshot_(ctx, routeKey, response, source) {
  const object = availabilitySnapshot_(ctx, routeKey);
  if (!object) return false;
  const record = await snapshotRecordFromResponse_(response, source);
  if (!record) return false;
  await object.put(record);
  return true;
}

async function handleAvailability_(request, env, ctx) {
  const startedAt = Date.now();
  const routeKey = await requestRoute_(request);
  if (routeKey) {
    const snapshot = await readDailySnapshot_(ctx, routeKey, startedAt);
    if (snapshot) return snapshot;
  }

  const response = await core.fetch(request, env, ctx);
  if (routeKey && response.ok) {
    const source = 'request-' + String(response.headers.get('x-prospect-cache') || 'origin').toLowerCase();
    const write = storeDailySnapshot_(ctx, routeKey, response, source).catch(error => {
      console.warn(JSON.stringify({ event: 'availability_snapshot_write_failed', route: routeKey,
        message: String(error?.message || 'snapshot_write_failed') }));
      return false;
    });
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(write);
    else await write;
  }
  return response;
}

function jstDate_(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const map = {};
  for (const part of parts) map[part.type] = part.value;
  return map.year + map.month + map.day;
}

async function refreshDailyAvailability_(scheduledTime, env, ctx) {
  const refreshDate = jstDate_(Number(scheduledTime) || Date.now());
  const origin = 'https://refresh-' + refreshDate + '.prospect.invalid';
  const failures = [];
  let refreshed = 0;

  // Sequential reads are deliberate: GAS/Sheets should never receive a 30-request burst at 03:00.
  for (const routeKey of RESERVATION_ROUTES) {
    try {
      // A date-specific synthetic origin gives the core Cache API a new key each day,
      // guaranteeing that this 03:00 job reaches GAS instead of reusing yesterday's edge cache.
      const request = new Request(origin + '/api/reservations/availability', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ route: routeKey }),
      });
      const response = await core.fetch(request, env, ctx);
      if (!response.ok) throw new Error('availability_http_' + response.status);
      if (!await storeDailySnapshot_(ctx, routeKey, response,
        response.headers.get('x-prospect-cache') === 'FALLBACK' ? 'cron-fallback' : 'cron')) {
        throw new Error('availability_snapshot_invalid');
      }
      refreshed += 1;
    } catch (error) {
      failures.push({ route: routeKey, message: String(error?.message || 'refresh_failed') });
    }
  }

  console.log(JSON.stringify({ event: 'daily_availability_refresh', refreshDate,
    refreshed, failed: failures.length, failures }));
  if (failures.length) throw new Error('daily_availability_refresh_failed_' + failures.length);
  return { ok: true, refreshDate, refreshed };
}

async function handleSnapshotHealth_(request, ctx) {
  const routeKey = String(new URL(request.url).searchParams.get('route') || '')
    .toLowerCase().replace(/^\/+|\/+$/g, '');
  if (!ROUTE_SET.has(routeKey)) {
    return Response.json({ ok: false, message: 'invalid_route' }, { status: 400,
      headers: { 'cache-control': 'no-store' } });
  }
  const object = availabilitySnapshot_(ctx, routeKey);
  if (!object) return Response.json({ ok: false, message: 'availability_snapshot_unavailable' },
    { status: 503, headers: { 'cache-control': 'no-store' } });
  try {
    const status = await object.status();
    return Response.json({ route: routeKey, ...status }, { status: 200,
      headers: { 'cache-control': 'no-store' } });
  } catch (_) {
    return Response.json({ ok: false, route: routeKey, message: 'availability_snapshot_unavailable' },
      { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.toLowerCase().replace(/^\/+|\/+$/g, '');
    if (request.method === 'POST' && path === 'api/reservations/availability') {
      return handleAvailability_(request, env, ctx);
    }
    if (request.method === 'GET' && path === 'health/availability-snapshot') {
      return handleSnapshotHealth_(request, ctx);
    }
    return core.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(refreshDailyAvailability_(controller?.scheduledTime, env, ctx));
  },
};
