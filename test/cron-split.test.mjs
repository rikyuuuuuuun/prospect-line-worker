import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const wrangler=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
const worker=await readFile(new URL('../src/worker.js',import.meta.url),'utf8');

test('daily availability preload is split across four 03:00 JST team crons',()=>{
  assert.deepEqual(wrangler.triggers.crons,[
    '0 18 * * *','2 18 * * *','4 18 * * *','6 18 * * *'
  ]);
  assert.ok(worker.includes("'0 18 * * *': 'A'"));
  assert.ok(worker.includes("'2 18 * * *': 'B'"));
  assert.ok(worker.includes("'4 18 * * *': 'C'"));
  assert.ok(worker.includes("'6 18 * * *': 'D'"));
  assert.equal(worker.includes("'*/4 * * * *'"),false);
  assert.equal(worker.includes("'1-59/4 * * * *'"),false);
  assert.equal(worker.includes("'2-59/4 * * * *'"),false);
  assert.equal(worker.includes("'3-59/4 * * * *'"),false);
});

test('each team cron stays on a bounded venue batch',()=>{
  const routes=[...worker.matchAll(/'([abcd]\/[^']+)'/g)].map(match=>match[1]);
  const unique=[...new Set(routes)];
  const counts={};
  for(const route of unique){
    const team=route[0].toUpperCase();
    counts[team]=(counts[team]||0)+1;
  }
  assert.deepEqual(counts,{A:7,B:7,C:8,D:8});
  assert.ok(Math.max(...Object.values(counts))<=8);
});
