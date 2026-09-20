import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const original=await readFile(new URL('../src/index.js',import.meta.url),'utf8');
const source=original.replace(/^export \{ ReservationOutbox \} from .*;$/m,'').replace('export async function buildReservationAvailabilitySnapshot_','async function buildReservationAvailabilitySnapshot_').replace(/export async function /g, 'async function ').replace('export default {','globalThis.worker = {');
function context(fetch){const logs=[];const c={console:{log:x=>logs.push(JSON.parse(x)),warn(){},error(){}},fetch,Request,Response,Headers,URL,URLSearchParams,TextEncoder,TextDecoder,AbortController,setTimeout,clearTimeout,Date,crypto:globalThis.crypto};vm.createContext(c);vm.runInContext(source,c);return {c,logs};}
test('GAS timing counts transient retry and includes response body without logging request data',async()=>{
 let calls=0;const {c,logs}=context(async()=>{calls++;if(calls===1)return new Response('temporary',{status:503});return Response.json({ok:true,generatedAt:Date.now(),dates:[],classes:[{value:'前半',status:'open'}]});});
 const r=await c.worker.fetch(new Request('https://fixture.invalid/api/reservations/availability',{method:'POST',body:JSON.stringify({route:'b/tsuruse'})}),{GAS_WEBHOOK_URL:'https://gas.invalid/exec',GAS_FORWARD_KEY:'never-log-this'},{});
 assert.equal(r.status,200);assert.equal(calls,2);assert.match(r.headers.get('server-timing'),/gas;dur=\d+/);assert.equal(logs[0].gasAttempts,2);assert.doesNotMatch(JSON.stringify(logs),/never-log-this|gas.invalid/);
});
test('LINE verification failure still returns timing and never logs token',async()=>{
 const {c,logs}=context(async()=>new Response('',{status:401}));
 const r=await c.worker.fetch(new Request('https://fixture.invalid/api/reservations/session',{method:'POST',body:JSON.stringify({route:'b/tsuruse',idToken:'private-token'})}),{LINE_LOGIN_CHANNEL_ID:'test'},{});
 assert.notEqual(r.status,200);assert.match(r.headers.get('server-timing'),/line_verify;dur=\d+, session;dur=\d+/);assert.doesNotMatch(JSON.stringify(logs),/private-token/);
});
test('browser instrumentation contains no automatic telemetry transmission',()=>{
 const start=original.indexOf('  function markPhase(name)');const end=original.indexOf('  function setStatus',start);const code=original.slice(start,end);
 assert.ok(code.includes('prospectReservationPerformance'));assert.doesNotMatch(code,/sendBeacon|fetch\(|localStorage|idToken|identityProof/);
});
