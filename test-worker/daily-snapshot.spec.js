import { exports } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const route = 'b/tsuruse';
const snapshot = () => exports.AvailabilitySnapshot.getByName(
  JSON.stringify(['daily-availability-v1', route])
);
let network;

beforeEach(() => {
  network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External traffic disabled'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

function availabilityBody(expiresAt = Date.now() + 3600000) {
  return {
    ok: true,
    dates: [{ value: '2026-10-01', label: '10月1日' }],
    classes: [{ value: '前半', label: '前半', time: '', status: 'open' }],
    fixedClass: '',
    fallback: false,
    generatedAt: Date.now(),
    availabilityProof: { payload: 'synthetic', signature: '00'.repeat(32) },
    policyExpiresAt: expiresAt,
  };
}

it('serves the preloaded daily snapshot without GAS or LINE traffic', async () => {
  const body = availabilityBody();
  await snapshot().put({ body: JSON.stringify(body), generatedAt: body.generatedAt,
    policyExpiresAt: body.policyExpiresAt, refreshedAt: Date.now(), source: 'cron' });

  const response = await exports.default.fetch('https://fixture.invalid/api/reservations/availability', {
    method: 'POST', body: JSON.stringify({ route }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('x-prospect-cache')).toBe('DAILY-SNAPSHOT');
  expect((await response.json()).dates).toEqual(body.dates);
  expect(network).not.toHaveBeenCalled();
});

it('reports durable snapshot readiness without exposing the snapshot body', async () => {
  const body = availabilityBody();
  await snapshot().put({ body: JSON.stringify(body), generatedAt: body.generatedAt,
    policyExpiresAt: body.policyExpiresAt, refreshedAt: Date.now(), source: 'cron' });

  const response = await exports.default.fetch(
    'https://fixture.invalid/health/availability-snapshot?route=' + encodeURIComponent(route)
  );
  const status = await response.json();
  expect(response.status).toBe(200);
  expect(status.state).toBe('ready');
  expect(status.route).toBe(route);
  expect(status.body).toBeUndefined();
  expect(network).not.toHaveBeenCalled();
});

it('refreshes one venue inside its durable object and stores a signed ready snapshot', async () => {
  const generatedAt=Date.now();
  network.mockImplementationOnce(async()=>Response.json({
    ok:true,
    dates:[{value:'2026-10-01',label:'10月1日'}],
    classes:[{value:'前半',label:'前半',time:'',status:'open'},{value:'後半',label:'後半',time:'',status:'waitlist'}],
    fixedClass:'',
    fallback:false,
    generatedAt,
  }));
  const refreshed=await snapshot().refresh(route);
  expect(refreshed.ok).toBe(true);
  expect(refreshed.source).toBe('cron');
  expect(network).toHaveBeenCalledTimes(1);
  const record=await snapshot().get();
  const body=JSON.parse(record.body);
  expect(body.ok).toBe(true);
  expect(body.availabilityProof.signature).toMatch(/^[0-9a-f]{64}$/);
  expect(body.policyExpiresAt).toBe(generatedAt+86400000);
  expect((await snapshot().status()).state).toBe('ready');
});
