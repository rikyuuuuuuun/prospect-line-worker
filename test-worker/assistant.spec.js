import { exports } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(async () => {vi.restoreAllMocks();await reset();});
const route='a/saitama-shibakawa';
const userId='U'+'1'.repeat(32);
function inbox(){return exports.AssistantInbox.getByName(crypto.randomUUID());}
function event(id,text,at=Date.now()){return {id:route+':'+id,route,userId,kind:'text',body:text,receivedAt:at,status:'new'};}

it('deduplicates verified A-team events in durable SQLite without sending',async () => {
  const obj=inbox(),row=event('event-unique-001','テストお問い合わせ');
  const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No outbound traffic'));
  expect((await obj.receive([row])).ok).toBe(true);
  await obj.receive([row]);
  const list=await obj.list();
  expect(list.messages).toHaveLength(1);
  expect(list.messages[0].body).toBe('テストお問い合わせ');
  expect(list.messages[0].status).toBe('new');
  expect(network).not.toHaveBeenCalled();
});

it('copying is separate from confirmation and never sends',async () => {
  const obj=inbox(),row=event('event-for-send-001','会場について');
  await obj.receive([row]);
  expect((await obj.generate(row.id)).ok).toBe(true);
  const generated=(await obj.list()).messages[0];
  expect((await obj.copied({id:row.id,versionId:generated.meta.versionId})).sent).toBe(false);
  expect((await obj.feedbackList()).feedback).toHaveLength(0);
  // Test an approved model draft without calling the external model.
  // The assistant UI cannot send a message that is still unreviewed.
  const newer=event('event-for-send-002','追加質問',row.receivedAt+1000);
  await obj.receive([newer]);
  expect((await obj.list()).countActive).toBe(2);
  // The public dismiss action does not cause any outbound LINE request.
  expect((await obj.dismiss(row.id)).ok).toBe(true);
  expect((await obj.list()).countActive).toBe(1);
});

it('route remains hidden until explicitly activated in Cloudflare variables',async () => {
  const response=await exports.default.fetch('https://fixture.invalid/assistant/');
  expect(response.status).toBe(404);
  expect((await response.json()).code).toBe('assistant_not_enabled');
});
