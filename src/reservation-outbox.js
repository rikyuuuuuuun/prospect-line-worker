import { DurableObject } from 'cloudflare:workers';

// One object per reservation. Never persist LINE ID tokens or forwarding secrets.
export class ReservationOutbox extends DurableObject {
  async accept(route, payload) {
    if (!this.env.GAS_WEBHOOK_URL || !this.env.GAS_FORWARD_KEY) throw new Error('gas_not_configured');
    if (payload?.source !== 'reservation_form' || !/^[A-Za-z0-9-]{16,80}$/.test(payload.requestId || '') || !/^U[0-9a-f]{32}$/i.test(payload.lineUserId || '')) throw new Error('invalid_request');
    const canonical = JSON.stringify({ route, payload });
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))), b => b.toString(16).padStart(2, '0')).join('');
    return this.ctx.storage.transaction(async txn => {
      const existing = await txn.get('record');
      if (existing) {
        if (existing.hash !== hash) throw new Error('reservation_request_conflict');
        return { ok: true, receiptId: existing.receiptId, duplicate: true, acceptedAt: existing.acceptedAt };
      }
      const record = { kind: 'booking', state: 'pending', hash, route, payload, attempts: 0,
        receiptId: 'FORM-' + payload.requestId, acceptedAt: Date.now() };
      // Storage transaction includes the alarm. A response never acknowledges a
      // booking whose durable retry schedule failed to commit.
      await txn.put('record', record);
      await txn.setAlarm(Date.now() + 1000);
      return { ok: true, receiptId: record.receiptId, duplicate: false, acceptedAt: record.acceptedAt };
    });
  }

  async alarm() {
    const record = await this.ctx.storage.get('record');
    if (!record || record.state === 'synced') return;
    if (record.kind === 'probe') {
      await this.ctx.storage.put('record', { ...record, state: 'synced', completedAt: Date.now() });
      return;
    }
    const attempts = (record.attempts || 0) + 1;
    const delay = Math.min(3600000, 5000 * 2 ** Math.min(attempts - 1, 10));
    // Arm the next durable attempt before external I/O. A crash, deployment, or
    // lost GAS response keeps the same request ID and cannot lose the booking.
    await this.ctx.storage.transaction(async txn => {
      await txn.put('record', { ...record, attempts, lastAttemptAt: Date.now() });
      await txn.setAlarm(Date.now() + Math.max(30000, delay));
    });
    try {
      const result = await this.forwardToGas(record.route, record.payload);
      if (!result || result.ok !== true) throw new Error('gas_not_acknowledged');
      await this.ctx.storage.transaction(async txn => {
        // Remove the temporary personal-data copy after explicit GAS success.
        // Keep a small receipt/hash tombstone for replay protection.
        await txn.put('record', { kind: 'booking', state: 'synced', hash: record.hash,
          receiptId: record.receiptId, acceptedAt: record.acceptedAt, completedAt: Date.now(), attempts });
        await txn.deleteAlarm();
      });
      console.log(JSON.stringify({ event: 'reservation_synced', receiptId: record.receiptId, route: record.route, attempts }));
    } catch (_) {
      // Details from GAS may contain private information. Log only the reference.
      console.error(JSON.stringify({ event: 'reservation_sync_retry', receiptId: record.receiptId, route: record.route, attempts }));
      // The already-committed next alarm survives even if this handler terminates.
    }
  }

  async forwardToGas(route, payload) {
    const url = new URL(this.env.GAS_WEBHOOK_URL);
    url.searchParams.set('key', this.env.GAS_FORWARD_KEY);
    url.searchParams.set('route', route);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload), redirect: 'follow', signal: controller.signal });
      if (!response.ok) { await response.body?.cancel(); throw new Error('gas_http_error'); }
      return await response.json();
    } finally { clearTimeout(timer); }
  }

  // Called only through the Worker's fixed diagnostic object, never a booking.
  async startProbe() {
    return this.ctx.storage.transaction(async txn => {
      const old = await txn.get('record');
      if (old?.kind === 'booking') throw new Error('invalid_probe');
      if (old && Date.now() - old.acceptedAt < 60000) return this.publicProbe(old);
      const record = { kind: 'probe', state: 'pending', acceptedAt: Date.now() };
      await txn.put('record', record);
      await txn.setAlarm(Date.now() + 1000);
      return this.publicProbe(record);
    });
  }

  async probeStatus() { return this.publicProbe(await this.ctx.storage.get('record')); }
  publicProbe(record) {
    if (record && record.kind !== 'probe') throw new Error('invalid_probe');
    return { ok: true, state: record?.state || 'empty', acceptedAt: record?.acceptedAt || null, completedAt: record?.completedAt || null };
  }

  // No public route exposes this. Operators can inspect a receipt using a
  // server-authorized tool without logging the children's personal information.
  async status() {
    const record = await this.ctx.storage.get('record');
    return record ? { state: record.state, receiptId: record.receiptId, acceptedAt: record.acceptedAt,
      completedAt: record.completedAt || null, attempts: record.attempts || 0 } : null;
  }
}
