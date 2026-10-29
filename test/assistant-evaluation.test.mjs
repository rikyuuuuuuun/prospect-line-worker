import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDraftRequest} from '../src/assistant-model.js';
import {validatePlan,reserveCost,usedCost,evaluate} from '../scripts/evaluate-assistant.mjs';
const entry={id:'fixture',model:'gpt-6.1-sol',input:{inquiry:'本日は欠席します。',examples:[],facts:{},intent:{category:'欠席'}}};
const plan={evaluationOnly:true,anonymousReviewed:true,usdLimit:1,entries:[entry]};
test('evaluation uses the production request contract and disables response storage',()=>{const payload=buildDraftRequest(entry.input,entry.model);assert.equal(payload.store,false);assert.equal(payload.service_tier,'default');assert.equal(payload.text.format.strict,true);assert.equal(payload.max_output_tokens,2048);assert.throws(()=>buildDraftRequest(entry.input,'unapproved'));});
test('evaluation rejects accidental live or identifying inputs and excessive cost',()=>{for(const bad of [{...plan,evaluationOnly:false},{...plan,anonymousReviewed:false},{...plan,usdLimit:2},{...plan,entries:[entry,entry]},{...plan,entries:[{...entry,input:{...entry.input,inquiry:'U'+'f'.repeat(32)}}]}])assert.throws(()=>validatePlan(bad));assert.ok(reserveCost(buildDraftRequest(entry.input,entry.model))<1);assert.equal(usedCost(entry.model,{input_tokens:1000,output_tokens:100}),.003);assert.equal(usedCost(entry.model,{total_tokens:1100}),null);});
test('evaluation dry run never calls an API and execute requires a key',async()=>{const fetcher=()=>{throw Error('must_not_call')};assert.equal((await evaluate(plan,'unused.json',{fetcher})).ready,true);await assert.rejects(evaluate(plan,'unused.json',{execute:true,key:'',fetcher}),/key_missing/);});
