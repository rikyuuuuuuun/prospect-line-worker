import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
let mf,dir,modelWorker,contextWorker,autoWorker;const calls=[],token='local-test-only-token-32-characters-long',route='a/saitama-shibakawa',now=Date.now();
const snapshot={revision:now-8*3600000,updatedAt:now-9*3600000,config:{dates:[{value:new Date(now+86400000).toISOString().slice(0,10),label:'候補日'}],classes:[{value:'前半',status:'open',time:'17:00〜18:00'}]}};
before(async()=>{
  dir=await mkdtemp(join(tmpdir(),'prospect-assistant-test-'));const file=join(dir,'worker.mjs');
  // Test-only entrypoint exercises DO alarms and incoming events; never shipped to production.
  await build({stdin:{contents:`import {DurableObject} from 'cloudflare:workers';import {AssistantInbox as BaseInbox,assistantRequest} from './src/assistant.js';export class AssistantInbox extends BaseInbox{async runAlarmForTest(){return super.alarm()}};export class AvailabilitySnapshot extends DurableObject{async getTrialConfig(){return JSON.parse(this.env.FIXTURE_SNAPSHOT)}};export default {async fetch(request,env,ctx){const p=new URL(request.url).pathname;if(p.startsWith('/fixture/')){if(request.headers.get('authorization')!=='Bearer '+env.ASSISTANT_ADMIN_TOKEN)return new Response('',{status:401});const inbox=ctx.exports.AssistantInbox.getByName('prospect-a-team-inbox-v1');const body=await request.json();if(p==='/fixture/receive')return Response.json(await inbox.receive(body.rows));if(p==='/fixture/alarm'){await inbox.runAlarmForTest();return Response.json({ok:true});}if(p==='/fixture/expire')return Response.json(await inbox.expireRaw(body.now));}return assistantRequest(request,env,ctx)}};`,resolveDir:process.cwd(),sourcefile:'test-fixture.mjs'},bundle:true,format:'esm',platform:'neutral',external:['cloudflare:workers'],outfile:file});
  const manifest={mainModule:'worker.mjs',modulesRoot:dir,modules:{'worker.mjs':{type:'esm',contents:await readFile(file,'utf8')}}};
  const worker=(name,values,reply)=>({config:{type:'worker',name,compatibilityDate:'2026-08-12',manifest,exports:{AssistantInbox:{type:'durable-object',storage:'sqlite'},AvailabilitySnapshot:{type:'durable-object',storage:'sqlite'}},env:Object.fromEntries(Object.entries({ASSISTANT_ENABLED:'true',ASSISTANT_ADMIN_TOKEN:token,FIXTURE_SNAPSHOT:JSON.stringify(snapshot),...values}).map(([k,value])=>[k,{type:'text',value}]))},dev:{outboundService:{type:'fetcher',handler:async request=>{assert.equal(request.url,'https://api.openai.com/v1/responses');const body=await request.json();calls.push({worker:name,body,input:JSON.parse(body.input)});assert.equal(body.service_tier,'default');return new Response(JSON.stringify({status:'completed',usage:{total_tokens:80},output:[{content:[{type:'output_text',text:JSON.stringify({reply,checks:[],templateIds:[]})}]}]}),{headers:{'content-type':'application/json'}});}}}});
  const enabled={ASSISTANT_API_ENABLED:'true',OPENAI_API_KEY:'test-key-not-real',ASSISTANT_MODEL:'gpt-6-luna',ASSISTANT_MONTHLY_REQUEST_LIMIT:'20',ASSISTANT_MONTHLY_TOKEN_LIMIT:'100000',ASSISTANT_MONTHLY_USD_LIMIT:'2'};
  mf=new Miniflare({workers:[worker('assistant-test',{ASSISTANT_API_ENABLED:'false'},''),worker('model-test',{...enabled,ASSISTANT_MONTHLY_REQUEST_LIMIT:'1'},'欠席分は別の日に振替できます。'),worker('context-test',enabled,'10分前にお越しください。1点確認させてください。'),worker('automatic-test',{...enabled,ASSISTANT_AUTO_DRAFT:'true'},'ご連絡ありがとうございます！'),worker('unsupported-model',{...enabled,ASSISTANT_MODEL:'not-approved'},''),worker('tiny-dollar',{...enabled,ASSISTANT_MONTHLY_USD_LIMIT:'0.000001'},'')]});
  await mf.ready;modelWorker=await mf.getWorker('model-test');contextWorker=await mf.getWorker('context-test');autoWorker=await mf.getWorker('automatic-test');
});
after(async()=>{if(mf)await mf.dispose();if(dir){const target=resolve(dir);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('prospect-assistant-test-'));await rm(target,{recursive:true,force:true});}});
async function request(path,data,target=mf){const fn=target===mf?mf.dispatchFetch.bind(mf):target.fetch.bind(target),r=await fn('http://localhost'+path,{method:data===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,...await r.json()};}
const api=(path,data,target)=>request('/assistant/api/'+path,data,target);
async function privacy(id,target,text){const p=await api('input-preview',{id},target);return api('input-approve',{id,text:text||p.text,bodyHash:p.bodyHash,confirmed:true},target);}
const review=(m,text=m.draft)=>({id:m.id,versionId:m.meta.versionId,text,noMakeup:true,noFollowup:true,factsChecked:true,reviewedMessageIds:[]});
test('real SQLite workflow separates copy, sent evidence, authorship and learning',async()=>{
  const r=await api('import',{rows:[{route,inquiry:'今日はお休みします',reply:'承知いたしました！',author:'owner'}]});assert.equal(r.inserted,1);
  let list=await api('messages');const c=list.cases[0];assert.equal(c.status,'pending');await api('case-review',{caseId:c.id,status:'approved',privacyReviewed:true});await api('extract',{});
  const manual=await api('manual',{route,text:'本日お休みします'});await api('redraft',{id:manual.id});list=await api('messages');const m=list.messages.find(x=>x.id===manual.id);assert.equal(m.draft,c.reply);
  assert.equal((await api('copied',review(m))).sent,false);assert.equal((await api('feedback')).feedback.length,0);
  assert.equal((await api('confirm-sent',{id:m.id,versionId:m.meta.versionId,text:'承知いたしました！ご連絡ありがとうございます！',confirmed:true,author:'staff',sentAt:new Date().toISOString()})).ok,true);
  const f=(await api('feedback')).feedback[0];assert.equal(f.author,'staff');assert.equal(f.draft,c.reply);assert.equal((await api('messages')).cases.find(x=>x.source==='feedback:'+f.id).author,'staff');
  await api('feedback-revoke',{feedbackId:f.id});assert.equal((await api('feedback')).feedback[0].status,'revoked');
});
test('real API rejects LINE sending, unauthorized reads and cross-origin writes',async()=>{
  assert.equal((await api('send',{id:'anything',text:'never send'})).status,404);
  assert.equal((await mf.dispatchFetch('http://localhost/assistant/api/messages')).status,401);
  assert.equal((await api('import',{rows:[{route:'b/tsuruse',inquiry:'a',reply:'b'}]})).status,400);
  const r=await mf.dispatchFetch('http://localhost/assistant/api/manual',{method:'POST',headers:{authorization:'Bearer '+token,origin:'https://evil.invalid'},body:'{}'});assert.equal(r.status,403);
});
test('privacy gate preserves reviewed question semantics and retains unsafe raw drafts',async()=>{
  const m=await api('manual',{route,text:'氏名：秘密太郎\n家庭の事情について個別に相談できますか？'},modelWorker);
  assert.equal((await api('redraft',{id:m.id},modelWorker)).code,'privacy_review_required');assert.equal(calls.length,0);
  await privacy(m.id,modelWorker);assert.equal((await api('redraft',{id:m.id},modelWorker)).ok,true);
  const row=(await api('messages',undefined,modelWorker)).messages.find(x=>x.id===m.id);assert.equal(row.status,'draft_review');assert.ok(row.draft.includes('振替できます'));assert.equal(row.meta.guardBlocked,true);
  const call=calls.find(c=>c.worker==='model-test');assert.ok(call.input.inquiry.includes('家庭の事情'));assert.ok(!JSON.stringify(call).includes('秘密太郎'));assert.equal(call.body.store,false);
  const versions=(await api('feedback',undefined,modelWorker)).versions;assert.equal(versions[0].rawDraft,row.draft);
  assert.equal((await api('copied',review(row),modelWorker)).code,'policy_edit_required');
  assert.equal((await api('copied',review(row,'ご連絡ありがとうございます！'),modelWorker)).ok,true);
  const usage=(await api('messages',undefined,modelWorker)).usage;assert.equal(usage.tokensReserved,80);assert.equal(usage.actualTokens,80);
  assert.equal((await api('redraft',{id:m.id},modelWorker)).code,'budget_limit');assert.equal(calls.filter(c=>c.worker==='model-test').length,1);
});
test('numeric review preserves model wording; manual and automatic generation use actual snapshot timestamps',async()=>{
  const q=await api('manual',{route,text:'何分前に到着すればよいですか？'},contextWorker);await privacy(q.id,contextWorker);await api('redraft',{id:q.id},contextWorker);
  const m=(await api('messages',undefined,contextWorker)).messages.find(x=>x.id===q.id);assert.ok(m.draft.startsWith('10分前'));assert.equal(m.status,'draft_review');assert.equal(m.meta.facts.sourceSyncAt,snapshot.revision);assert.ok(m.meta.facts.availabilityAgeMinutes>=480);
  assert.equal((await api('copied',review(m),contextWorker)).ok,true);
  const a=await api('manual',{route,text:'氏名：秘密太郎\n明日の練習は雨でも体育館でありますか？持ち物は何ですか？'},autoWorker);await request('/fixture/alarm',{},autoWorker);
  const generated=(await api('messages',undefined,autoWorker)).messages.find(x=>x.id===a.id);assert.equal(generated.meta.facts.sourceSyncAt,snapshot.revision);assert.deepEqual(generated.meta.facts.availability,m.meta.facts.availability);assert.equal(generated.meta.inputMode,'automatic_summary');const sent=calls.find(c=>c.worker==='automatic-test');assert.ok(sent.input.inquiry.includes('雨天')&&sent.input.inquiry.includes('持ち物'));assert.ok(!JSON.stringify(sent).includes('秘密太郎'));
});
test('template revocation invalidates every candidate even when model reports no template use',async()=>{
  await api('import-templates',{rows:[{route,title:'活動予定',body:'ご連絡ありがとうございます！'}]},contextWorker);
  let list=await api('messages',undefined,contextWorker);const t=list.templates.find(t=>t.body==='ご連絡ありがとうございます！');await api('template',{templateId:t.id,category:'活動予定',status:'approved',privacyReviewed:true},contextWorker);
  const q=await api('manual',{route,text:'活動予定を教えてください'},contextWorker);await privacy(q.id,contextWorker);await api('redraft',{id:q.id},contextWorker);
  list=await api('messages',undefined,contextWorker);const m=list.messages.find(x=>x.id===q.id);assert.ok(m.meta.templateIds.includes(t.id));assert.deepEqual(m.meta.usedTemplateIds,[]);
  const failed=await api('template',{templateId:t.id,status:'approved',privacyReviewed:false},contextWorker);assert.equal(failed.code,'privacy_review_required');assert.equal((await api('messages',undefined,contextWorker)).messages.find(x=>x.id===q.id).status,'draft_review');
  await api('template',{templateId:t.id,status:'revoked'},contextWorker);assert.equal((await api('messages',undefined,contextWorker)).messages.find(x=>x.id===q.id).status,'draft_failed');assert.equal((await api('copied',review(m),contextWorker)).code,'stale_draft');
  assert.equal((await api('confirm-sent',{id:m.id,versionId:m.meta.versionId,text:'実際に送った文です',confirmed:true,author:'owner',sentAt:'2020-01-01T00:00:00Z'},contextWorker)).code,'invalid_sent_confirmation');
  assert.equal((await api('confirm-sent',{id:m.id,versionId:m.meta.versionId,text:'実際に送った文です',confirmed:true,author:'owner',sentAt:new Date().toISOString()},contextWorker)).ok,true);
});
test('copy requires the actual newer message IDs; pre-ticked generic acknowledgment cannot bypass',async()=>{
  const q=await api('manual',{route,text:'欠席します'});await api('redraft',{id:q.id});const m=(await api('messages')).messages.find(x=>x.id===q.id);
  const newer={id:route+':newer-'+crypto.randomUUID(),route,userId:m.user_id,kind:'text',body:'追加の質問です',receivedAt:m.received_at+1000,status:'new'};await request('/fixture/receive',{rows:[newer]});
  const rejected=await api('copied',{...review(m),reviewedNewer:true});assert.equal(rejected.code,'newer_message_requires_review');assert.equal(rejected.newerMessages[0].body,newer.body);
  assert.equal((await api('copied',{...review(m),reviewedMessageIds:[newer.id]})).ok,true);
});
test('template approval blocks old operational claims and recognizes same-day enrollment scope',async()=>{
  await api('import-templates',{rows:[{route,title:'欠席',body:'振り替えでご参加いただけます'}]});let t=(await api('messages')).templates.find(t=>t.body.includes('振り替え'));assert.equal((await api('template',{templateId:t.id,status:'approved',privacyReviewed:true})).code,'template_policy_review_required');
  await api('import-templates',{rows:[{route,title:'入会案内',body:'本日はご体験いただきありがとうございました。こちらが入会申込フォームです。'}]});t=(await api('messages')).templates.find(t=>t.title==='入会案内');
  assert.equal((await api('template',{templateId:t.id,status:'approved',privacyReviewed:true})).code,'same_day_scope_required');
  assert.equal((await api('template',{templateId:t.id,status:'approved',usage:'same_day_procedure',sameDayConfirmed:true,privacyReviewed:true})).ok,true);
});
test('30-day expiry removes raw messages and private records while preserving approved anonymous cases',async()=>{
  const id=route+':retention-'+crypto.randomUUID();await request('/fixture/receive',{rows:[{id,route,userId:'U'+'a'.repeat(32),kind:'text',body:'個人情報のある原文',receivedAt:Date.now(),status:'new'}]});await privacy(id,undefined,'確認済みの匿名の質問');await api('redraft',{id});
  await request('/fixture/expire',{now:Date.now()+31*86400000});const list=await api('messages'),m=list.messages.find(x=>x.id===id);assert.equal(m.body,'');assert.equal(m.user_id,'');assert.equal(m.status,'expired');assert.ok(!JSON.stringify(list).includes('個人情報のある原文'));
  assert.ok(list.cases.some(c=>c.status==='approved'&&c.reply==='承知いたしました！'));
  const f=await api('feedback');assert.ok(f.feedback.every(x=>x.status==='expired'));assert.ok(f.versions.every(x=>x.status==='expired'));
});
test('unsupported models and an insufficient dollar reservation stop before any outbound call',async()=>{
  for(const [name,code] of [['unsupported-model','model_not_allowed'],['tiny-dollar','budget_limit']]){
    const w=await mf.getWorker(name),m=await api('manual',{route,text:'練習日を教えてください'},w);await privacy(m.id,w);
    assert.equal((await api('redraft',{id:m.id},w)).code,code);assert.equal(calls.filter(c=>c.worker===name).length,0);
  }
});
test('pagination and active-first ordering keep old open inquiries visible',async()=>{
  const older={id:route+':older-open-'+crypto.randomUUID(),route,userId:'old-open',kind:'text',body:'未対応の問い合わせ',receivedAt:Date.now()-86400000,status:'new'};
  await request('/fixture/receive',{rows:[older]});
  for(let start=0;start<210;start+=50)await request('/fixture/receive',{rows:Array.from({length:Math.min(50,210-start)},(_,i)=>({id:route+':done-'+(start+i),route,userId:'done-'+(start+i),kind:'text',body:'対応済み',receivedAt:Date.now(),status:'ignored'}))});
  const list=await api('messages');assert.equal(list.messages[0].id,older.id);assert.notEqual(list.nextOffset,null);
});
