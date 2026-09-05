import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = (await readFile(new URL('../src/index.js', import.meta.url), 'utf8')).replace('export default {', 'globalThis.worker = {');
function setup() {
  const context = { console: {error(){},warn(){}}, Request, Response, URL, URLSearchParams, Headers, TextEncoder, TextDecoder, setTimeout, clearTimeout, AbortController, Date, crypto:globalThis.crypto };
  vm.createContext(context); vm.runInContext(source,context);
  return context;
}
const route = 'b/tsuruse';
const good = {ok:true,dates:[],classes:[{value:'前半',status:'closed'}],generatedAt:Date.now()};
const request = () => new Request('https://fixture.invalid/api/reservation-availability', {method:'POST',body:JSON.stringify({route})});

test('missing, empty, invalid and duplicate classes never become open', async () => {
  for (const classes of [undefined,[],[{value:'前半',status:'unknown'}],[{value:'前半',status:'open'},{value:'前半',status:'closed'}]]) {
    const c=setup();c.forwardAvailabilityToGas_=async()=>({...good,classes});
    const response=await c.handleReservationAvailability_(request(),{},{});
    assert.equal(response.status,502);
    assert.equal((await response.json()).ok,false);
  }
});
test('fixed class absent from source fails closed',async()=>{
  const c=setup();c.forwardAvailabilityToGas_=async()=>({...good,classes:[{value:'後半',status:'open'}]});
  await assert.rejects(()=>c.loadReservationAvailabilityPayload_({},'a/ageo-fujimi',false),/fixed_class_missing/);
});
test('closed and waitlist states are preserved',async()=>{
  for(const status of ['closed','waitlist']) {
    const c=setup();c.forwardAvailabilityToGas_=async()=>({...good,classes:[{value:'前半',status}]});
    assert.equal((await c.loadReservationAvailabilityPayload_({},route,false)).classes[0].status,status);
  }
});
test('upstream fallback never refreshes edge timestamp or cache',async()=>{
  const c=setup();let writes=0;c.caches={default:{match:async()=>undefined,put:async()=>writes++}};
  c.forwardAvailabilityToGas_=async()=>({...good,fallback:true,generatedAt:undefined});
  const response=await c.handleReservationAvailability_(request(),{},{});
  assert.equal(response.status,502);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(writes,0);
  await c.refreshReservationAvailabilityEdgeCache_({},route,new Request('https://fixture.invalid/cache'));
  assert.equal(writes,0);
});
test('stale response is labelled fallback and never resets its origin timestamp',async()=>{
  const c=setup(), now=Date.now(), cached=c.reservationAvailabilityResponse_(good,now-240000);let writes=0;
  c.caches={default:{match:async()=>cached.clone(),put:async()=>writes++}};
  const response=await c.handleReservationAvailability_(request(),{},{});
  assert.equal((await response.json()).edgeFallback,true);assert.equal(writes,0);
});
test('expired or future-dated cache cannot rescue a failed upstream',async()=>{
  for(const timestamp of [Date.now()-86400001,Date.now()+60000]) {
    const c=setup();c.caches={default:{match:async()=>c.reservationAvailabilityResponse_(good,timestamp),put:async()=>{}}};
    c.forwardAvailabilityToGas_=async()=>{throw new Error('gas_timeout')};
    assert.equal((await c.handleReservationAvailability_(request(),{},{})).status,502);
  }
});
test('frontend does not invent open classes from an empty payload',()=>{
  assert.doesNotMatch(source,/CONFIG\.classes\.map\(value=>\(\{value:value,label:[^\n]+status:'open'/);
});

test('unverifiable upstream fallback may use only the bounded last-good edge copy',async()=>{
  const c=setup();let writes=0;
  c.caches={default:{match:async()=>c.reservationAvailabilityResponse_(good,Date.now()-7200000),put:async()=>writes++}};
  c.forwardAvailabilityToGas_=async()=>({...good,fallback:true,generatedAt:undefined});
  c.forwardToGas_=async()=>{throw new Error('gas_timeout')};
  const response=await c.handleReservationAvailability_(request(),{},{});
  assert.equal(response.status,200);assert.equal((await response.json()).edgeFallback,true);assert.equal(writes,0);
});

test('v38 snapshot with verified age preserves origin and never renews edge cache',async()=>{
  const c=setup();let writes=0;const generatedAt=Date.now()-120000;
  c.caches={default:{match:async()=>undefined,put:async()=>writes++}};
  c.forwardAvailabilityToGas_=async()=>({...good,fallback:true,generatedAt});
  const response=await c.handleReservationAvailability_(request(),{},{});
  assert.equal(response.status,200);const body=await response.json();
  assert.equal(body.fallback,true);assert.equal(body.generatedAt,generatedAt);
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(writes,0);
});

test('old, absent, invalid and future origin requires one live refresh',async()=>{
  for(const generatedAt of [undefined,0,'123',Infinity,NaN,Date.now()+60000,Date.now()-900001]) {
    const c=setup();let refreshes=0;
    c.forwardAvailabilityToGas_=async()=>({...good,fallback:true,generatedAt});
    c.forwardToGas_=async(_env,_route,body)=>{assert.equal(JSON.parse(body).source,'reservation_availability_refresh');refreshes++;return {...good,generatedAt:Date.now(),fallback:false};};
    assert.equal((await c.loadReservationAvailabilityPayload_({},route,false)).fallback,false);
    assert.equal(refreshes,1);
  }
});

test('failed live refresh cannot turn a fallback into fresh availability',async()=>{
  const c=setup();let refreshes=0;
  c.forwardAvailabilityToGas_=async()=>({...good,fallback:true,generatedAt:undefined});
  c.forwardToGas_=async()=>{refreshes++;return {...good,fallback:true,generatedAt:Date.now()};};
  await assert.rejects(()=>c.loadReservationAvailabilityPayload_({},route,false),/unverified_fallback/);
  assert.equal(refreshes,1);
});

test('live results keep their original edge age and numbered classes',async()=>{
  const c=setup(),generatedAt=Date.now()-120000;let saved;
  c.caches={default:{match:async()=>undefined,put:async(_key,value)=>saved=value}};
  c.forwardAvailabilityToGas_=async()=>({...good,generatedAt,classes:[{value:'①クラス',status:'open'},{value:'②クラス',status:'waitlist'},{value:'③クラス',status:'closed'}]});
  const response=await c.handleReservationAvailability_(new Request('https://fixture.invalid/api/reservations/availability',{method:'POST',body:JSON.stringify({route:'c/muneoka-daini'})}),{},{});
  assert.equal(response.status,200);assert.equal(saved.headers.get('x-prospect-cached-at'),String(generatedAt));
  assert.deepEqual((await response.json()).classes.map(v=>v.status),['open','waitlist','closed']);
});

test('submission rechecks current class state and date without any reservation write',async()=>{
  const cases=[
    ['closed','reservation',true,'class_closed'],
    ['waitlist','reservation',true,'class_status_changed'],
    ['open','waitlist',false,'class_status_changed'],
    ['open','reservation',false,'selected_date_unavailable'],
    ['open','reservation',true,null],
    ['waitlist','waitlist',false,null],
  ];
  for(const [status,receptionType,hasDate,error] of cases){
    const c=setup();const date='2026-09-20';let requests=0;
    c.forwardToGas_=async(_env,_route,body)=>{assert.equal(JSON.parse(body).source,'reservation_availability_refresh');requests++;return {...good,generatedAt:Date.now(),fallback:false,classes:[{value:'前半',status}],dates:hasDate?[{value:date,label:'fixture'}]:[]};};
    const run=()=>c.verifyReservationAvailabilityBeforeSubmit_({},route,{className:'前半',receptionType,experienceDate:date});
    if(error)await assert.rejects(run,new RegExp(error));else await run();
    assert.equal(requests,1);
  }
});

test('production GAS v38 build is accepted and old/unrelated builds rejected',async()=>{
  for(const [build,status] of [['2026-08-13-single-slot-auto1',200],['2026-08-12-activity-stable2',502],['unknown',502]]){
    const c=setup();c.forwardToGas_=async()=>({ok:true,service:'gymnastics and trampoline club LINE intake',build,authorization:'ok',activityCalendar:'ok'});
    assert.equal((await c.handleGasHealth_({})).status,status);
  }
});

test('closed or fallback availability prevents the actual reservation forwarding path',async()=>{
  for(const mode of ['closed','fallback','fresh']) {
    const c=setup();let writes=0;const calls=[];
    c.verifyLineIdToken_=async()=>({sub:'U'+'0'.repeat(32),name:'fixture'});
    c.forwardToGas_=async(_env,_route,raw)=>{
      const body=JSON.parse(raw);calls.push(body.source);
      if(body.source==='reservation_availability_refresh') return {...good,generatedAt:Date.now(),fallback:mode==='fallback',classes:[{value:'①クラス',status:mode==='closed'?'closed':'waitlist'}]};
      assert.equal(body.source,'reservation_form');writes++;return {ok:true,receiptId:'fixture'};
    };
    const req=new Request('https://fixture.invalid/api/reservations',{method:'POST',body:JSON.stringify({route:'c/muneoka-daini',idToken:'fixture',requestId:'fixture-1234567890',className:'①クラス',receptionType:'waitlist',experienceDate:'',children:[{name:'検証用',kana:'ケンショウヨウ',grade:'1年生'}]})});
    const response=await c.handleReservationSubmit_(req,{});
    assert.equal(writes,mode==='fresh'?1:0);
    assert.equal((await response.json()).ok,mode==='fresh');
    assert.equal(calls[0],'reservation_availability_refresh');
  }
});
