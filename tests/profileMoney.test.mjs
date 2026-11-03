import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lkrToMinor } from '../src/lib/profileMoney.ts';
test('LKR profile rates preserve exact minor units and reject ambiguous input',()=>{
 assert.equal(lkrToMinor('45000'),4500000);assert.equal(lkrToMinor('123.45'),12345);assert.equal(lkrToMinor('0.1'),10);assert.equal(lkrToMinor('1000000.00'),100000000);
 for(const value of ['','1.005','-1','1e3','$450','1,000','NaN','Infinity','1000000.01'])assert.throws(()=>lkrToMinor(value));
});
