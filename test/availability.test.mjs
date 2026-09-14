import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source=(await readFile(new URL('../src/index.js',import.meta.url),'utf8')).replace(/^export \{ ReservationOutbox \} from .*;$/m, '').replace('export default {','globalThis.worker = {');
function setup(extra={}){
  const c={console:{error(){},warn(){}},Request,Response,URL,URLSearchParams,Headers,TextEncoder,TextDecoder,setTimeout,clearTimeout,AbortController,Date,crypto:globalThis.crypto,...extra};
  vm.createContext(c);vm.runInContext(source,c);return c;
}
const env={GAS_FORWARD_KEY:'fixture-signing-key',GAS_WEBHOOK_URL:'https://fixture.invalid/gas'};
const route='b/tsuruse';
const good=(extra={})=>({ok:true,dates:[{value:'2026-09-20',label:'fixture'}],classes:[{value:'前半',status:'open'},{value:'後半',status:'waitlist'}],generatedAt:Date.now(),...extra});
const request=()=>new Request('https://fixture.invalid/api/reservations/availability',{method:'POST',body:JSON.stringify({route})});
const reservation=(extra={})=>({route,idToken:'fixture',requestId:'fixture-1234567890',className:'後半',receptionType:'waitlist',experienceDate:'',children:[{name:'検証用',grade:'1年生'}],...extra});
const submit=(c,body)=>c.handleReservationSubmit_(new Request('https://fixture.invalid/api/reservations',{method:'POST',body:JSON.stringify(body)}),env);

test('missing, invalid, duplicate or unavailable fixed classes never become open',async()=>{
  for(const classes of [undefined,[],[{value:'前半',status:'unknown'}],[{value:'前半',status:'open'},{value:'前半',status:'closed'}]]){
    const c=setup();c.forwardAvailabilityToGas_=async()=>good({classes});
    assert.equal((await c.handleReservationAvailability_(request(),env,{})).status,502);
  }
  const c=setup();c.forwardAvailabilityToGas_=async()=>good({fixedClass:'①クラス'});
  assert.equal((await c.handleReservationAvailability_(request(),env,{})).status,502);
});
test('23-hour cache needs no GAS read and never renews origin or expiry',async()=>{
  const c=setup(),generatedAt=Date.now()-23*3600000;let writes=0;
  c.caches={default:{match:async()=>c.reservationAvailabilityResponse_(good({generatedAt}),Date.now()),put:async()=>writes++}};
  c.fetch=()=>{throw Error('unexpected upstream')};
  const res=await c.handleReservationAvailability_(request(),env,{}),body=await res.json();
  assert.equal(res.status,200);assert.equal(res.headers.get('x-prospect-cache'),'HIT');assert.equal(res.headers.get('cache-control'),'no-store');
  assert.equal(body.generatedAt,generatedAt);assert.equal(body.policyExpiresAt,generatedAt+86400000);assert.equal(writes,0);
  assert.equal((await c.readReservationPolicy_(env,route,body.availabilityProof)).generatedAt,generatedAt);
});
test('expired, invalid or future origin cannot be rescued by new cache insertion time',async()=>{
  for(const generatedAt of [0,'123',Date.now()+60000,Date.now()-86400001]){
    const c=setup();c.caches={default:{match:async()=>c.reservationAvailabilityResponse_(good({generatedAt}),Date.now())}};
    c.forwardAvailabilityToGas_=async()=>{throw Error('gas_timeout')};
    assert.equal((await c.handleReservationAvailability_(request(),env,{})).status,502);
  }
});
test('fallback cache retains original expiry and prevents repeated GAS reads',async()=>{
  const c=setup(),generatedAt=Date.now()-7200000;let writes=0,reads=0,saved;
  c.caches={default:{match:async()=>saved?.clone(),put:async(_key,response)=>{writes++;saved=response}}};c.forwardAvailabilityToGas_=async()=>{reads++;return good({fallback:true,generatedAt})};
  const res=await c.handleReservationAvailability_(request(),env,{}),body=await res.json();
  assert.equal(res.status,200);assert.equal(body.fallback,true);assert.equal(body.policyExpiresAt,generatedAt+86400000);assert.equal(writes,1);
  assert.equal(saved.headers.get('x-prospect-cached-at'),String(generatedAt));
  assert.ok(Number(saved.headers.get('cache-control').split('=')[1])<=79200);
  const next=await c.handleReservationAvailability_(request(),env,{}),nextBody=await next.json();
  assert.equal(next.headers.get('x-prospect-cache'),'HIT');assert.equal(nextBody.policyExpiresAt,body.policyExpiresAt);assert.equal(reads,1);assert.equal(writes,1);
});
test('invalid upstream origin needs one bounded refresh, fallback cannot impersonate live',async()=>{
  for(const generatedAt of [undefined,0,'123',Infinity,NaN,Date.now()+60000,Date.now()-86400001]){
    const c=setup(),calls=[];
    c.forwardAvailabilityToGas_=async(_env,_route,body,deadline)=>{calls.push({source:JSON.parse(body).source,deadline});return good(calls.length===1?{fallback:true,generatedAt}:{});};
    await c.loadReservationAvailabilityPayload_(env,route,false);
    assert.deepEqual(calls.map(v=>v.source),['reservation_availability','reservation_availability_refresh']);assert.equal(calls[0].deadline,calls[1].deadline);
  }
  const c=setup();c.forwardAvailabilityToGas_=async()=>good({fallback:true,generatedAt:0});
  await assert.rejects(()=>c.loadReservationAvailabilityPayload_(env,route,false),/unverified_fallback/);
});
test('numbered classes and fixed class restrictions survive signing',async()=>{
  const c=setup();c.forwardAvailabilityToGas_=async()=>good({classes:[{value:'①クラス',status:'open'},{value:'②クラス',status:'waitlist'},{value:'③クラス',status:'closed'}],fixedClass:'②クラス'});
  const body=await(await c.handleReservationAvailability_(request(),env,{})).json();assert.deepEqual(body.classes.map(x=>x.value),['②クラス']);
  assert.equal((await c.readReservationPolicy_(env,route,body.availabilityProof)).fixedClass,'②クラス');
  await assert.rejects(()=>c.verifyReservationAvailabilityBeforeSubmit_(env,route,reservation({className:'①クラス'}),body.availabilityProof),/invalid_class/);
});
test('signed policy checks closed, waitlist, open and selected date locally',async()=>{
  const cases=[['closed','reservation',true,'class_closed'],['waitlist','reservation',true,'class_status_changed'],['open','waitlist',false,'class_status_changed'],['open','reservation',false,'selected_date_unavailable'],['open','reservation',true,null],['waitlist','waitlist',false,null]];
  for(const [status,receptionType,hasDate,error] of cases){
    const c=setup({fetch:()=>{throw Error('unexpected upstream')}});
    const proof=await c.signReservationPolicy_(env,route,good({classes:[{value:'前半',status}],dates:hasDate?good().dates:[]}));
    const run=()=>c.verifyReservationAvailabilityBeforeSubmit_(env,route,reservation({className:'前半',receptionType,experienceDate:'2026-09-20'}),proof);
    if(error)await assert.rejects(run,new RegExp(error));else await run();
  }
});
test('tampered, cross-venue, wrong-key and malformed policy cannot authorize writes',async()=>{
  const c=setup(),proof=await c.signReservationPolicy_(env,route,good());let writes=0;
  c.verifyLineIdToken_=async()=>({sub:'U'+'0'.repeat(32)});c.forwardToGas_=async()=>{writes++;return {ok:true}};
  for(const availabilityProof of [null,{}, {...proof,signature:'00'.repeat(32)},{...proof,payload:proof.payload.replace('waitlist','open')},await c.signReservationPolicy_(env,'d/shima',good()),await c.signReservationPolicy_({GAS_FORWARD_KEY:'other'},route,good())]){
    const res=await submit(c,reservation({availabilityProof}));assert.equal(res.status,400);assert.equal((await res.json()).message,'invalid_availability_policy');
  }
  assert.equal(writes,0);
});
test('signed snapshot submits after cache eviction, with exactly one GAS storage call',async()=>{
  const c=setup(),writes=[];let reads=0;c.verifyLineIdToken_=async()=>({sub:'U'+'0'.repeat(32),name:'fixture'});
  c.forwardAvailabilityToGas_=async()=>{reads++;throw Error('must not reread')};
  c.forwardToGas_=async(_env,_route,raw)=>{writes.push(JSON.parse(raw));return {ok:true,receiptId:'fixture',duplicate:true}};
  const availabilityProof=await c.signReservationPolicy_(env,route,good({generatedAt:Date.now()-23*3600000}));
  const res=await submit(c,reservation({availabilityProof}));assert.equal(res.status,200);assert.equal((await res.json()).duplicate,true);
  assert.equal(reads,0);assert.equal(writes.length,1);assert.equal(writes[0].source,'reservation_form');assert.equal(writes[0].requestId,'fixture-1234567890');assert.equal(writes[0].availabilityProof,undefined);
  assert.match(res.headers.get('server-timing'),/identity;dur=\d+, policy;dur=\d+, storage;dur=\d+, submit;dur=\d+/);
});
test('identity failure never stores despite a valid policy',async()=>{
  const c=setup(),availabilityProof=await c.signReservationPolicy_(env,route,good());
  c.verifyLineIdToken_=async()=>{throw Error('invalid_line_identity')};c.forwardToGas_=()=>{throw Error('must not write')};
  assert.equal((await submit(c,reservation({availabilityProof}))).status,401);
});
test('expiry during entry rejects before storage and cannot be renewed by signing',async()=>{
  const c=setup(),availabilityProof=await c.signReservationPolicy_(env,route,good());
  c.verifyLineIdToken_=async()=>({sub:'U'+'0'.repeat(32)});c.forwardToGas_=()=>{throw Error('must not write')};c.Date={now:()=>Date.now()+86400001};
  assert.equal((await submit(c,reservation({availabilityProof}))).status,409);
  await assert.rejects(()=>c.signReservationPolicy_(env,route,good()),/expired/);
});
test('legacy HTML uses cached public policy, not forced live rereads',async()=>{
  const c=setup();let writes=0;c.verifyLineIdToken_=async()=>({sub:'U'+'0'.repeat(32)});
  c.caches={default:{match:async()=>c.reservationAvailabilityResponse_(good())}};c.forwardAvailabilityToGas_=()=>{throw Error('must not read')};c.forwardToGas_=async()=>{writes++;return {ok:true}};
  assert.equal((await submit(c,reservation())).status,200);assert.equal(writes,1);
});
test('GAS failure, empty or ambiguous result never reports accepted',async()=>{
  for(const result of [null,{}, {ok:false,message:'reservation_busy'}]){
    const c=setup();c.verifyLineIdToken_=async()=>({sub:'U'+'0'.repeat(32)});c.forwardToGas_=async()=>result;
    const availabilityProof=await c.signReservationPolicy_(env,route,good()),res=await submit(c,reservation({availabilityProof}));
    assert.equal(res.status,502);assert.equal((await res.json()).ok,false);
  }
});
test('production GAS build accepted, unrelated builds rejected',async()=>{
  for(const [build,status] of [['2026-08-13-single-slot-auto1',200],['unknown',502]]){
    const c=setup();c.forwardToGas_=async()=>({ok:true,service:'gymnastics and trampoline club LINE intake',build,authorization:'ok',activityCalendar:'ok'});
    assert.equal((await c.handleGasHealth_({})).status,status);
  }
});

test('cached dates from yesterday are removed and past-date submissions never store',async()=>{
  const c=setup();c.caches={default:{match:async()=>c.reservationAvailabilityResponse_(good({dates:[{value:'2000-01-01',label:'past'},...good().dates]}))}};
  const res=await c.handleReservationAvailability_(request(),env,{}),body=await res.json();
  assert.ok(body.dates.every(item=>item.value!=='2000-01-01'));
  c.forwardToGas_=()=>{throw Error('must not write')};c.verifyLineIdToken_=()=>{throw Error('must not verify invalid input')};
  assert.equal((await submit(c,reservation({availabilityProof:body.availabilityProof,className:'前半',receptionType:'reservation',experienceDate:'2000-01-01'}))).status,400);
});

test('reservation storage timeout covers response body, and an empty acknowledgement is not success',async()=>{
  let abort;const c=setup({setTimeout:fn=>{abort=fn;return 1},clearTimeout(){},fetch:async(_url,{signal})=>({ok:true,status:200,headers:{},text:()=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))))})});
  const promise=c.forwardToGas_(env,route,JSON.stringify({source:'reservation_form',requestId:'fixture-1234567890'}),1);
  await new Promise(resolve=>setImmediate(resolve));abort();await assert.rejects(promise,/gas_timeout/);
  const d=setup({fetch:async()=>new Response('')});
  await assert.rejects(()=>d.forwardToGas_(env,route,JSON.stringify({source:'reservation_form'}),1));
  assert.equal((await d.forwardToGas_(env,route,JSON.stringify({events:[]}),1)).ok,true);
});
