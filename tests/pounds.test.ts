import assert from 'node:assert/strict';
import { test } from 'node:test';
import { poundsFromRiyals } from '../src/lib/pounds';

test('the workspace displays £20 for SAR 100 and rounds to the nearest penny', () => {
  assert.equal(poundsFromRiyals(10000), 2000);
  assert.equal(poundsFromRiyals(-10000), -2000);
  assert.equal(poundsFromRiyals(3), 1);
  assert.equal(poundsFromRiyals(-2), 0);
});
