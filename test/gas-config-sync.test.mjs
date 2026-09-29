import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createHash,createHmac} from 'node:crypto';
const source=await readFile(new URL('../gas/TrialConfigSync.gs',import.meta.url),'utf8');
function fixture({signingKey='test-key',extra=[]}={}){
 const properties=new Map([['PROSPECT_TRIAL_CONFIG_URL','https://fixture.invalid/internal/trial-config'],['LINE_WEBHOOK_FORWARD_KEY','test-key'],...extra]);
 const state={version:1,reads:0,builds:0,pushes:0,fail:false,status:'open'};
 const ctx={console,Date,JSON,Math,Error,
  PROSPECT_LINE_MASTER:{spreadsheetId:'master'},PROSPECT_ACTIVITY_CALENDAR:{spreadsheetId:'calendar'},
  DriveApp:{getFileById(){return{getLastUpdated(){return new Date(state.version)}}}},
  LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties.get(k)||null,setProperty:(k,v)=>properties.set(k,v),setProperties:v=>Object.entries(v).forEach(([k,x])=>properties.set(k,x))})},
  Utilities:{Charset:{UTF_8:'utf8'},DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(_a,v)=>[...createHash('sha256').update(v).digest()],computeHmacSha256Signature:(v,k)=>[...createHmac('sha256',k).update(v).digest()]},
  UrlFetchApp:{fetch:(_url,options)=>{state.pushes++;assert.equal(options.followRedirects,false);assert.equal(options.headers['x-prospect-signature'],createHmac('sha256',signingKey).update('prospect-trial-config-push-v1\n'+options.headers['x-prospect-timestamp']+'\n'+options.payload).digest('hex'));return{getResponseCode:()=>state.fail?503:200,getContentText:()=>JSON.stringify({ok:!state.fail})}}},
 };
 vm.createContext(ctx);vm.runInContext(source,ctx);
 ctx.readProspectTrialSources_=()=>{state.reads++;return{classes:{route:[{status:state.status}]},months:[]}};
 ctx.buildProspectTrialConfig_=(_sources,revision)=>{state.builds++;return{schemaVersion:1,revision,byRoute:{}}};
 return{ctx,state,properties};
}
test('watchdog skips Sheets when metadata unchanged and skips rebuild when content unchanged',()=>{
 const {ctx,state}=fixture();ctx.watchProspectTrialConfig();ctx.watchProspectTrialConfig();
 assert.equal(state.reads,1);assert.equal(state.builds,1);assert.equal(state.pushes,1);
 state.version++;ctx.watchProspectTrialConfig();assert.equal(state.reads,2);assert.equal(state.builds,1);assert.equal(state.pushes,1);
 state.status='waitlist';state.version++;ctx.watchProspectTrialConfig();assert.equal(state.pushes,2);
});
test('failed push never acknowledges source change; watchdog retries until durable success',()=>{
 const {ctx,state,properties}=fixture();state.fail=true;assert.throws(()=>ctx.watchProspectTrialConfig());
 assert.equal(properties.has('TRIAL_CONFIG_SOURCE_HASH'),false);
 state.fail=false;ctx.watchProspectTrialConfig();assert.equal(state.pushes,2);assert.ok(properties.has('TRIAL_CONFIG_SOURCE_HASH'));
});
test('explicit resync can restore empty storage despite unchanged source',()=>{
 const {ctx,state}=fixture();ctx.syncProspectTrialConfig();ctx.syncProspectTrialConfig();assert.equal(state.pushes,2);
});
test('source changes during reading are not acknowledged or published',()=>{
 const {ctx,state,properties}=fixture();ctx.readProspectTrialSources_=()=>{state.version++;return{classes:{},months:[]}};
 assert.throws(()=>ctx.watchProspectTrialConfig(),/changed_during_read/);assert.equal(state.pushes,0);assert.equal(properties.has('TRIAL_CONFIG_SOURCE_HASH'),false);
});
test('heartbeat pushes unchanged content after 6h so the Worker can detect a broken sync',()=>{
 const {ctx,state,properties}=fixture();ctx.watchProspectTrialConfig();ctx.watchProspectTrialConfig();assert.equal(state.pushes,1);
 properties.set('TRIAL_CONFIG_LAST_PUSH_AT',String(Date.now()-6*3600000-1000));
 ctx.watchProspectTrialConfig();assert.equal(state.pushes,2);assert.ok(Number(properties.get('TRIAL_CONFIG_LAST_PUSH_AT'))>Date.now()-60000);
 ctx.watchProspectTrialConfig();assert.equal(state.pushes,2);
});
test('dedicated push key property takes precedence over the legacy forward key',()=>{
 const {ctx,state}=fixture({signingKey:'dedicated-key',extra:[['PROSPECT_TRIAL_CONFIG_PUSH_KEY','dedicated-key']]});
 ctx.syncProspectTrialConfig();assert.equal(state.pushes,1);
});
