import test from 'node:test';
import assert from 'node:assert/strict';
import {currentTrialWindow,normalizeTrialConfig} from '../src/trial-config.js';
test('JST midnight drops yesterday and bounds current+next calendar month',()=>{
const dates=['2026-09-20','2026-09-21','2026-10-31','2026-11-01'].map(value=>({value}));
assert.deepEqual(currentTrialWindow(dates,Date.parse('2026-09-20T15:00:00Z')).map(d=>d.value),['2026-09-21','2026-10-31']);
});
test('month/year rollover uses already stored calendar data',()=>{
const dates=['2026-12-31','2027-01-01','2027-02-01','2027-03-01'].map(value=>({value}));
assert.deepEqual(currentTrialWindow(dates,Date.parse('2026-12-31T15:00:00Z')).map(d=>d.value),['2027-01-01','2027-02-01']);
});
test('invalid, incomplete, duplicate and private fields cannot become public config',()=>{
const now=Date.now();const input={schemaVersion:1,revision:now,byRoute:{a:{dates:[{value:'2026-10-01',label:'test'}],classes:[{value:'前半',status:'open'}],lineUserId:'private'}}};
assert.equal(normalizeTrialConfig(input,['a']).byRoute.a.lineUserId,undefined);
assert.throws(()=>normalizeTrialConfig(input,['a','b']));
input.byRoute.a.dates[0].value='2026-02-30';assert.throws(()=>normalizeTrialConfig(input,['a']));
});
