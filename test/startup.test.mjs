import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';

const source = (await readFile(new URL('../src/index.js', import.meta.url), 'utf8')).replace('export default {', 'globalThis.worker = {');
const route = 'b/tsuruse';
const good = () => ({ ok: true, availabilityProof:{payload:'fixture',signature:'fixture'}, policyExpiresAt:Date.now()+86400000, generatedAt: Date.now(), dates: [{value:'2026-09-20',label:'9月20日'}], classes: [{value:'前半',status:'open'},{value:'後半',status:'waitlist'}] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => {resolve=yes;reject=no}); return {promise,resolve,reject}; };
const settle = () => new Promise(resolve => setImmediate(resolve));
function workerContext(extra = {}) {
  const context = { console:{error(){},warn(){}}, Request, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, Date, crypto:globalThis.crypto, ...extra };
  vm.createContext(context);vm.runInContext(source,context);return context;
}
function browser(t, {init = async()=>{}, fetch = async()=>Response.json(good()), url='https://fixture.invalid/reserve?route='+route, sdk=true, permission=async()=>({state:'granted'}), chat=async()=>{}, storage=new Map()} = {}) {
  const dom = new Window({url,settings:{disableJavaScriptEvaluation:true,disableJavaScriptFileLoading:true,disableCSSFileLoading:true}});
  t.after(()=>dom.happyDOM.abort());
  const html=workerContext().buildReservationHtml_('fixture-liff');
  dom.document.write(html);
  const sdkScripts=[];
  if(!sdk)dom.document.head.appendChild=node=>{sdkScripts.push(node);return node};
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  let nextTimer=0;const timers=new Map();const marks=[];const calls=[];
  const liff={init:(...args)=>{calls.push('init');return init(...args)},isInClient:()=>true,isLoggedIn:()=>true,getContext:()=>({type:'utou'}),getIDToken:()=>'fixture-token',permission:{query:(...args)=>{calls.push('permission');return permission(...args)}},sendMessages:async()=>{calls.push('chat');return chat()}};
  const c={document:dom.document, location:new URL(url), URL, URLSearchParams, AbortController, crypto:globalThis.crypto, console:{error(){},warn(){}}, performance:{mark:name=>marks.push(name)},
    sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    fetch:(...args)=>{calls.push(args[0]);return fetch(...args)},
    setTimeout:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id},clearTimeout:id=>timers.delete(id),
    addEventListener:dom.addEventListener.bind(dom), ...(sdk?{liff}:{})};
  c.window=c;vm.createContext(c);vm.runInContext(script,c);
  return {c,dom,html,calls,marks,timers,sdkScripts,element:id=>dom.document.getElementById(id),run:code=>vm.runInContext(code,c),fire:ms=>{for(const [id,timer] of [...timers])if(timer.ms===ms){timers.delete(id);timer.fn()}},event:(id,type)=>dom.document.getElementById(id).dispatchEvent(new dom.Event(type,{cancelable:true}))};
}

test('HTML is independent of LINE and GAS and does not block parsing on the SDK',async()=>{
  const c=workerContext({fetch:()=>{throw Error('must not call upstream')}});
  const response=await c.worker.fetch(new Request('https://fixture.invalid/reserve'),{LIFF_ID:'fixture'},{});
  const html=await response.text();
  assert.equal(response.status,200);
  assert.match(html,/<form id="reservationForm">/);
  assert.doesNotMatch(html,/<script[^>]+src=/);
});

test('children can be entered while LINE is pending; public availability starts immediately',async t=>{
  const init=deferred();const b=browser(t,{init:()=>init.promise});await settle();
  assert.equal(b.element('reservationForm').classList.contains('hidden'),false);
  assert.ok(b.dom.document.querySelector('.child-name'));
  assert.ok(b.calls.includes('/api/reservations/availability'));
  assert.equal(b.run('availabilityReady'),true);
  assert.equal(b.element('submitButton').disabled,true);
  b.dom.document.querySelector('.child-name').value='入力を保持';
  init.resolve();await settle();
  assert.equal(b.element('submitButton').disabled,false);
  assert.equal(b.dom.document.querySelector('.child-name').value,'入力を保持');
  assert.equal(b.calls.includes('permission'),false);
});

test('a slow GAS response does not delay LINE initialization or hide the form',async t=>{
  const data=deferred();const b=browser(t,{fetch:()=>data.promise});await settle();
  assert.equal(b.run('lineReady'),true);
  assert.equal(b.element('reservationForm').classList.contains('hidden'),false);
  assert.equal(b.element('submitButton').disabled,true);
  data.resolve(Response.json(good()));await settle();assert.equal(b.element('submitButton').disabled,false);
});

test('pending LIFF initialization is never duplicated, and late success recovers',async t=>{
  const init=deferred();const b=browser(t,{init:()=>init.promise});await settle();
  b.fire(12000);b.run('connectLine();connectLine()');await settle();
  assert.equal(b.calls.filter(x=>x==='init').length,1);
  assert.match(b.element('lineStatus').textContent,/応答が遅れ/);
  init.resolve();await settle();
  assert.equal(b.element('lineStatus').classList.contains('hidden'),true);
  assert.equal(b.element('submitButton').disabled,false);
});

test('a rejected LIFF init can be retried without re-fetching dates or losing input',async t=>{
  let attempts=0;const b=browser(t,{init:async()=>{if(++attempts===1)throw Error('network')}});await settle();
  b.dom.document.querySelector('.child-name').value='入力を保持';
  assert.equal(b.element('retryLineButton').classList.contains('hidden'),false);
  b.event('retryLineButton','click');await settle();
  assert.equal(attempts,2);assert.equal(b.calls.filter(x=>x==='/api/reservations/availability').length,1);
  assert.equal(b.dom.document.querySelector('.child-name').value,'入力を保持');
  assert.equal(b.element('submitButton').disabled,false);
});

test('availability timeout preserves input, retry does not repeat LINE initialization',async t=>{
  let attempts=0;const b=browser(t,{fetch:async(_url,opts)=>{
    if(++attempts===1)return new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))));
    return Response.json(good());
  }});await settle();
  b.dom.document.querySelector('.child-name').value='入力を保持';
  b.fire(10000);await settle();
  assert.equal(b.element('retryAvailabilityButton').classList.contains('hidden'),false);
  assert.equal(b.element('reservationForm').classList.contains('hidden'),false);
  assert.equal(b.element('submitButton').disabled,true);
  b.event('retryAvailabilityButton','click');b.event('retryAvailabilityButton','click');await settle();
  assert.equal(attempts,2);assert.equal(b.calls.filter(x=>x==='init').length,1);
  assert.equal(b.dom.document.querySelector('.child-name').value,'入力を保持');
  assert.equal(b.element('submitButton').disabled,false);
});

test('SDK failure permits public form entry and controlled script retry',async t=>{
  const b=browser(t,{sdk:false});await settle();
  assert.equal(b.run('availabilityReady'),true);
  b.fire(12000);b.run('connectLine()');assert.equal(b.sdkScripts.length,1);
  b.sdkScripts[0].onerror();await settle();assert.equal(b.element('retryLineButton').classList.contains('hidden'),false);
  b.event('retryLineButton','click');b.event('retryLineButton','click');await settle();
  assert.equal(b.sdkScripts.length,2);
  assert.equal(b.element('reservationForm').classList.contains('hidden'),false);
  assert.equal(b.element('submitButton').disabled,true);
});

test('primary redirect without a route still initializes LIFF, and never reads an unknown route',async t=>{
  const b=browser(t,{url:'https://fixture.invalid/reserve'});await settle();
  assert.equal(b.calls.filter(x=>x==='init').length,1);
  assert.equal(b.calls.some(x=>x.startsWith('/api/')),false);
  assert.equal(b.element('submitButton').disabled,true);
});

test('query, primary liff.state and path forms preserve the venue without URL mutation',async t=>{
  for(const path of ['/reserve?route=b%2Ftsuruse','/reserve?liff.state=%3Froute%3Db%252Ftsuruse','/reserve?liff.state=%2Freserve%2Fb%2Ftsuruse','/reserve?liff.state=%2Fb%2Ftsuruse','/reserve/b/tsuruse']){
    const url='https://fixture.invalid'+path;const b=browser(t,{url});await settle();
    assert.equal(b.run('routeKey'),route);assert.equal(b.c.location.href,url);
    assert.equal(b.calls.filter(x=>x==='/api/reservations/availability').length,1);
  }
});

test('all-closed availability cannot enable submission',async t=>{
  const b=browser(t,{fetch:async()=>Response.json({...good(),classes:[{value:'前半',status:'closed'}]})});await settle();
  assert.equal(b.element('submitButton').disabled,true);
  assert.match(b.element('availabilityStatus').textContent,/受付は停止/);
});

test('LIFF redirects preserve only a short-lived unsent draft, isolated by venue',async t=>{
  const storage=new Map();const first=browser(t,{storage});await settle();
  first.dom.document.querySelector('.child-name').value='入力を保持';
  first.run('saveDraft()');assert.equal(storage.size,1);
  assert.doesNotMatch([...storage.values()][0],/fixture-token|idToken|requestId/);
  const other=browser(t,{storage,url:'https://fixture.invalid/reserve?route=b/meiho'});await settle();
  assert.equal(other.dom.document.querySelector('.child-name').value,'');
  const next=browser(t,{storage});await settle();
  assert.equal(next.dom.document.querySelector('.child-name').value,'入力を保持');assert.equal(storage.size,0);
  next.run('pendingRequestId="already-attempted";saveDraft()');assert.equal(storage.size,0);
});

test('expired drafts and denied session storage never block the form',async t=>{
  const key='prospect:reservation-draft:v1:'+route;
  const storage=new Map([[key,JSON.stringify({savedAt:Date.now()-1800001,children:[{name:'expired'}]})]]);
  const b=browser(t,{storage});await settle();
  assert.equal(b.dom.document.querySelector('.child-name').value,'');assert.equal(storage.size,0);
  b.c.sessionStorage={getItem(){throw Error('denied')},setItem(){throw Error('denied')},removeItem(){throw Error('denied')}};
  b.run('saveDraft();restoreDraft()');assert.equal(b.element('submitButton').disabled,false);
});

test('cache failure does not discard good availability; POST never receives the internal 24h TTL',async()=>{
  const c=workerContext({caches:{default:{match:async()=>{throw Error('cache failure')},put:async()=>{throw Error('cache full')}}}});
  c.forwardAvailabilityToGas_=async()=>good();
  const response=await c.handleReservationAvailability_(new Request('https://fixture.invalid/api/reservations/availability',{method:'POST',body:JSON.stringify({route})}),{GAS_FORWARD_KEY:'fixture-signing-key'},{});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-prospect-cache'),'MISS');
  assert.match(response.headers.get('server-timing'),/^availability;dur=\d+$/);
});

test('a fresh edge hit does not reach GAS or LINE',async()=>{
  const c=workerContext();c.caches={default:{match:async()=>c.reservationAvailabilityResponse_(good(),Date.now())}};
  c.forwardAvailabilityToGas_=async()=>{throw Error('must not fetch')};
  const response=await c.handleReservationAvailability_(new Request('https://fixture.invalid/api/reservations/availability',{method:'POST',body:JSON.stringify({route})}),{GAS_FORWARD_KEY:'fixture-signing-key'},{});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-prospect-cache'),'HIT');
});

test('availability budget cancels a stalled response body and never retries a timed-out GAS run',async()=>{
  let cancel,calls=0;
  const c=workerContext({setTimeout:fn=>{cancel=fn;return 1},clearTimeout(){},fetch:async(_url,{signal})=>{
    calls++;return {ok:true,text:()=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))))};
  }});
  const result=c.forwardAvailabilityToGas_({GAS_WEBHOOK_URL:'https://fixture.invalid/gas',GAS_FORWARD_KEY:'fixture'},route,'{}');
  await settle();cancel();await assert.rejects(result,/gas_timeout/);assert.equal(calls,1);
});

test('age-verification refresh shares the initial request deadline',async()=>{
  const c=workerContext();const deadlines=[];const requestBodies=[];
  c.forwardAvailabilityToGas_=async(_env,_route,body,deadline)=>{deadlines.push(deadline);requestBodies.push(JSON.parse(body).source);return {...good(),generatedAt:deadlines.length===1?0:Date.now()}};
  const deadline=Date.now()+8000;
  await c.loadReservationAvailabilityPayload_({},route,false,deadline);
  assert.deepEqual(deadlines,[deadline,deadline]);assert.deepEqual(requestBodies,['reservation_availability','reservation_availability_refresh']);
});

function fillWaitlist(b){
  b.dom.document.querySelector('.child-name').value='検証用';b.dom.document.querySelector('.child-grade').value='1年生';
  b.element('className').value='後半';b.event('className','change');
}
test('slow receipt permission never delays durable acceptance or permits duplicate reservations',async t=>{
  const permission=deferred(),save=deferred();
  const b=browser(t,{permission:()=>permission.promise,fetch:async path=>path==='/api/reservations'?save.promise:Response.json(good())});await settle();fillWaitlist(b);
  b.event('reservationForm','submit');b.event('reservationForm','submit');await settle();
  assert.equal(b.calls.filter(x=>x==='/api/reservations').length,1);
  assert.equal(b.calls.includes('permission'),false);
  assert.equal(b.element('success').classList.contains('hidden'),true);
  save.resolve(Response.json({ok:true,receiptId:'fixture'}));await settle();
  assert.equal(b.element('success').classList.contains('hidden'),false);
  assert.equal(b.element('closeButton').classList.contains('hidden'),false);
  assert.equal(b.calls.filter(x=>x==='permission').length,1);
  assert.equal(b.calls.includes('chat'),false);
  b.fire(4000);assert.match(b.element('chatStatus').textContent,/受付済み/);
  b.event('reservationForm','submit');await settle();assert.equal(b.calls.filter(x=>x==='/api/reservations').length,1);
  permission.resolve({state:'granted'});await settle();assert.equal(b.calls.filter(x=>x==='chat').length,1);
});
test('pending chat receipt cannot be duplicated after watchdog; late success recovers',async t=>{
  const chat=deferred();const b=browser(t,{chat:()=>chat.promise});await settle();fillWaitlist(b);
  b.event('reservationForm','submit');await settle();
  assert.equal(b.element('success').classList.contains('hidden'),false);
  b.fire(4000);b.event('retryChatButton','click');b.event('retryChatButton','click');await settle();
  assert.equal(b.calls.filter(x=>x==='chat').length,1);
  chat.resolve();await settle();assert.ok(b.marks.includes('reservation:receipt-sent'));
  assert.equal(b.element('retryChatButton').classList.contains('hidden'),true);
});
test('receipt failure retries only the receipt and never repeats the saved reservation',async t=>{
  let sends=0;const b=browser(t,{chat:async()=>{if(++sends===1)throw Error('network')}});await settle();fillWaitlist(b);
  b.event('reservationForm','submit');await settle();assert.match(b.element('chatStatus').textContent,/受付済み/);
  b.event('retryChatButton','click');b.event('retryChatButton','click');await settle();
  assert.equal(sends,2);assert.equal(b.calls.filter(x=>x==='/api/reservations').length,1);
});
test('save failure never displays acceptance or sends chat; retry preserves the request id',async t=>{
  const payloads=[];const b=browser(t,{fetch:async(path,opts)=>{
    if(path==='/api/reservations'){payloads.push(JSON.parse(opts.body));return Response.json({ok:false,message:'gas_timeout'},{status:502})}
    return Response.json(good());
  }});await settle();fillWaitlist(b);b.event('reservationForm','submit');await settle();
  assert.equal(b.element('success').classList.contains('hidden'),true);assert.equal(b.calls.includes('chat'),false);
  b.event('reservationForm','submit');await settle();
  assert.equal(payloads.length,2);assert.equal(payloads[0].requestId,payloads[1].requestId);
  assert.deepEqual(payloads[0].availabilityProof,good().availabilityProof);
});
test('expired policy refreshes in place, preserves child input and requires review before any save',async t=>{
  const b=browser(t);await settle();fillWaitlist(b);b.run('policyExpiresAt=Date.now()-1');
  b.event('reservationForm','submit');await settle();
  assert.equal(b.calls.includes('/api/reservations'),false);
  assert.equal(b.calls.filter(x=>x==='/api/reservations/availability').length,2);
  assert.equal(b.dom.document.querySelector('.child-name').value,'検証用');
  assert.equal(b.element('className').value,'後半');assert.match(b.element('status').textContent,/もう一度送信/);
});
test('server policy rejection refreshes the form without auto-submitting',async t=>{
  const b=browser(t,{fetch:async path=>path==='/api/reservations'?Response.json({ok:false,message:'availability_policy_expired'},{status:409}):Response.json(good())});
  await settle();fillWaitlist(b);b.event('reservationForm','submit');await settle();
  assert.equal(b.calls.filter(x=>x==='/api/reservations').length,1);
  assert.equal(b.calls.filter(x=>x==='/api/reservations/availability').length,2);
  assert.equal(b.dom.document.querySelector('.child-name').value,'検証用');
  assert.equal(b.element('success').classList.contains('hidden'),true);
});
