import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const config=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
test('TTL-based daily refresh is removed from production config',()=>assert.deepEqual(config.triggers.crons,[]));
