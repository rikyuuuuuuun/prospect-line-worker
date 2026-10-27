import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { configDigest, verifyConfigPush, normalizeTrialConfig, currentTrialWindow, TRIAL_CONFIG_MAX_BYTES } from '../src/trial-config.js';

const workerSource=await readFile(new URL('../src/worker.js',import.meta.url),'utf8');
const source=workerSource.replace(/^import .*;\r?$/gm,'').replace(/^export \{.*;\r?$/gm,'').replace('export default {','globalThis.worker = {');
const legacyRoutes=[...workerSource.matchAll(/'([abcd]\/[^']+)'/g)].map(m=>m[1]);
const eRoute='e/tsurugashima-fuji';
test('E is present in the trial form without changing activity venue choices',async()=>{
  const coreSource=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
    .replace(/^export \{ ReservationOutbox \} from .*;\r?$/m,'')
    .replace(/export async function /g,'async function ')
    .replace('export default {','globalThis.core = {');
  const c=vm.createContext({console,TextEncoder});vm.runInContext(coreSource,c);
  assert.ok(c.buildReservationHtml_('fixture').includes('"e/tsurugashima-fuji"'));
  assert.equal(c.buildActivityApplicationHtml_('fixture').includes('"e/tsurugashima-fuji"'),false);
  assert.ok(c.buildActivityApplicationHtml_('fixture').includes('"b/tsurugashima-daiichi"'));
});
function setup() {
  let stored;
  const context=vm.createContext({console:{log(){},warn(){}},URL,Response,TextDecoder,Date,
    configDigest,verifyConfigPush,normalizeTrialConfig,currentTrialWindow,TRIAL_CONFIG_MAX_BYTES,
    deliverTrialConfig_:async(_env,_route,record,dates)=>({...record.config,dates}),
  });
  vm.runInContext(source,context);
  const ctx={exports:{AvailabilitySnapshot:{getByName:()=>({
    putTrialConfig:async(bundle,digest)=>{stored={...bundle,digest};return{ok:true}},
    getTrialConfig:async(route)=>stored?.byRoute[route]?{config:stored.byRoute[route]}:null,
  })}}};
  return {ctx,worker:context.worker,get stored(){return stored}};
}
function bundle() {
  return {schemaVersion:1,revision:Date.now(),byRoute:Object.fromEntries(legacyRoutes.map(r=>[r,{
    dates:[],classes:[{value:'前半',status:'open'}],fixedClass:'',
  }]))};
}
async function push(h,data) {
  const body=JSON.stringify(data),timestamp=String(Date.now()),encoder=new TextEncoder();
  const key=await crypto.subtle.importKey('raw',encoder.encode('fixture-key'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode('prospect-trial-config-push-v1\n'+timestamp+'\n'+body))),b=>b.toString(16).padStart(2,'0')).join('');
  return h.worker.fetch(new Request('https://fixture.invalid/internal/trial-config',{method:'POST',body,
    headers:{'x-prospect-timestamp':timestamp,'x-prospect-signature':signature}}),{GAS_FORWARD_KEY:'fixture-key'},h.ctx);
}
test('old 30-venue producer stays valid and always resets E to an empty closed configuration',async()=>{
  const h=setup();assert.equal(legacyRoutes.length,30);
  assert.equal((await push(h,bundle())).status,200);
  assert.equal(Object.keys(h.stored.byRoute).length,31);
  assert.deepEqual(Array.from(h.stored.byRoute[eRoute].classes,c=>[c.value,c.status]),[['前半','closed'],['後半','closed']]);
  assert.deepEqual(Array.from(h.stored.byRoute[eRoute].dates),[]);
  const data=bundle();data.byRoute[eRoute]={dates:[],classes:[{value:'前半',status:'open',time:'17:00〜17:50'},{value:'後半',status:'open',time:'18:00〜18:50'}]};
  assert.equal((await push(h,data)).status,200);
  assert.deepEqual(Array.from(h.stored.byRoute[eRoute].classes,c=>c.time),['17:00〜17:50','18:00〜18:50']);
  assert.equal((await push(h,bundle())).status,200);
  assert.ok(h.stored.byRoute[eRoute].classes.every(c=>c.status==='closed'));
});
test('E onboarding never permits incomplete existing venues, unknown routes or malformed E settings',async()=>{
  for(const mutate of [
    d=>{delete d.byRoute['a/sugishita']},
    d=>{d.byRoute['e/unknown']={dates:[],classes:[{value:'前半',status:'open'}]}},
    d=>{d.byRoute[eRoute]={dates:[],classes:[{value:'前半',status:'invalid'}]}},
    d=>{d.byRoute='malformed'},
  ]) {
    const h=setup(),data=bundle();mutate(data);
    assert.equal((await push(h,data)).status,400);assert.equal(h.stored,undefined);
  }
});
