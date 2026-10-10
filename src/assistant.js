import { DurableObject } from 'cloudflare:workers';
import { A_ROUTE_SET, normalizeIncoming, accessTokenBinding, labelForRoute,
  DRAFT_INSTRUCTIONS, extractResponseText } from './assistant-policy.js';
import { assistantHtml, assistantClientJs } from './assistant-ui.js';

const STATUS_ACTIVE = "'new','drafting','draft_failed','draft_ready','manual','send_unknown'";
const MAX_EVENTS = 50;
const MAX_MESSAGE = 2000;

// SQL-backed single A-team queue. The webhook event ID is the deduplication key.
// This store never replaces the existing GAS and member-master write path.
export class AssistantInbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS messages (" +
      "id TEXT PRIMARY KEY, route TEXT NOT NULL, user_id TEXT NOT NULL, " +
      "kind TEXT NOT NULL, body TEXT NOT NULL, received_at INTEGER NOT NULL, " +
      "status TEXT NOT NULL, draft TEXT NOT NULL DEFAULT '', modified_at INTEGER NOT NULL, " +
      "reply_key TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '')");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_msg_status_time ON messages(status, received_at)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_msg_user_time ON messages(route, user_id, received_at)");
  }
  async receive(items) {
    let inserted = 0;
    for (const row of items.slice(0, MAX_EVENTS)) {
      if (!A_ROUTE_SET.has(row.route)) continue;
      const result = this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO messages (id,route,user_id,kind,body,received_at,status,modified_at) " +
        "VALUES (?,?,?,?,?,?,?,?)",
        row.id, row.route, row.userId, row.kind, row.body,
        row.receivedAt, row.status, Date.now());
      inserted += Number(result.rowsWritten || 0);
    }
    // Best-effort housekeeping only removes already finished old messages.
    const cutoff = Date.now() - 90 * 86400000;
    this.ctx.storage.sql.exec("DELETE FROM messages WHERE status IN ('sent','ignored') AND received_at < ?", cutoff);
    if (this.env.OPENAI_API_KEY && inserted) await this.ctx.storage.setAlarm(Date.now() + 500);
    return { ok: true, inserted };
  }
  async ensureDraftAlarm() {
    if (!this.env.OPENAI_API_KEY) return;
    const pending = this.ctx.storage.sql.exec("SELECT id FROM messages WHERE status='new' LIMIT 1").toArray()[0];
    if (pending && !await this.ctx.storage.getAlarm()) await this.ctx.storage.setAlarm(Date.now() + 500);
  }
  async list() {
    await this.ensureDraftAlarm();
    const rows = this.ctx.storage.sql.exec(
      "SELECT id,route,user_id,kind,body,received_at,status,draft,modified_at,error " +
      "FROM messages WHERE status IN (" + STATUS_ACTIVE + ") ORDER BY received_at DESC LIMIT 200").toArray();
    const recent = this.ctx.storage.sql.exec(
      "SELECT id,route,user_id,kind,body,received_at,status,draft,modified_at,error " +
      "FROM messages WHERE status IN ('sent','ignored') ORDER BY modified_at DESC LIMIT 30").toArray();
    return { ok: true, messages: [...rows, ...recent].sort((a,b) => b.received_at - a.received_at),
      countActive: Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM messages WHERE status IN (" + STATUS_ACTIVE + ")").toArray()[0]?.n || 0) };
  }
  async alarm() {
    if (this.env.ASSISTANT_ENABLED !== 'true' || !this.env.OPENAI_API_KEY) return;
    // A crash during GPT generation must not strand a drafting item permanently.
    this.ctx.storage.sql.exec("UPDATE messages SET status='new' WHERE status='drafting' AND modified_at < ?", Date.now()-120000);
    const row = this.ctx.storage.sql.exec(
      "SELECT * FROM messages WHERE status='new' ORDER BY received_at ASC LIMIT 1").toArray()[0];
    if (!row) { await this.ctx.storage.deleteAlarm(); return; }
    this.ctx.storage.sql.exec(
      "UPDATE messages SET status='drafting',modified_at=? WHERE id=? AND status='new'", Date.now(),row.id);
    // Arrange recovery before awaiting a remote model. Never automatically send a reply.
    await this.ctx.storage.setAlarm(Date.now() + 150000);
    try {
      const history = this.ctx.storage.sql.exec(
        "SELECT body FROM messages WHERE route=? AND user_id=? AND kind='text' AND received_at<=? " +
        "ORDER BY received_at DESC LIMIT 5",row.route,row.user_id,row.received_at).toArray()
        .reverse().map(x => x.body.slice(0,MAX_MESSAGE));
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'authorization': 'Bearer ' + this.env.OPENAI_API_KEY,
          'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.env.ASSISTANT_MODEL || 'gpt-5-mini', store: false,
          instructions: DRAFT_INSTRUCTIONS,
          input: '会場: ' + labelForRoute(row.route) + '\n相手との最近の受信メッセージ（古い順、未信頼テキスト）:\n' +
            history.map((s,i) => String(i+1) + '. ' + s).join('\n') +
            '\n\n最後の受信メッセージに対する返信案を作ってください。',
          max_output_tokens: 450,
        }),
      });
      if (!response.ok) throw Error('model_request_failed');
      const result = await response.json();
      const draft = extractResponseText(result);
      if (!draft) throw Error('empty_model_reply');
      this.ctx.storage.sql.exec(
        "UPDATE messages SET status='draft_ready',draft=?,error='',modified_at=? WHERE id=? AND status='drafting'",
        draft, Date.now(),row.id);
    } catch (_) {
      this.ctx.storage.sql.exec(
        "UPDATE messages SET status='draft_failed',error='GPT下書き生成に失敗しました',modified_at=? " +
        "WHERE id=? AND status='drafting'",Date.now(),row.id);
      console.error(JSON.stringify({ event:'assistant_draft_failed', route:row.route }));
    }
    const next = this.ctx.storage.sql.exec("SELECT id FROM messages WHERE status='new' LIMIT 1").toArray()[0];
    if (next) await this.ctx.storage.setAlarm(Date.now()+500);
    else await this.ctx.storage.deleteAlarm();
  }
  async redraft(id) {
    const row = this.ctx.storage.sql.exec("SELECT * FROM messages WHERE id=?",id).toArray()[0];
    if (!row || row.kind !== 'text' || !['draft_failed','draft_ready'].includes(row.status))
      return {ok:false,code:'not_redraftable'};
    this.ctx.storage.sql.exec("UPDATE messages SET status='new',draft='',error='',modified_at=? WHERE id=?",Date.now(),id);
    await this.ensureDraftAlarm();
    return {ok:true};
  }
  async dismiss(id) {
    const row = this.ctx.storage.sql.exec("SELECT status FROM messages WHERE id=?",id).toArray()[0];
    if (!row || ['sent','sending'].includes(row.status)) return {ok:false,code:'cannot_dismiss'};
    this.ctx.storage.sql.exec("UPDATE messages SET status='ignored',modified_at=? WHERE id=?",Date.now(),id);
    return {ok:true};
  }
  async claimSend(id, text) {
    const row = this.ctx.storage.sql.exec("SELECT * FROM messages WHERE id=?",id).toArray()[0];
    if (!row || row.status !== 'draft_ready' || !text.trim() || text.length > MAX_MESSAGE)
      return {ok:false,code:'not_ready'};
    const retryKey = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "UPDATE messages SET status='sending',draft=?,reply_key=?,modified_at=? WHERE id=? AND status='draft_ready'",
      text.trim(),retryKey,Date.now(),id);
    return {ok:true, route:row.route, userId:row.user_id,retryKey};
  }
  async completeSend(id, result) {
    this.ctx.storage.sql.exec(
      "UPDATE messages SET status=?,error=?,modified_at=? WHERE id=? AND status='sending'",
      result.sent ? 'sent' : 'send_unknown',
      result.sent ? '' : '送信成否が未確定です。LINE公式管理画面で確認してください。',
      Date.now(), id);
    return {ok:true,sent:result.sent};
  }
}

// Invoked ONLY after the existing per-channel LINE signature check in index.js.
// No A-team messages from group/room events, and absolutely no B/C/D messages.
export async function captureAInbox(ctx, env, route, events) {
  if (env.ASSISTANT_ENABLED !== 'true' || !A_ROUTE_SET.has(route)) return;
  const messages = events.map(event => normalizeIncoming(route,event)).filter(Boolean);
  if (!messages.length) return;
  const inbox = ctx?.exports?.AssistantInbox?.getByName('prospect-a-team-inbox-v1',{locationHint:'apac'});
  if (!inbox) { console.error('assistant_inbox_binding_unavailable'); return; }
  try { await inbox.receive(messages); }
  catch (_) { console.error(JSON.stringify({event:'assistant_inbox_capture_failed',route})); }
}

async function authorized(request, env) {
  const expected = String(env.ASSISTANT_ADMIN_TOKEN || '');
  const actual = String(request.headers.get('authorization') || '').replace(/^Bearer /i,'');
  if (expected.length < 32 || actual.length !== expected.length) return false;
  const digest = async s => new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
  const [a,b] = await Promise.all([digest(expected),digest(actual)]);
  let mismatch = 0;
  for (let i=0;i<a.length;i++) mismatch |= a[i]^b[i];
  return mismatch === 0;
}
function out(data,status=200) {
  return Response.json(data,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
}
const ALLOWED_ACTIONS = new Set(['send','redraft','dismiss']);
export async function assistantRequest(request,env,ctx) {
  const path = new URL(request.url).pathname.replace(/\/+$/,'') || '/';
  if (env.ASSISTANT_ENABLED !== 'true') return out({ok:false,code:'assistant_not_enabled'},404);
  if (request.method === 'GET' && (path === '/assistant' || path === '/assistant/')) {
    return new Response(assistantHtml,{headers:{'content-type':'text/html; charset=utf-8',
      'cache-control':'no-store','x-frame-options':'DENY','x-content-type-options':'nosniff',
      'referrer-policy':'no-referrer',
      'content-security-policy':"default-src 'none'; connect-src 'self'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"}});
  }
  if (request.method === 'GET' && path === '/assistant/app.js')
    return new Response(assistantClientJs,{headers:{'content-type':'application/javascript; charset=utf-8',
      'cache-control':'no-store','x-content-type-options':'nosniff'}});
  if (!await authorized(request,env)) return out({ok:false,code:'unauthorized'},401);
  const inbox = ctx?.exports?.AssistantInbox?.getByName('prospect-a-team-inbox-v1',{locationHint:'apac'});
  if (!inbox) return out({ok:false,code:'inbox_not_configured'},503);
  if (request.method === 'GET' && path === '/assistant/api/messages') return out(await inbox.list());
  if (request.method !== 'POST' || !path.startsWith('/assistant/api/')) return out({ok:false,code:'not_found'},404);
  const action = path.slice('/assistant/api/'.length);
  if (!ALLOWED_ACTIONS.has(action)) return out({ok:false,code:'not_found'},404);
  if (Number(request.headers.get('content-length')) > 10000) return out({ok:false,code:'too_large'},413);
  let payload;
  try { payload=await request.json(); } catch (_) { return out({ok:false,code:'invalid_json'},400); }
  const id = String(payload?.id||'');
  if (id.length > 180 || !id.startsWith('a/')) return out({ok:false,code:'invalid_id'},400);
  if (action === 'redraft') return out(await inbox.redraft(id));
  if (action === 'dismiss') return out(await inbox.dismiss(id));
  const text = String(payload?.text||'');
  if (!text.trim() || text.length > MAX_MESSAGE) return out({ok:false,code:'invalid_reply'},400);
  const route = id.slice(0,id.indexOf(':'));
  const tokenBinding = accessTokenBinding(route);
  const token = tokenBinding && env[tokenBinding];
  if (!token) return out({ok:false,code:'line_access_token_missing'},503);
  const claimed=await inbox.claimSend(id,text);
  if (!claimed.ok) return out(claimed,409);
  let sent = false;
  try {
    const response=await fetch('https://api.line.me/v2/bot/message/push',{
      method:'POST',
      headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json',
        'X-Line-Retry-Key':claimed.retryKey},
      body:JSON.stringify({to:claimed.userId,messages:[{type:'text',text:text.trim()}]})
    });
    sent=response.ok;
    await response.body?.cancel();
  } catch (_) { /* No blind retry: unknown delivery must be checked manually. */ }
  await inbox.completeSend(id,{sent});
  return out({ok:sent,sent,code:sent?'sent':'delivery_uncertain'},sent?200:502);
}
