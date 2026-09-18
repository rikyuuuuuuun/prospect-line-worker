import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source=(await readFile(new URL('../src/index.js',import.meta.url),'utf8')).replace(/^export \{ ReservationOutbox \} from .*;$/m,'').replace('export async function buildReservationAvailabilitySnapshot_','async function buildReservationAvailabilitySnapshot_').replace('export default {','globalThis.worker = {');
const env={GAS_FORWARD_KEY:'test-key',LINE_LOGIN_CHANNEL_ID:'test-channel'};
const route='b/tsuruse';
function setup(extra={}) { const c={Request,Response,Headers,URL,URLSearchParams,TextEncoder,TextDecoder,AbortController,setTimeout,clearTimeout,crypto:globalThis.crypto,Date,console,...extra};vm.createContext(c);vm.runInContext(source,c);return c; }
const request=()=>new Request('https://fixture.invalid/api/reservations/session',{method:'POST',body:JSON.stringify({route,idToken:'test-token'})});
async function session(c,identity={}) {
  c.verifyLineIdToken_=async()=>({sub:'U'+'1'.repeat(32),aud:env.LINE_LOGIN_CHANNEL_ID,exp:Date.now()/1000+3600,name:'synthetic',...identity});
  return (await c.handleReservationSession_(request(),env)).json();
}
test('preverified identity is route/channel bound, signed, short-lived and needs no upstream on submit',async()=>{
  const c=setup(),data=await session(c);
  assert.ok(data.expiresAt<=Date.now()+900000);
  c.verifyLineIdToken_=()=>{throw Error('no LINE call after pre-verification')};
  assert.equal((await c.readReservationIdentity_(env,route,{identityProof:data.identityProof})).sub,'U'+'1'.repeat(32));
  for(const [e,r,p] of [[env,'d/shima',data.identityProof],[{...env,LINE_LOGIN_CHANNEL_ID:'other'},route,data.identityProof],[{...env,GAS_FORWARD_KEY:'other'},route,data.identityProof],[env,route,{...data.identityProof,payload:data.identityProof.payload.replace('synthetic','forged')}],[env,route,null]]) {
    await assert.rejects(()=>c.readReservationIdentity_(e,r,{identityProof:p}),/invalid_line_identity/);
  }
  c.Date={now:()=>data.expiresAt};
  await assert.rejects(()=>c.readReservationIdentity_(env,route,{identityProof:data.identityProof}),/reservation_session_expired/);
});
test('preverification never extends the LINE token expiry or accepts missing expiry',async()=>{
  const c=setup(),exp=Math.floor(Date.now()/1000)+60;
  assert.equal((await session(c,{exp})).expiresAt,exp*1000);
  for(const exp of [undefined,0,'bad',Date.now()/1000-1])assert.equal((await session(c,{exp})).ok,false);
});
test('public policy signatures cannot impersonate a verified LINE session',async()=>{
  const c=setup();
  const policy=await c.signReservationPolicy_(env,route,{generatedAt:Date.now(),dates:[],classes:[{value:'後半',status:'waitlist'}]});
  await assert.rejects(()=>c.readReservationIdentity_(env,route,{identityProof:policy}),/invalid_line_identity/);
});
test('LINE preverification has a single bounded call covering a stalled response body',async()=>{
  let abort,calls=0;
  const c=setup({setTimeout:fn=>{abort=fn;return 1},clearTimeout(){},fetch:async(_url,{signal})=>{
    calls++;return {ok:true,status:200,text:()=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))))};
  }});
  const pending=c.handleReservationSession_(request(),env);
  await new Promise(resolve=>setImmediate(resolve));abort();
  const response=await pending;assert.equal(response.status,502);assert.equal(calls,1);
});
test('only a receipt tied to the verified sender and an accepted reservation is suppressed',async()=>{
  const c=setup(),lookups=[];
  const ctx={exports:{ReservationOutbox:{getByName:name=>{lookups.push(JSON.parse(name));return {status:async()=>({state:'pending',receiptId:'FORM-fixture-1234567890'})}}}}};
  const event={type:'message',source:{userId:'U'+'1'.repeat(32)},message:{type:'text',text:'【体験予約を送信しました】\nsynthetic\n受付番号：FORM-fixture-1234567890'}};
  assert.equal(await c.isAcceptedReservationReceipt_(ctx,route,event),true);
  assert.deepEqual(lookups[0],[route,event.source.userId,'fixture-1234567890']);
  for(const message of [{type:'text',text:'ordinary message'},{...event.message,text:event.message.text+'\nchanged'}])assert.equal(await c.isAcceptedReservationReceipt_(ctx,route,{...event,message}),false);
  const empty={exports:{ReservationOutbox:{getByName:()=>({status:async()=>null})}}};
  assert.equal(await c.isAcceptedReservationReceipt_(empty,route,event),false);
});
