import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
let mf,dir,modelWorker,externalCalls=[];const token='local-test-only-token-32-characters-long',route='a/saitama-shibakawa';
before(async()=>{dir=await mkdtemp(join(tmpdir(),'prospect-assistant-test-'));const file=join(dir,'worker.mjs');await build({entryPoints:['src/assistant-preview.js'],bundle:true,format:'esm',platform:'neutral',external:['cloudflare:workers'],outfile:file});
  const manifest={mainModule:'worker.mjs',modulesRoot:dir,modules:{'worker.mjs':{type:'esm',contents:await readFile(file,'utf8')}}};
  const worker=(name,values,handler)=>({config:{type:'worker',name,compatibilityDate:'2026-08-12',manifest,exports:{AssistantInbox:{type:'durable-object',storage:'sqlite'}},env:Object.fromEntries(Object.entries({ASSISTANT_ENABLED:'true',ASSISTANT_ADMIN_TOKEN:token,...values}).map(([k,value])=>[k,{type:'text',value}]))},dev:{outboundService:{type:'fetcher',handler}}});
  mf=new Miniflare({workers:[worker('assistant-test',{ASSISTANT_API_ENABLED:'false'},()=>{throw Error('No real external requests in tests');}),worker('model-test',{ASSISTANT_API_ENABLED:'true',OPENAI_API_KEY:'test-key-not-real',ASSISTANT_MODEL:'fixture-model',ASSISTANT_MONTHLY_REQUEST_LIMIT:'1',ASSISTANT_MONTHLY_TOKEN_LIMIT:'100000'},async request=>{assert.equal(request.url,'https://api.openai.com/v1/responses');const body=await request.json();externalCalls.push(body);return new Response(JSON.stringify({status:'completed',usage:{total_tokens:80},output:[{content:[{type:'output_text',text:JSON.stringify({reply:'欠席分は別の日に振替できます。',checks:[],templateIds:['invented']})}]}]}),{headers:{'content-type':'application/json'}});})]});await mf.ready;modelWorker=await mf.getWorker('model-test');});
after(async()=>{if(mf)await mf.dispose();if(dir)await rm(dir,{recursive:true,force:true});});
async function api(path,data,target=mf){const fn=target===mf?mf.dispatchFetch.bind(mf):target.fetch.bind(target);const r=await fn('http://localhost/assistant/api/'+path,{method:data===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,...await r.json()};}
test('real workerd SQLite: import, approve, extract, copy, confirm, learn and revoke',async()=>{
  const r=await api('import',{rows:[{route,inquiry:'今日はお休みします',reply:'承知いたしました！\nお大事になさってください！',author:'owner'}]});assert.equal(r.inserted,1);
  let list=await api('messages');const c=list.cases[0];assert.equal(c.status,'pending');
  assert.equal((await api('case-review',{caseId:c.id,status:'approved',privacyReviewed:true})).ok,true);
  assert.equal((await api('extract',{})).inserted,1);list=await api('messages');assert.equal(list.templates[0].status,'pending');
  const manual=await api('manual',{route,text:'本日お休みします'});assert.equal(manual.ok,true);
  assert.equal((await api('redraft',{id:manual.id})).ok,true);list=await api('messages');const m=list.messages.find(x=>x.id===manual.id);assert.equal(m.draft,c.reply);
  assert.equal((await api('copied',{id:m.id,versionId:m.meta.versionId})).sent,false);assert.equal((await api('feedback')).feedback.length,0);
  assert.equal((await api('confirm-sent',{id:m.id,versionId:m.meta.versionId,text:'承知いたしました！',confirmed:true,sentAt:new Date().toISOString()})).ok,true);
  let f=(await api('feedback')).feedback[0];assert.equal(f.draft,c.reply);assert.equal(f.final,'承知いたしました！');
  assert.equal((await api('messages')).cases.filter(x=>x.source==='feedback:'+f.id)[0].status,'pending');
  await api('feedback-revoke',{feedbackId:f.id});assert.equal((await api('feedback')).feedback[0].status,'revoked');
  assert.equal((await api('messages')).cases.find(x=>x.source==='feedback:'+f.id).status,'excluded');
});
test('real API rejects LINE sending, unauthorized access, malformed import and cross-origin writes',async()=>{
  assert.equal((await api('send',{id:'anything',text:'never send'})).status,404);
  const r=await mf.dispatchFetch('http://localhost/assistant/api/messages');assert.equal(r.status,401);
  assert.equal((await api('import',{rows:[{route:'b/tsuruse',inquiry:'a',reply:'b'}]})).status,400);
  const origin=await mf.dispatchFetch('http://localhost/assistant/api/manual',{method:'POST',headers:{authorization:'Bearer '+token,origin:'https://evil.invalid'},body:'{}'});assert.equal(origin.status,403);
});
test('real runtime with a mocked Responses API: privacy, policy blocking and hard request budget',async()=>{
  const m=await api('manual',{route,text:'氏名：秘密太郎\n今日お休みします。振替できますか？'},modelWorker);
  assert.equal((await api('redraft',{id:m.id},modelWorker)).ok,true);
  const row=(await api('messages',undefined,modelWorker)).messages[0];assert.equal(row.meta.guardBlocked,true);assert.ok(!row.draft.includes('振替できます'));assert.deepEqual(row.meta.templateIds,[]);
  assert.equal(externalCalls.length,1);const sent=JSON.stringify(externalCalls[0]);assert.ok(!sent.includes('秘密太郎'));assert.equal(externalCalls[0].store,false);assert.equal(externalCalls[0].text.format.strict,true);
  const second=await api('redraft',{id:m.id},modelWorker);assert.equal(second.code,'budget_limit');assert.equal(externalCalls.length,1);
});
