// Local source-code/happy-dom benchmark. NOT real LINE/navigation latency.
// node scripts/benchmark-startup.mjs <baseline-repository> <output.json>
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {performance} from 'node:perf_hooks';
import {Window} from 'happy-dom';
import * as configFunctions from '../src/trial-config.js';
const baseline=path.resolve(process.argv[2]);
const current=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const quiet={log(){},warn(){},error(){}};
const env={GAS_FORWARD_KEY:'benchmark-only-key',GAS_WEBHOOK_URL:'https://fixture.invalid/gas'};
const route='b/tsuruse';
async function server(root,mode){
 const index=(await fs.readFile(path.join(root,'src/index.js'),'utf8')).replace(/^export \{ ReservationOutbox \} from .*;$/m,'').replace(/export async function /g,'async function ').replace('export default {','globalThis.worker={');
 const c={console:quiet,Request,Response,URL,URLSearchParams,Headers,TextEncoder,TextDecoder,AbortController,setTimeout,clearTimeout,Date,crypto:globalThis.crypto};
 vm.createContext(c);vm.runInContext(index,c);
 const config={dates:[{value:new Date(Date.now()+9*3600000).toISOString().slice(0,10),label:'fixture'}],classes:[{value:'前半',status:'open',label:'前半',time:''}],fixedClass:''};
 let gasCalls=0;
 c.forwardAvailabilityToGas_=async()=>{gasCalls++;await delay(6000);if(mode==='outage')throw Error('gas_timeout');return {ok:true,...config,generatedAt:Date.now()}};
 let daily=null;
 if(root===baseline && mode==='warm'){
   const payload={ok:true,...config,generatedAt:Date.now()};
   daily=JSON.stringify({...payload,availabilityProof:await c.signReservationPolicy_(env,route,payload),policyExpiresAt:payload.generatedAt+86400000});
 }
 gasCalls=0;
 const object={get:async()=>{await delay(10);return daily?{body:daily,policyExpiresAt:Date.now()+3600000}:null},put:async()=>{},getTrialConfig:async()=>{await delay(10);return{config,revision:Date.now()-30*86400000,digest:'fixture'}}};
 const wrapper=(await fs.readFile(path.join(root,'src/worker.js'),'utf8')).replace(/^import .*;$/gm,'').replace(/^export \{.*;$/gm,'').replace('export default {','globalThis.outer={');
 Object.assign(c,{core:c.worker,...configFunctions});vm.runInContext(wrapper,c);
 return {c,ctx:{exports:{AvailabilitySnapshot:{getByName:()=>object}},waitUntil:p=>p.catch(()=>{})},gasCalls:()=>gasCalls};
}
async function sample(root,mode){
 const s=await server(root,mode);
 const start=performance.now();
 const html=await(await s.c.outer.fetch(new Request('https://fixture.invalid/reserve?route='+route),{...env,LIFF_ID:'fixture'},s.ctx)).text();
 const htmlMs=performance.now()-start;
 const dom=new Window({url:'https://fixture.invalid/reserve?route='+route,settings:{disableJavaScriptEvaluation:true,disableJavaScriptFileLoading:true,disableCSSFileLoading:true}});
 dom.document.write(html);
 const apis=[];const p={mark(){},measure(){},getEntriesByName:()=>[],getEntriesByType:()=>[],now:()=>performance.now()-start};
 const b={document:dom.document,location:new URL(dom.location.href),URL,URLSearchParams,AbortController,crypto:globalThis.crypto,console:quiet,performance:p,setTimeout,clearTimeout,
  sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},addEventListener:dom.addEventListener.bind(dom),
  liff:{init:()=>delay(900),isInClient:()=>true,isLoggedIn:()=>true,getContext:()=>({type:'utou'}),getIDToken:()=>'test',permission:{query:async()=>({state:'granted'})}},
  fetch:async(url,options)=>{const at=performance.now();if(url==='/api/reservations/session')return Response.json({ok:true,identityProof:{payload:'test',signature:'test'},expiresAt:Date.now()+900000});
    const response=await s.c.outer.fetch(new Request('https://fixture.invalid'+url,options),env,s.ctx);apis.push(performance.now()-at);return response;}
 };
 b.window=b;vm.createContext(b);vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],b);
 const firstUiMs=performance.now()-start;
 let choicesMs=null,enabledMs=null;
 for(let n=0;n<1000;n++){await delay(10);if(choicesMs===null&&!dom.document.getElementById('className').disabled)choicesMs=performance.now()-start;
  if(!dom.document.getElementById('submitButton').disabled){enabledMs=performance.now()-start;break;}
  if(apis.length && mode==='outage' && root===baseline)break;
 }
 await dom.happyDOM.abort();
 return {htmlMs,firstUiMs,choicesMs,enabledMs,apiMs:apis[0],gasCalls:s.gasCalls()};
}
const results={environment:'Node VM + happy-dom; real source paths; synthetic GAS=6000ms, DO=10ms, LIFF init=900ms; no real navigation/LINE/Cloudflare cold start',samples:[]};
for(const mode of ['cold','warm','outage'])for(const [version,root] of [['before',baseline],['after',current]]){
 const rows=[];for(let i=0;i<(mode==='outage'?1:3);i++)rows.push(await sample(root,mode));
 const median=key=>{const values=rows.map(r=>r[key]).filter(x=>typeof x==='number').sort((a,b)=>a-b);return values.length?Math.round(values[Math.floor(values.length/2)]*10)/10:null;};
 const summary={version,mode,n:rows.length,medianMs:Object.fromEntries(['htmlMs','firstUiMs','choicesMs','enabledMs','apiMs'].map(k=>[k,median(k)])),gasCalls:rows.map(r=>r.gasCalls),rows};results.samples.push(summary);console.log(JSON.stringify(summary));
}
await fs.writeFile(process.argv[3]||'benchmark-results.json',JSON.stringify(results,null,2)+'\n');
