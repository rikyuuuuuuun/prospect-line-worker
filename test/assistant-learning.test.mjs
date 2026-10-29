import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {classify,normalizeCase,csvCases,parseCsv,proposeTemplates,retrieve,buildModelInput,guardReply,correctionSuggestions} from '../src/assistant-learning.js';
import {memberFacts,readCurrentFacts} from '../src/assistant-sources.js';
const route='a/saitama-shibakawa';
const sample=over=>({...normalizeCase({route,inquiry:'本日お休みします',reply:'承知いたしました！\nお大事になさってください！',author:'owner'}),status:'approved',privacyReviewed:true,...over});
test('categorizes the seven requested inquiry types without turning absence into trial rescheduling',()=>{
  for(const [q,c]of [['体験したい','体験申し込み'],['体験の日を変更したい','体験日時変更'],['欠席します','欠席'],['退会したい','退会'],['月会費は？','会費'],['活動予定を教えて','活動予定'],['忘れ物は？','その他']])assert.equal(classify(q),c);
});
test('CSV preserves multiline quotes, groups conversations and rejects unknown mappings',()=>{
  assert.deepEqual(parseCsv('\uFEFFinquiry,reply\r\n"お休み\nします","承知！"'),[['inquiry','reply'],['お休み\nします','承知！']]);
  assert.throws(()=>parseCsv('a,"unclosed'),/invalid_csv/);
  const csv='thread,direction,time,body\nb,in,2026-10-28T01:00Z,体験\na,in,2026-10-28T02:00Z,欠席\nb,out,2026-10-28T03:00Z,確認します\na,out,2026-10-28T04:00Z,承知しました';
  const rows=csvCases(csv,{mode:'messages',route,conversationColumn:'thread',directionColumn:'direction',timeColumn:'time',textColumn:'body',incomingValue:'in',outgoingValue:'out'});
  assert.equal(rows[0].inquiry,'体験');assert.equal(rows[0].reply,'確認します');assert.equal(rows[1].inquiry,'欠席');
  assert.throws(()=>csvCases(csv,{mode:'messages'}),/csv_mapping/);
});
test('wrong historical dates are quarantined; imported content is never auto approved',()=>{
  assert.equal(normalizeCase({route,inquiry:'9月28日に体験希望',reply:'7月20日にお越しください'}).status,'quarantined');
  assert.equal(normalizeCase({route,inquiry:'体験希望',reply:'確認いたします'}).status,'pending');
  assert.throws(()=>normalizeCase({route:'b/tsuruse',inquiry:'体験',reply:'案内'}),/invalid_case/);
});
test('retrieval isolates owner, venue, approval, privacy review and revoked knowledge',()=>{
  const good=sample(),xs=[good,sample({author:'staff'}),sample({author:'unknown'}),sample({status:'excluded'}),sample({privacyReviewed:false}),sample({route:'a/sugishita'})];
  assert.deepEqual(retrieve('今日はお休みします',route,xs).map(x=>x.id),[good.id]);
  assert.equal(proposeTemplates(xs).length,2); // each venue receives a separate candidate
  assert.deepEqual(buildModelInput({route,body:'お休みします'},[],proposeTemplates(xs).map(t=>({...t,status:'approved',privacyReviewed:true})),{}).templates.length,1);
});
test('model input excludes customer identity and raw conversations',()=>{
  const c=sample(),row={route,body:'氏名：秘密太郎\nLINE U'+'a'.repeat(32)+'\n今日お休みします',user_id:'private'};
  const input=JSON.stringify(buildModelInput(row,[c],[],{membership:'unknown'}));
  for(const value of ['秘密太郎','a'.repeat(32),'private',row.body])assert.ok(!input.includes(value));
  assert.ok(input.includes('欠席'));
});
test('unverified financial, reservation and date claims cannot pass the guard',()=>{
  assert.ok(guardReply('11月10日の18:00に予約確定です。').length);
  assert.ok(guardReply('月会費は5,000円です。').length);
  assert.ok(guardReply('退会のお手続きが完了しました。').length);
  assert.ok(guardReply('別の日に振替できます。').length);
  assert.ok(guardReply('その後、入会のご検討状況はいかがですか？').length);
  assert.deepEqual(guardReply('欠席の件、承知いたしました。振替はありません。'),[]);
});
test('only repeated active sent corrections yield improvement proposals',()=>{
  const f={category:'欠席',draft:'承りました',final:'承知いたしました！',status:'active'};
  assert.equal(correctionSuggestions([f]).length,0);assert.equal(correctionSuggestions([f,{...f,id:'2'}]).length,1);
  assert.equal(correctionSuggestions([f,{...f,status:'revoked'}]).length,0);
});
test('read-only source projection fails closed and never upgrades received to completed',async()=>{
  const link=[];link[1]='user';link[10]='在籍';link[11]='A';link[12]='さいたま芝川';link[13]='linked';link[16]=route;link[7]='private child';
  const receipt=[];receipt[4]='A';receipt[5]='さいたま芝川';receipt[8]='user';receipt[23]='反映済';
  const facts=memberFacts([link],[receipt],route,'user');assert.equal(facts.membership,'active');assert.equal(facts.reservationStatus,'received');assert.ok(!JSON.stringify(facts).includes('private child'));
  assert.equal(memberFacts([link,link],[receipt],route,'user').membership,'unknown');
  let calls=0;assert.equal((await readCurrentFacts({},route,'user',()=>{calls++;})).sourceState,'unavailable');assert.equal(calls,0);
});
test('assistant source has no LINE send request or credential lookup',()=>{
  const source=readFileSync(new URL('../src/assistant.js',import.meta.url),'utf8');assert.ok(!/api\.line\.me|LINE_ACCESS_TOKEN|claimSend|completeSend/.test(source));
});
