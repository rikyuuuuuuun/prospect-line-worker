// Only public form settings. No reservation records or LINE identity are accepted.
export const TRIAL_CONFIG_PURPOSE = 'prospect-trial-config-push-v1';
export const TRIAL_CONFIG_MAX_BYTES = 512000;
const CLASS_NAMES = ['前半', '後半', '相談したい', '①クラス', '②クラス', '③クラス'];
const encoder = new TextEncoder();
export async function configDigest(text) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}
function hex(bytes) { return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join(''); }
export async function verifyConfigPush(request, body, secret, now = Date.now()) {
  const timestamp = request.headers.get('x-prospect-timestamp') || '';
  const signature = request.headers.get('x-prospect-signature') || '';
  if (!secret || !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 300000 ||
      !/^[0-9a-f]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, Uint8Array.from(signature.match(/../g), b => parseInt(b, 16)),
    encoder.encode(TRIAL_CONFIG_PURPOSE + '\n' + timestamp + '\n' + body));
}
function text(value, max) {
  if (typeof value !== 'string' || value.length > max) throw Error('invalid_trial_config');
  return value;
}
export function normalizeTrialConfig(input, routeKeys, now = Date.now()) {
  if (input?.schemaVersion !== 1 || !Number.isSafeInteger(input.revision) || input.revision <= 0 ||
      input.revision > now + 300000 || !input.byRoute || Object.keys(input.byRoute).length !== routeKeys.length) throw Error('invalid_trial_config');
  const byRoute = {};
  for (const route of routeKeys) {
    const item = input.byRoute[route];
    if (!item || !Array.isArray(item.dates) || item.dates.length > 400 ||
        !Array.isArray(item.classes) || !item.classes.length || item.classes.length > 6) throw Error('invalid_trial_config');
    const dates = item.dates.map(d => {
      const value = text(d.value, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw Error('invalid_trial_config');
      return { value, label: text(d.label, 80) };
    }).sort((a,b) => a.value.localeCompare(b.value));
    if (new Set(dates.map(d=>d.value)).size !== dates.length) throw Error('invalid_trial_config');
    const classes = item.classes.map(c => {
      if (!CLASS_NAMES.includes(c.value) || !['open','waitlist','closed'].includes(c.status)) throw Error('invalid_trial_config');
      return { value: c.value, status: c.status, label: text(c.label || c.value, 100), time: text(c.time || '', 50) };
    });
    if (new Set(classes.map(c=>c.value)).size !== classes.length) throw Error('invalid_trial_config');
    const fixedClass = item.fixedClass || '';
    if (fixedClass && !classes.some(c=>c.value === fixedClass)) throw Error('invalid_trial_config');
    byRoute[route] = { dates, classes, fixedClass };
  }
  return { schemaVersion: 1, revision: input.revision, byRoute };
}
// Calendar data is persisted beyond the current window; only the delivery window moves.
export function currentTrialWindow(dates, now = Date.now()) {
  const jst = new Date(now + 9 * 3600000);
  const today = jst.toISOString().slice(0,10);
  const end = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth()+2, 1)).toISOString().slice(0,10);
  return dates.filter(d=>d.value >= today && d.value < end).slice(0,15);
}
