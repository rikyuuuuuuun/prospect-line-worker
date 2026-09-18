import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const wrangler=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
const worker=await readFile(new URL('../src/worker.js',import.meta.url),'utf8');

test('daily availability preload keeps one 03:00 JST cron',()=>{
  assert.deepEqual(wrangler.triggers.crons,['0 18 * * *']);
  assert.ok(worker.includes("cron !== '0 18 * * *'"));
});

test('cron delegates all 30 venues to durable object RPC instead of direct GAS reads',()=>{
  const routes=[...worker.matchAll(/'([abcd]\/[^']+)'/g)].map(match=>match[1]);
  const unique=[...new Set(routes)];
  const counts={};
  for(const route of unique){
    const team=route[0].toUpperCase();
    counts[team]=(counts[team]||0)+1;
  }
  assert.deepEqual(counts,{A:7,B:7,C:8,D:8});
  assert.equal(unique.length,30);
  assert.ok(worker.includes('await object.refresh(routeKey)'));
  assert.equal(worker.includes('refresh-' + "' + refreshDate + '"),false);
});
