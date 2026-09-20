import { DurableObject } from 'cloudflare:workers';
import { buildReservationAvailabilitySnapshot_ } from './index.js';

// Public reservation availability only. No LINE IDs, names, tokens, or secrets are stored here.
export class AvailabilitySnapshot extends DurableObject {
  // All routes change in one transaction. No TTL, alarms, or origin read on get.
  async getTrialConfig(route) {
    const records = await this.ctx.storage.get(['trial:meta', 'trial:route:' + route]);
    const meta = records.get('trial:meta');
    const config = records.get('trial:route:' + route);
    return meta && config ? { ...meta, config } : null;
  }

  async putTrialConfig(bundle, digest) {
    return this.ctx.storage.transaction(async txn => {
      const previous = await txn.get('trial:meta');
      if (previous && bundle.revision < previous.revision) throw Error('trial_config_out_of_order');
      if (previous && bundle.revision === previous.revision && digest !== previous.digest) throw Error('trial_config_revision_conflict');
      if (previous?.digest === digest) {
        // Advance the ordering watermark without rewriting any route or its content timestamp.
        if (bundle.revision > previous.revision) await txn.put('trial:meta', { ...previous, revision: bundle.revision });
        return { ok: true, unchanged: true, revision: bundle.revision, digest };
      }
      const values = { 'trial:meta': { revision: bundle.revision, digest, updatedAt: Date.now() } };
      for (const [route, config] of Object.entries(bundle.byRoute)) values['trial:route:' + route] = config;
      await txn.put(values);
      return { ok: true, unchanged: false, revision: bundle.revision, digest };
    });
  }
  async get() {
    const record = await this.ctx.storage.get('record');
    return record || null;
  }

  async put(record) {
    if (!record || typeof record.body !== 'string' || record.body.length > 20000) {
      throw new Error('availability_snapshot_invalid');
    }
    if (!Number.isFinite(record.generatedAt) || !Number.isFinite(record.policyExpiresAt) ||
        !Number.isFinite(record.refreshedAt) || record.policyExpiresAt <= record.generatedAt) {
      throw new Error('availability_snapshot_invalid');
    }
    const stored = {
      body: record.body,
      generatedAt: record.generatedAt,
      policyExpiresAt: record.policyExpiresAt,
      refreshedAt: record.refreshedAt,
      source: String(record.source || '').slice(0, 30),
    };
    await this.ctx.storage.put('record', stored);
    return { ok: true, generatedAt: stored.generatedAt, policyExpiresAt: stored.policyExpiresAt,
      refreshedAt: stored.refreshedAt, source: stored.source };
  }

  async refresh(routeKey) {
    const payload = await buildReservationAvailabilitySnapshot_(this.env, routeKey);
    const source = payload.fallback ? 'cron-fallback' : 'cron';
    return this.put({
      body: JSON.stringify(payload),
      generatedAt: Number(payload.generatedAt),
      policyExpiresAt: Number(payload.policyExpiresAt),
      refreshedAt: Date.now(),
      source,
    });
  }
  async status() {
    const record = await this.ctx.storage.get('record');
    if (!record) return { ok: true, state: 'empty' };
    return {
      ok: true,
      state: record.policyExpiresAt > Date.now() ? 'ready' : 'expired',
      generatedAt: record.generatedAt,
      policyExpiresAt: record.policyExpiresAt,
      refreshedAt: record.refreshedAt,
      source: record.source || '',
    };
  }
}
