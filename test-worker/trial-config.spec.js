import { exports } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import workerSource from '../src/worker.js?raw';
const routes=[...workerSource.matchAll(/'([abcd]\/[^']+)'/g)].map(m=>m[1]);
const route='b/tsuruse';
const store=()=>exports.AvailabilitySnapshot.getByName('trial-config-v1');
let network;
beforeEach(()=>{network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('GAS is unavailable'));});
afterEach(async()=>{vi.restoreAllMocks();await reset();});
function bundle(revision=Date.now(), status='open') {
  const now=new Date(Date.now()+9*3600000);const today=now.toISOString().slice(0,10);
  return {schemaVersion:1,revision,byRoute:Object.fromEntries(routes.map(r=>[r,{dates:[{value:today,label:'today'}],classes:[{value:'前半',status,label:'前半',time:'10:00'}],fixedClass:r==='a/ageo-fujimi'?'前半':''}]))};
}
async function push(data, key='test-only-key', time=Date.now()){
 const body=JSON.stringify(data),timestamp=String(time);
 const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const sig=await crypto.subtle.sign('HMAC',k,new TextEncoder().encode('prospect-trial-config-push-v1\n'+timestamp+'\n'+body));
 const signature=Array.from(new Uint8Array(sig),b=>b.toString(16).padStart(2,'0')).join('');
 return exports.default.fetch('https://fixture.invalid/internal/trial-config',{method:'POST',headers:{'x-prospect-timestamp':timestamp,'x-prospect-signature':signature},body});
}
async function get(r=route){return exports.default.fetch('https://fixture.invalid/trial-config?route='+encodeURIComponent(r));}
it('all 30 venues use durable config and never fetch GAS/LINE, even after 30 days',async()=>{
 const data=bundle(Date.now()-30*86400000);expect((await push(data)).status).toBe(200);
 for(const r of routes){const response=await get(r),body=await response.json();expect(response.status).toBe(200);expect(body.dates).toEqual(data.byRoute[r].dates);expect(body.generatedAt).toBe(data.revision);expect(body.policyIssuedAt).toBeGreaterThan(data.revision);expect(body.availabilityProof.signature).toMatch(/^[a-f0-9]{64}$/);expect(response.headers.get('server-timing')).toContain('gas;dur=0');}
 expect(network).not.toHaveBeenCalled();
});
it('old HTML POST endpoint also uses config-only path; empty storage never falls back to GAS',async()=>{
 for(const method of ['GET','POST']){const url=method==='GET'?'trial-config?route='+route:'api/reservations/availability';const r=await exports.default.fetch('https://fixture.invalid/'+url,{method,...(method==='POST'?{body:JSON.stringify({route})}:{})});expect(r.status).toBe(503);}
 expect(network).not.toHaveBeenCalled();
});
it('wrong-key, old timestamp and incomplete pushes preserve last good config',async()=>{
 const good=bundle();expect((await push(good)).status).toBe(200);
 expect((await push(bundle(), 'wrong')).status).toBe(401);
 expect((await push(bundle(), 'test-only-key',Date.now()-600000)).status).toBe(401);
 const bad=bundle();delete bad.byRoute['a/ageo-fujimi'];expect((await push(bad)).status).toBe(400);
 expect((await(await get()).json()).classes[0].status).toBe('open');
});
it('replacement is atomic, older updates rejected, identical content advances ordering watermark',async()=>{
 const t=Date.now()-1000;expect((await push(bundle(t))).status).toBe(200);
 const first=await store().getTrialConfig(route);
 const same=await push(bundle(t+100));expect((await same.json()).unchanged).toBe(true);
 expect((await push(bundle(t+50,'closed'))).status).toBe(409);
 expect((await push(bundle(t+100,'closed'))).status).toBe(409);
 expect((await store().getTrialConfig(route)).updatedAt).toBe(first.updatedAt);
 expect((await push(bundle(t+200,'waitlist'))).status).toBe(200);
 for(const r of routes) expect((await(await get(r)).json()).classes[0].status).toBe('waitlist');
});
it('the issued policy carries the actual displayed date/status and bounded authorization',async()=>{
 expect((await push(bundle())).status).toBe(200);
 const body=await(await get()).json();const policy=JSON.parse(body.availabilityProof.payload);
 expect(policy.route).toBe(route);expect(policy.dates).toEqual(body.dates.map(d=>d.value));
 expect(policy.generatedAt).toBe(body.policyIssuedAt);expect(body.policyExpiresAt-policy.generatedAt).toBe(86400000);
});

it('Ageo Fujimi remains one slot and Muneoka Daini retains all three numbered classes',async()=>{
 const data=bundle();
 data.byRoute['a/ageo-fujimi'].classes.push({value:'後半',status:'open'});
 data.byRoute['c/muneoka-daini'].classes=['①クラス','②クラス','③クラス'].map((value,i)=>({value,status:['open','waitlist','closed'][i],time:'test'}));
 expect((await push(data)).status).toBe(200);
 const ageo=await(await get('a/ageo-fujimi')).json();expect(ageo.classes.map(c=>c.value)).toEqual(['前半']);expect(ageo.fixedClass).toBe('前半');
 const muneoka=await(await get('c/muneoka-daini')).json();expect(muneoka.classes.map(c=>c.value)).toEqual(['①クラス','②クラス','③クラス']);expect(muneoka.classes.map(c=>c.status)).toEqual(['open','waitlist','closed']);
});
