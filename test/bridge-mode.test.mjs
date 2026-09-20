import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../src/worker.js',import.meta.url),'utf8')).replace(/^import .*;$/gm,'').replace(/^export \{.*;$/gm,'').replace('export default {','globalThis.worker={');
test('explicit bridge serves the legacy POST while new GET remains available for bootstrap verification',async()=>{
 let legacyCalls=0;
 const c={Response,Request,Headers,URL,TextDecoder,Date,console,core:{fetch(){throw Error('unexpected core')}},legacyAvailability:{fetch:async()=>{legacyCalls++;return new Response('legacy')}}};
 vm.createContext(c);vm.runInContext(source,c);
 const env={TRIAL_CONFIG_BRIDGE_ONLY:'true'},ctx={exports:{AvailabilitySnapshot:{getByName:()=>({getTrialConfig:async()=>null})}}};
 const post=await c.worker.fetch(new Request('https://fixture.invalid/api/reservations/availability',{method:'POST'}),env,ctx);assert.equal(await post.text(),'legacy');
 const get=await c.worker.fetch(new Request('https://fixture.invalid/trial-config?route=b/tsuruse'),env,ctx);assert.equal(get.status,503);assert.equal(legacyCalls,1);
});
