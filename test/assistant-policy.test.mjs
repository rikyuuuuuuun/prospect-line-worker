import test from 'node:test';
import assert from 'node:assert/strict';
import { A_ROUTES, A_ROUTE_SET, normalizeIncoming, accessTokenBinding,
  extractResponseText, DRAFT_INSTRUCTIONS } from '../src/assistant-policy.js';

const person = 'U' + 'a'.repeat(32);
const event = {
  type: 'message', webhookEventId: '01HAK5W3Z47TEST1111',
  timestamp: 1791640000000,
  source: { type:'user',userId: person },
  message: { type:'text', text:'  来週の体験について教えてください。  ' },
};

test('A-team venue routes are the only permitted inbox routes', () => {
  assert.equal(A_ROUTES.length,7);
  for(const route of A_ROUTES) {
    assert.ok(A_ROUTE_SET.has(route));
    assert.ok(normalizeIncoming(route,event));
    assert.match(accessTokenBinding(route),/^LINE_ACCESS_TOKEN_A_/);
  }
  for(const route of ['b/tsuruse','c/katayanagi','d/yagisaki','a/unknown']) {
    assert.equal(normalizeIncoming(route,event),null);
    assert.equal(accessTokenBinding(route),null);
  }
});
test('LINE one-to-one text is sanitized and content is bounded', () => {
  const row=normalizeIncoming(A_ROUTES[0],event);
  assert.equal(row.status,'new');
  assert.equal(row.body,'来週の体験について教えてください。');
  assert.equal(row.userId,person);
  assert.equal(row.id,A_ROUTES[0]+':'+event.webhookEventId);
  assert.equal(normalizeIncoming(A_ROUTES[0],{...event,message:{type:'text',text:'x'.repeat(3000)}}).body.length,2000);
});
test('non-user chat and non-message callbacks never enter inbox', () => {
  assert.equal(normalizeIncoming(A_ROUTES[0],{...event,source:{type:'group',userId:person}}),null);
  assert.equal(normalizeIncoming(A_ROUTES[0],{...event,type:'follow'}),null);
  assert.equal(normalizeIncoming(A_ROUTES[0],{...event,webhookEventId:''}),null);
  assert.equal(normalizeIncoming(A_ROUTES[0],{...event,source:{type:'user',userId:'BAD'}}),null);
});
test('non-text content needs human inspection, never fabricated text', () => {
  const row=normalizeIncoming(A_ROUTES[2],{...event,message:{type:'image',id:'abc'}});
  assert.equal(row.status,'manual');
  assert.equal(row.body,'');
  assert.equal(row.kind,'image');
});
test('response extraction only takes model output_text', () => {
  assert.equal(extractResponseText({output:[{content:[{type:'output_text',text:' お問い合わせありがとうございます。 '}]}]}),
    'お問い合わせありがとうございます。');
  assert.equal(extractResponseText({output:[{content:[{type:'refusal',text:'No'}]}]}),'');
  assert.match(DRAFT_INSTRUCTIONS,/承認/);
  assert.match(DRAFT_INSTRUCTIONS,/未確認事項/);
});
