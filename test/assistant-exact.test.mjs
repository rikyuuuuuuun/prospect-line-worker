import test from 'node:test';
import assert from 'node:assert/strict';
import {compileExactReply,exactCandidates,renderExactReply} from '../src/assistant-exact.js';
import {buildExactSelectionRequest} from '../src/assistant-model.js';
const route='a/saitama-shibakawa';
const source='こんにちは！\n《体験予約日》\n7月20日（月）\n後半クラス⇒19:15〜20:05\nお待ちしております👏';
const facts={reservationStatus:'received',availability:{dates:[{value:'2026-11-02',label:'11月2日（月）'}],classes:[{value:'前半',status:'open',time:'18:15〜19:05'},{value:'後半',status:'open',time:'19:15〜20:05'}]}};
const template=reply=>({id:'past',kind:'case',sourceBody:reply,...compileExactReply(reply)});
test('absence reply is preserved exactly, including punctuation, line breaks and emoji',()=>{
  const reply='承知いたしました！\nお大事になさってください！';const r=renderExactReply(template(reply),{});
  assert.equal(r.reply,reply);assert.equal(r.fields.length,0);assert.equal(r.blocking.length,0);
});
test('only declared variable spans change; confirmation cannot be inferred from receipt',()=>{
  const t=template(source),q='11月2日の後半クラスを体験希望です';let r=renderExactReply(t,facts,{},q);
  assert.equal(r.reply,source.replace('7月20日（月）','11月2日（月）'));assert.ok(r.blocking.some(x=>x.code==='exact_fact_unconfirmed'));
  r=renderExactReply(t,facts,{confirmedClaims:['reservation_completed']},q);assert.equal(r.blocking.length,0);
  const classSlot=t.slots.find(s=>s.type==='class');r=renderExactReply(t,facts,{values:{[classSlot.id]:'前半'},confirmedClaims:['reservation_completed']},'11月2日の体験');
  assert.equal(r.reply,source.replace('7月20日（月）','11月2日（月）').replace('後半','前半').replace('19:15〜20:05','18:15〜19:05'));
});
test('past completion and found-item text stay visible but require current confirmation',()=>{
  for(const [reply,claim]of [['こんにちは！\nこちらでお手続きは完了となります👏','withdrawal_completed'],['おはようございます！\n水筒ありました！次回お渡しいたしますね😊','item_found']]){
    const t=template(reply),r=renderExactReply(t,{});assert.equal(r.reply,reply);assert.ok(r.blocking.length);
    assert.equal(renderExactReply(t,{}, {confirmedClaims:[claim]}).blocking.length,0);
  }
});
test('old slot values never become implicit defaults and cannot override a confirmed source',()=>{
  const t=template(source),date=t.slots.find(s=>s.type==='date');const r=renderExactReply(t,facts,{values:{[date.id]:'2026-12-31'},slotsVerified:true});
  assert.ok(r.blocking.some(x=>x.code==='slot_conflicts_with_source'));assert.ok(r.reply.includes('{'+date.id+'}'));
  assert.ok(renderExactReply(t,facts).fields.some(s=>!s.resolved));
});
test('manual slots require source confirmation and template spelling stays untouched',()=>{
  const t=template('こんにちは！\nご準備いただきたいもの\n{確認済みの持ち物}\nお待ちしております👏');
  let r=renderExactReply(t,{}, {values:{確認済みの持ち物:'水筒・タオル'}});assert.ok(r.blocking.length);
  r=renderExactReply(t,{}, {values:{確認済みの持ち物:'水筒・タオル'},slotsVerified:true});assert.equal(r.reply,'こんにちは！\nご準備いただきたいもの\n水筒・タオル\nお待ちしております👏');
});
test('unapproved, other-staff and unsuitable illness or makeup cases cannot be reused',()=>{
  const c={id:'c',route,category:'欠席',author:'owner',status:'approved',privacyReviewed:true,inquiry:'体調不良で欠席します',reply:'お大事になさってください！'};
  assert.equal(exactCandidates({route,category:'欠席',body:'体調不良で欠席'},[c],[]).length,1);
  for(const bad of [{...c,status:'pending'},{...c,author:'staff'},{...c,privacyReviewed:false}])assert.equal(exactCandidates({route,category:'欠席',body:'体調不良で欠席'},[bad],[]).length,0);
  assert.equal(exactCandidates({route,category:'欠席',body:'都合で欠席'},[c],[]).length,0);
  assert.equal(exactCandidates({route,category:'欠席',body:'振替できますか'},[c],[]).length,0);
});
test('selection API has no reply field and cannot write the final wording',()=>{
  const p=buildExactSelectionRequest({inquiry:'欠席の連絡',candidates:[]},'gpt-6-luna');
  assert.equal(p.store,false);assert.equal(p.max_output_tokens,512);assert.deepEqual(Object.keys(p.text.format.schema.properties),['sourceId','checks']);
  assert.equal(p.text.format.schema.additionalProperties,false);
});


test('same-day enrollment and all parts of mixed enquiries must match the original source',()=>{
  const t={id:'form',route,category:'その他',title:'入会フォーム',body:'こちらが入会申込フォームです。',status:'approved',privacyReviewed:true,usage:'same_day_procedure'};
  const row={route,category:'その他',body:'入会手続きを教えてください',procedureContextConfirmed:true};
  assert.equal(exactCandidates(row,[],[t]).length,1);
  assert.equal(exactCandidates({...row,procedureContextConfirmed:false},[],[t]).length,0);
  assert.equal(exactCandidates({...row,body:'明日は雨でも練習はありますか？持ち物も教えてください'},[],[{...t,usage:'inbound_reply',body:'雨天でも開催します。'}]).length,0);
  assert.equal(exactCandidates({...row,body:'水筒を忘れました'},[],[{...t,usage:'inbound_reply',title:'持ち物',body:'持ち物は水筒です。'}]).length,0);
});

test('URLs are a single variable even when their path contains dates',()=>{
  const t=template('ご確認ください！\nhttps://example.com/forms/2026-10-30');assert.equal(t.slots.length,1);assert.equal(t.slots[0].type,'url');
  const r=renderExactReply(t,{}, {values:{url_1:'https://example.com/current'},slotsVerified:true});assert.equal(r.reply,'ご確認ください！\nhttps://example.com/current');assert.equal(r.blocking.length,0);
});


test('waitlist conflicts cannot be bypassed by confirming a normal completed booking',()=>{
  const t=template(source),r=renderExactReply(t,{...facts,availability:{...facts.availability,classes:facts.availability.classes.map(c=>({...c,status:'waitlist'}))}},{confirmedClaims:['reservation_completed']},'11月2日の後半');
  assert.ok(r.blocking.some(x=>x.code==='exact_class_not_open'));
  const changed=renderExactReply(template('日程を変更いたしました！'),{});assert.ok(changed.claims.some(c=>c.id==='change_completed'&&!c.confirmed));
});


test('relative dates, recurring weekdays and deadlines are never reused as fixed facts',()=>{
 const t=template('第2土曜日の活動について、明日までにご連絡ください。10分前にお越しください！');
 assert.equal(t.slots.length,3);const r=renderExactReply(t,{});assert.equal(r.blocking.length,3);assert.ok(!r.reply.includes('第2土曜日'));
});
