import test from 'node:test';
import assert from 'node:assert/strict';
import {classify,inspectReply,policyWarnings,typedClaims,csvCases,buildModelInput,skeleton,deriveSafeInquiry,styleProfile} from '../src/assistant-learning.js';
import {redactText,budgetMonth} from '../src/assistant-privacy.js';
import {memberFacts,readAvailabilityFacts,readCurrentFacts,sourceVenueMatches} from '../src/assistant-sources.js';
const route='a/saitama-shibakawa';
test('owner style guidance is drawn only from approved anonymous owner examples',()=>{
  const own={status:'approved',privacyReviewed:true,author:'owner',reply:'こんにちは！\n承知致しました😊'};
  const profile=styleProfile([own,{...own,author:'staff',reply:'秘密の別文体'},{...own,status:'revoked'}]);
  assert.equal(profile.sampleCount,1);assert.ok(profile.guide.some(g=>g.includes('「！」')));assert.ok(profile.guide.some(g=>g.includes('😊')));
  assert.ok(!JSON.stringify(profile).includes('秘密の別文体'));assert.deepEqual(styleProfile([]).guide,[]);
  assert.equal(buildModelInput({route,body:'欠席します'},[],[],{}).channel.venue,'さいたま芝川');
});
test('automatic retirement summary preserves a stated month-end without copying identity',()=>{
  const text=deriveSafeInquiry('氏名：秘密太郎\n9月末をもちまして、トランポリンを退会させていただきたいです。');
  assert.match(text,/退会希望時期: 9月末/);assert.ok(!text.includes('秘密太郎'));
  assert.ok(!deriveSafeInquiry('今月末か来月末に退会したいです。').includes('退会希望時期:'));
});
test('availability questions do not assert openings and mixed class clauses stay separate',()=>{
  const facts={availability:{dates:[],classes:[{value:'前半',status:'waitlist'},{value:'後半',status:'open'}]}};
  assert.ok(!inspectReply('前半クラスの体験について、最新の空き状況を確認してご案内します。',facts).some(i=>i.code==='class_status'));
  assert.ok(!inspectReply('前半はキャンセル待ち、後半は通常受付中です。',facts).some(i=>i.code==='class_status'));
  for(const reply of ['前半に空きがございます！','前半は空きあり','前半は体験可能となっております。','前半は受付中','後半はキャンセル待ちです。'])assert.ok(inspectReply(reply,facts).some(i=>i.code==='class_status'));
});
test('safe inquiry retains class selection needed to distinguish live waitlist and open classes',()=>{
  assert.match(deriveSafeInquiry('前半の体験に参加したいです。'),/クラス: 前半/);
  assert.match(deriveSafeInquiry('後半の体験を希望しています。'),/クラス: 後半/);
});
test('live receipt venue codes match only their canonical A-team route',()=>{
  assert.equal(sourceVenueMatches('01_さいたま芝川',route),true);
  assert.equal(sourceVenueMatches('さいたま芝川',route),true);
  assert.equal(sourceVenueMatches('02_さいたま芝川',route),false);
  assert.equal(sourceVenueMatches('02_杉下',route),false);
  const receipt=[];receipt[3]='2026/10/29 17:02:41';receipt[4]='A';receipt[5]='04_亀久保';receipt[8]='fixture-parent';receipt[13]='要確認';receipt[23]='保留';
  const now=Date.parse('2026-10-29T13:00:00Z');
  assert.equal(memberFacts([],[receipt],'a/kamekubo','fixture-parent',now).reservationStatus,'received');
  assert.equal(memberFacts([],[receipt],route,'fixture-parent',now).reservationStatus,'unknown');
});
for(const reply of ['振り替えでご参加いただけます','別の曜日のクラスにご参加いただいても大丈夫です','振替はございませんが、他の日に来ていただければ対応します','振替制度はありませんが、今回は特別に振替できます','ふりかえで参加できます','ご入会について\nいかがでしょうか？','ぜひご入会お待ちしております','体験後のご感想はいかがでしたか？'])test('audit rule counterexample: '+reply,()=>assert.ok(policyWarnings(reply).length));
for(const reply of ['退会を承りました','お手続きが済みました','体験のご予約を承りました！当日お待ちしております','日程を変更いたしました','ご参加いただけます','月会費は三千円です','来週土曜の十時からです'])test('audit unverified fact: '+reply,()=>assert.ok(inspectReply(reply).length));
test('typed facts do not authorize money or time using digits from dates',()=>{
  const facts={availability:{dates:[{value:'2026-11-10',label:'11/10'},{value:'2026-11-17',label:'11/17'}],classes:[]}};
  assert.ok(inspectReply('月会費は10円です',facts).some(i=>i.code==='fact_money'));
  assert.ok(inspectReply('17時からです',facts).some(i=>i.code==='fact_time'));
  assert.ok(inspectReply('11月11日は空いています',facts).some(i=>i.code==='fact_date'));
  assert.ok(!inspectReply('1点確認させてください。',facts).length);
  assert.equal(typedClaims('三千円')[0].value,3000);
});
test('arrival is a review item, ordinal numbers are not operational claims',()=>{
  assert.ok(inspectReply('10分前にお越しください。').some(i=>i.code==='fact_arrival'&&i.severity==='review'));
  assert.deepEqual(inspectReply('1点確認させてください。'),[]);
});
test('inbound or same-day enrollment forms are separate from later sales follow-up',()=>{
  assert.deepEqual(policyWarnings('本日はご体験いただきありがとうございました。こちらが入会申込フォームです。'),[]);
  const t={id:'form',route,category:'その他',body:'こちらが入会申込フォームです。',status:'approved',privacyReviewed:true,usage:'same_day_procedure'};
  assert.equal(buildModelInput({route,body:'入会手続きを教えて',safeText:'入会手続きを教えて'},[],[t],{}).templates.length,0);
  assert.equal(buildModelInput({route,body:'入会手続きを教えて',safeText:'入会手続きを教えて',procedureContextConfirmed:true},[],[t],{}).templates.length,1);
});
test('question semantics survive privacy-reviewed input',()=>{
  const q='明日の練習は雨でも体育館でありますか？持ち物は何ですか？';
  const input=buildModelInput({route,body:q,safeText:q},[],[],{});assert.equal(input.inquiry,q);assert.ok(JSON.stringify(input).includes('持ち物'));
  assert.ok(!redactText('担当の山田より。氏名：秘密太郎\n雨でもありますか？').includes('山田'));
  const summary=deriveSafeInquiry('氏名：秘密太郎\n'+q);assert.ok(summary.includes('雨天')&&summary.includes('持ち物')&&summary.includes('明日'));assert.ok(!summary.includes('秘密太郎'));assert.equal(deriveSafeInquiry('個別に相談したい事情があります'),null);
});
test('CSV per-row authors override the A-team default',()=>{
  const rows=csvCases('inquiry,reply,author\n欠席,承知,owner\n会費,確認,staff',{mode:'paired',route,author:'owner',authorColumn:'author'});
  assert.deepEqual(rows.map(r=>r.author),['owner','staff']);
});
test('rescheduling and cancellation classify before generic trial requests',()=>{
  for(const q of ['体験に行けなくなりました','体験の予約をキャンセルしたい','子どもが風邪なので体験日を変えたい'])assert.equal(classify(q),'体験日時変更');
  assert.equal(classify('休会したいです'),'欠席');
});
test('month boundary uses Japan time',()=>{
  assert.equal(budgetMonth(Date.parse('2026-10-31T14:59:59Z')),'2026-10');assert.equal(budgetMonth(Date.parse('2026-10-31T15:00:00Z')),'2026-11');
});
test('source snapshot age uses its sync timestamp for manual and automatic consumers',async()=>{
  const now=Date.parse('2026-10-29T06:00:00Z'),sync=now-8*3600000,ctx={exports:{AvailabilitySnapshot:{getByName:()=>({getTrialConfig:async()=>({revision:sync,updatedAt:sync-3600000,config:{dates:[],classes:[]}})})}}};
  const facts=await readAvailabilityFacts(ctx,{},route,now);assert.equal(facts.sourceSyncAt,sync);assert.equal(facts.availabilityAgeMinutes,480);assert.notEqual(facts.sourceSyncAt,now);
  assert.equal((await readAvailabilityFacts(ctx,{ASSISTANT_AVAILABILITY_MAX_AGE_MS:3600000},route,now)).availabilityState,'stale');
});
test('household links and old/cancelled trial rows are not treated as current completed reservations',()=>{
  const now=Date.parse('2026-10-29T06:00:00Z');const link=id=>{const r=[];r[1]='user';r[3]=id;r[10]='在籍';r[11]='A';r[12]='さいたま芝川';r[13]='linked';r[16]=route;return r;};
  const trial=(date,status)=>{const r=[];r[3]=date;r[4]='A';r[5]='さいたま芝川';r[8]='user';r[13]=status;return r;};
  assert.equal(memberFacts([link('child-a'),link('child-b')],[],route,'user',now).membership,'active');
  assert.equal(memberFacts([], [trial('2020-01-01','反映済')],route,'user',now).reservationStatus,'unknown');
  assert.equal(memberFacts([], [trial('2026-10-29','取消済')],route,'user',now).reservationStatus,'cancelled');
  assert.equal(memberFacts([], [trial('2026-10-29','キャンセル待ち')],route,'user',now).reservationStatus,'waitlisted');
});
test('skeleton removes kanji money, hourly times, ordinal weekdays and deadlines',()=>{
  const s=skeleton('月会費は三千円、第2土曜の10時、10日までにご連絡ください。');for(const x of ['三千円','第2土曜','10時','10日まで'])assert.ok(!s.includes(x));
});
test('Sheets adapter validates real header contracts and reads no name or birthday columns',async()=>{
  const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const pem='-----BEGIN PRIVATE KEY-----\n'+Buffer.from(await crypto.subtle.exportKey('pkcs8',pair.privateKey)).toString('base64')+'\n-----END PRIVATE KEY-----';
  const env={ASSISTANT_MASTER_SHEET_ID:'fixture-master-id-123456789',ASSISTANT_GOOGLE_SERVICE_ACCOUNT:JSON.stringify({client_email:'fixture@example.invalid',private_key:pem})};
  const headers=[['LINEユーザーID'],['Prospect人物ID','Prospect会員ID'],['在籍状態','主チーム','主会場','連携状態'],['元LINEルート'],['受信日時','更新日時','チーム','会場'],['LINEユーザーID'],['抽出状態','体験日','希望クラス'],['会場反映状態']];
  let drift=false;
  const fetcher=async url=>{if(String(url)==='https://oauth2.googleapis.com/token')return Response.json({access_token:'fixture-token'});
    const ranges=new URL(url).searchParams.getAll('ranges');assert.deepEqual(ranges,["'17_LINE会員連携'!B4:B5000","'17_LINE会員連携'!D4:E5000","'17_LINE会員連携'!K4:N5000","'17_LINE会員連携'!Q4:Q5000","'14_LINE体験受付'!C4:F10000","'14_LINE体験受付'!I4:I10000","'14_LINE体験受付'!N4:P10000","'14_LINE体験受付'!X4:X10000"]);
    const now=new Date().toISOString(),future=new Date(Date.now()+86400000).toISOString().slice(0,10),rows=[['parent-id'],['child-id','member-id'],['在籍','A','さいたま芝川','linked'],[route],[now,now,'A','さいたま芝川'],['parent-id'],['抽出済',future,'前半'],['反映済']];
    return Response.json({valueRanges:headers.map((h,i)=>({values:[drift&&i===2?['列変更']:h,rows[i]]}))});
  };
  const facts=await readCurrentFacts(env,route,'parent-id',fetcher);assert.equal(facts.membership,'active');assert.equal(facts.reservationStatus,'received');assert.ok(!JSON.stringify(facts).includes('child-id'));
  drift=true;assert.equal((await readCurrentFacts(env,route,'parent-id',fetcher)).sourceState,'unavailable');
});
