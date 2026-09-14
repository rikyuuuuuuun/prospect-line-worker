import { env, exports } from 'cloudflare:workers';
import { runInDurableObject, runDurableObjectAlarm, reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
let network;
beforeEach(()=>{network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('External traffic disabled'));});
afterEach(async()=>{vi.restoreAllMocks();await reset();});
const route='b/tsuruse', userId='U'+'1'.repeat(32);
const post=(path,body)=>exports.default.fetch('https://fixture.invalid'+path,{method:'POST',body:JSON.stringify(body)});
async function sign(purpose,data) {
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.GAS_FORWARD_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const payload=JSON.stringify(data);
  const bytes=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(purpose+'\n'+payload));
  return {payload,signature:Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('')};
}
async function booking() {
  return {route,requestId:crypto.randomUUID(),receptionType:'waitlist',className:'後半',experienceDate:'',
    children:[{name:'synthetic',grade:'1年生'}],referrer:'',notes:'',
    identityProof:await sign('prospect-reservation-session-v1',{route,aud:env.LINE_LOGIN_CHANNEL_ID,sub:userId,name:'synthetic',expiresAt:Date.now()+900000}),
    availabilityProof:await sign('prospect-reservation-policy-v1',{route,generatedAt:Date.now(),dates:[],classes:[{value:'後半',status:'waitlist'}],fixedClass:''})};
}
const object=data=>exports.ReservationOutbox.getByName(JSON.stringify([data.route,userId,data.requestId]));

it('the production HTTP handler accepts into SQLite without any LINE or GAS request, even while GAS is unavailable',async()=>{
  const data=await booking(),response=await post('/api/reservations',data),receipt=await response.json();
  expect(response.status).toBe(200);expect(receipt.receiptId).toBe('FORM-'+data.requestId);
  expect(network).not.toHaveBeenCalled();
  await runInDurableObject(object(data),async(_,state)=>{
    const saved=await state.storage.get('record');
    expect(saved.payload.children).toEqual([{name:'synthetic',kana:'',grade:'1年生'}]);
    expect(saved.payload.lineUserId).toBe(userId);
    expect(saved.payload.identityProof).toBeUndefined();expect(saved.payload.idToken).toBeUndefined();
  });
  await runDurableObjectAlarm(object(data));
  expect((await object(data).status()).state).toBe('pending');
  expect((await(await post('/api/reservations',data)).json()).duplicate).toBe(true);
});

it('the session endpoint verifies LINE once and issues a locally usable proof',async()=>{
  network.mockImplementationOnce(async()=>Response.json({sub:userId,aud:env.LINE_LOGIN_CHANNEL_ID,exp:Date.now()/1000+3600,name:'synthetic'}));
  const session=await(await post('/api/reservations/session',{route,idToken:'synthetic-id-token'})).json();
  expect(session.ok).toBe(true);expect(network).toHaveBeenCalledTimes(1);
  const data=await booking();data.identityProof=session.identityProof;
  expect((await post('/api/reservations',data)).status).toBe(200);
  expect(network).toHaveBeenCalledTimes(1);
});

it.each(['identity','policy','expired','closed'])('invalid %s fails before creating any durable booking',async kind=>{
  const data=await booking();
  if(kind==='identity')data.identityProof.signature='00'.repeat(32);
  if(kind==='policy')data.availabilityProof.signature='00'.repeat(32);
  if(kind==='expired')data.identityProof=await sign('prospect-reservation-session-v1',{route,aud:env.LINE_LOGIN_CHANNEL_ID,sub:userId,expiresAt:Date.now()-1});
  if(kind==='closed')data.availabilityProof=await sign('prospect-reservation-policy-v1',{route,generatedAt:Date.now(),dates:[],classes:[{value:'後半',status:'closed'}]});
  expect((await post('/api/reservations',data)).status).toBeGreaterThanOrEqual(400);
  expect(await object(data).status()).toBeNull();expect(network).not.toHaveBeenCalled();
});
