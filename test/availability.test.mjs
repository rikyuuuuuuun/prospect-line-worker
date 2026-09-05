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
const good = {ok:true,dates:[],classes:[{value:'前半',status:'closed'}]};
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
  c.forwardAvailabilityToGas_=async()=>({...good,fallback:true});
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
  c.forwardAvailabilityToGas_=async()=>({...good,fallback:true});
  const response=await c.handleReservationAvailability_(request(),{},{});
  assert.equal(response.status,200);assert.equal((await response.json()).edgeFallback,true);assert.equal(writes,0);
});
