// Opt-in local evaluation. Datasets and results must stay outside the public repository.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {buildDraftRequest,MODEL_PRICES} from '../src/assistant-model.js';
import {extractResponseText} from '../src/assistant-policy.js';
import {inspectReply} from '../src/assistant-learning.js';

export function reserveCost(payload){return (Buffer.byteLength(JSON.stringify(payload))+payload.max_output_tokens+1024)*Math.max(...Object.values(MODEL_PRICES[payload.model]))/1e6;}
export function usedCost(model,usage){
  if(!Number.isSafeInteger(usage?.input_tokens)||usage.input_tokens<0||!Number.isSafeInteger(usage?.output_tokens)||usage.output_tokens<0)return null;
  const price=MODEL_PRICES[model];return (usage.input_tokens*price.input+usage.output_tokens*price.output)/1e6;
}
export function validatePlan(plan){
  if(plan.evaluationOnly!==true||plan.anonymousReviewed!==true||!Array.isArray(plan.entries)||!plan.entries.length||plan.entries.length>12)throw Error('invalid_evaluation_plan');
  if(!Number.isFinite(plan.usdLimit)||plan.usdLimit<=0||plan.usdLimit>1)throw Error('invalid_evaluation_limit');
  const ids=new Set();
  for(const e of plan.entries){
    if(typeof e.id!=='string'||ids.has(e.id))throw Error('duplicate_evaluation_id');ids.add(e.id);
    const payload=buildDraftRequest(e.input,e.model),text=JSON.stringify(e.input);
    if(/U[0-9a-f]{32}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text))throw Error('identifying_data_in_evaluation');
    if(reserveCost(payload)>plan.usdLimit)throw Error('evaluation_request_exceeds_budget');
  }
  return plan;
}
export function textMetrics(text){return {length:[...text].length,lines:text.split('\n').length,exclamations:(text.match(/！|!/g)||[]).length,emoji:(text.match(/\p{Extended_Pictographic}/gu)||[]).length,greeting:/^(?:こんにちは|こんばんは|おはようございます)/.test(text),acknowledgement:/承知(?:いた|致)しました/.test(text)};}
function editRatio(a,b){const x=[...a],y=[...b];let prev=Array.from({length:y.length+1},(_,i)=>i);for(let i=1;i<=x.length;i++){const next=[i];for(let j=1;j<=y.length;j++)next[j]=Math.min(next[j-1]+1,prev[j]+1,prev[j-1]+(x[i-1]===y[j-1]?0:1));prev=next;}return Number((prev[y.length]/Math.max(1,x.length,y.length)).toFixed(3));}
const hash=text=>createHash('sha256').update(text).digest('hex');
export async function evaluate(plan,output,{execute=false,fetcher=fetch,key=process.env.OPENAI_API_KEY}={}){
  validatePlan(plan);const planHash=hash(JSON.stringify(plan));
  if(!execute)return {ready:true,entries:plan.entries.length,usdLimit:plan.usdLimit,maxRequestReservation:Math.max(...plan.entries.map(e=>reserveCost(buildDraftRequest(e.input,e.model))))};
  if(!key||!/^sk-/.test(key))throw Error('evaluation_api_key_missing');
  let ledger={evaluationOnly:true,planHash,startedAt:new Date().toISOString(),usdLimit:plan.usdLimit,chargedOrReservedUsd:0,results:[]};
  try {ledger=JSON.parse(await readFile(output,'utf8'));if(ledger.planHash!==planHash)throw Error('evaluation_plan_changed');} catch(e){if(e.code!=='ENOENT')throw e;}
  await mkdir(dirname(output),{recursive:true});
  const save=()=>writeFile(output,JSON.stringify(ledger,null,2)+'\n');
  for(const entry of plan.entries){
    const prior=ledger.results.find(r=>r.id===entry.id);if(prior){if(prior.status!=='completed'||prior.usageUnknown)throw Error('evaluation_prior_request_unresolved');continue;}
    const payload=buildDraftRequest(entry.input,entry.model),reserved=reserveCost(payload);
    if(ledger.chargedOrReservedUsd+reserved>plan.usdLimit)throw Error('evaluation_budget_reached');
    const result={id:entry.id,label:entry.label,mode:entry.mode,model:entry.model,status:'reserved',reservedUsd:reserved,requestHash:hash(JSON.stringify(payload)),inquiry:entry.input.inquiry,referenceIds:entry.input.examples.map(e=>e.id),reference:entry.expectedReply||null,expectations:entry.expectations||[],startedAt:new Date().toISOString()};
    ledger.results.push(result);ledger.chargedOrReservedUsd+=reserved;await save();
    const started=Date.now();
    try {
      const response=await fetcher('https://api.openai.com/v1/responses',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(45000)});
      result.httpStatus=response.status;result.requestId=response.headers.get('x-request-id');
      if(!response.ok){await response.body?.cancel();throw Error('evaluation_http_'+response.status);}
      const data=await response.json(),cost=usedCost(entry.model,data.usage);
      if(cost!==null){ledger.chargedOrReservedUsd+=cost-reserved;result.estimatedUsd=cost;result.usage=data.usage;}
      if(data.status!=='completed')throw Error('evaluation_model_incomplete');
      const parsed=JSON.parse(extractResponseText(data));if(typeof parsed.reply!=='string'||!Array.isArray(parsed.checks)||!Array.isArray(parsed.templateIds))throw Error('evaluation_output_invalid');
      result.status='completed';result.reply=parsed.reply;result.checks=parsed.checks;result.templateIds=parsed.templateIds;
      result.inspection=inspectReply(parsed.reply,entry.input.facts,{category:entry.input.intent.category});
      result.metrics=textMetrics(parsed.reply);if(entry.expectedReply){result.referenceMetrics=textMetrics(entry.expectedReply);result.editRatio=editRatio(entry.expectedReply,parsed.reply);}
      result.elapsedMs=Date.now()-started;result.responseModel=data.model;result.completedAt=new Date().toISOString();
      if(cost===null){result.usageUnknown=true;await save();throw Error('evaluation_usage_unknown');}
      await save();console.log('completed '+entry.id);
    } catch(error){
      result.status=result.status==='completed'?result.status:'failed';result.error=/^evaluation_[a-z0-9_]+$/.test(error.message)?error.message:'evaluation_request_failed';result.elapsedMs=Date.now()-started;await save();throw Error(result.error);
    }
  }
  ledger.completedAt=new Date().toISOString();await save();return {completed:ledger.results.filter(r=>r.status==='completed').length,estimatedUsd:ledger.chargedOrReservedUsd,output};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try {const args=process.argv.slice(2),value=name=>args[args.indexOf(name)+1];if(!args.includes('--plan')||!args.includes('--output'))throw Error('evaluation_arguments_required');const plan=JSON.parse(await readFile(value('--plan'),'utf8'));console.log(JSON.stringify(await evaluate(plan,resolve(value('--output')),{execute:args.includes('--execute')})));}
  catch(error){console.error(/^evaluation_|^invalid_|^duplicate_|^identifying_|^model_/.test(error.message)?error.message:'evaluation_failed');process.exitCode=1;}
}
