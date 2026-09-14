import { exports } from 'cloudflare:workers';
import { runInDurableObject, runDurableObjectAlarm, evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const payload = () => ({ source: 'reservation_form', requestId: crypto.randomUUID(),
  lineUserId: 'U' + '1'.repeat(32), lineDisplayName: 'test', experienceDate: '2026-10-01',
  className: 'test', receptionType: 'reservation', children: [{ name: 'synthetic' }], referrer: '', notes: '' });
const stub = () => exports.ReservationOutbox.getByName(crypto.randomUUID());
let network;
beforeEach(() => { network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No external traffic in tests')); });
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

it('acknowledges only after the reservation and retry alarm survive eviction; no GAS call', async () => {
  const object = stub(); const data = payload();
  const receipt = await object.accept('test-route', data);
  expect(receipt.ok).toBe(true);
  expect(network).not.toHaveBeenCalled();
  await evictDurableObject(object);
  await runInDurableObject(object, async (_, state) => {
    expect((await state.storage.get('record')).payload).toEqual(data);
    expect(await state.storage.getAlarm()).toBeGreaterThan(0);
  });
});

it('deduplicates simultaneous submissions and rejects changed content under the same ID', async () => {
  const object = stub(); const data = payload();
  const results = await Promise.all([object.accept('test-route', data), object.accept('test-route', data)]);
  expect(results[0].receiptId).toBe(results[1].receiptId);
  expect(results.filter(x => x.duplicate)).toHaveLength(1);
  expect((await object.accept('test-route', { ...data, lineDisplayName: 'renamed' })).duplicate).toBe(true);
  await expect(Promise.resolve(object.accept('test-route', { ...data, notes: 'changed' }))).rejects.toThrow('reservation_request_conflict');
});

it('retries the exact same payload after a lost acknowledgement; clears personal data only on explicit success', async () => {
  const object = stub(); const data = payload();
  await object.accept('test-route', data);
  await runDurableObjectAlarm(object);
  expect((await object.status()).state).toBe('pending');
  await runInDurableObject(object, async (_, state) => {
    expect((await state.storage.get('record')).payload).toEqual(data);
    expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
  });
  network.mockImplementationOnce(async () => Response.json({ ok: true, duplicate: true }));
  await evictDurableObject(object);
  await runDurableObjectAlarm(object);
  expect(JSON.parse(network.mock.calls[1][1].body)).toEqual(data);
  expect((await object.status()).state).toBe('synced');
  await runInDurableObject(object, async (_, state) => {
    expect((await state.storage.get('record')).payload).toBeUndefined();
    expect(await state.storage.getAlarm()).toBeNull();
  });
  expect((await object.accept('test-route', data)).duplicate).toBe(true);
});

it.each([{}, { ok: false }, { ok: 'true' }])('retains the booking when GAS does not explicitly acknowledge: %j', async result => {
  const object = stub(); await object.accept('test-route', payload());
  network.mockImplementationOnce(async () => Response.json(result));
  await runDurableObjectAlarm(object);
  expect((await object.status()).state).toBe('pending');
});

it('rolls back the booking if the retry alarm cannot be committed', async () => {
  const object = stub();
  await runInDurableObject(object, async (instance, state) => {
    const original = state.storage.transaction.bind(state.storage);
    const transaction = vi.spyOn(state.storage, 'transaction').mockImplementation(fn => original(txn => {
      txn.setAlarm = async () => { throw new Error('storage unavailable'); };
      return fn(txn);
    }));
    await expect(instance.accept('test-route', payload())).rejects.toThrow('storage unavailable');
    transaction.mockRestore();
    expect(await state.storage.get('record')).toBeUndefined();
  });
});

it('runs a durable synthetic probe without forwarding or creating a booking', async () => {
  const object = stub();
  expect((await object.startProbe()).state).toBe('pending');
  await evictDurableObject(object);
  await runDurableObjectAlarm(object);
  expect((await object.probeStatus()).state).toBe('synced');
  expect(network).not.toHaveBeenCalled();
});
