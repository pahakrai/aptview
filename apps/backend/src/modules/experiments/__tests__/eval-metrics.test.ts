import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chiSquareIndependence,
  chiSquarePValue,
  cohensD,
  editSimilarity,
  jaccardSimilarity,
  levenshteinDistance,
  meanCI,
  precisionRecallF1,
  regularizedIncompleteBeta,
  tokenize,
  twoProportionZTest,
  welchTTest,
} from '../eval-metrics.ts';

test('tokenize: lowercases and splits on non-alphanumeric', () => {
  assert.deepEqual(tokenize('Foo, BAR baz2!'), ['foo', 'bar', 'baz2']);
});

test('precisionRecallF1: exact overlap', () => {
  const r = precisionRecallF1('a b c', 'b c d');
  assert.ok(Math.abs(r.precision - 2 / 3) < 1e-9);
  assert.ok(Math.abs(r.recall - 2 / 3) < 1e-9);
  assert.ok(Math.abs(r.f1 - 2 / 3) < 1e-9);
});

test('precisionRecallF1: identical => 1, disjoint => 0', () => {
  assert.equal(precisionRecallF1('a b', 'a b').f1, 1);
  assert.equal(precisionRecallF1('a b', 'c d').f1, 0);
});

test('jaccardSimilarity', () => {
  assert.equal(jaccardSimilarity('a b', 'b c'), 1 / 3);
  assert.equal(jaccardSimilarity('a b', 'a b'), 1);
});

test('levenshteinDistance: kitten vs sitting = 3', () => {
  assert.equal(levenshteinDistance('kitten', 'sitting'), 3);
});

test('editSimilarity: kitten vs sitting ~ 0.571', () => {
  assert.ok(Math.abs(editSimilarity('kitten', 'sitting') - (1 - 3 / 7)) < 1e-9);
});

test('cohensD: [1,2,3] vs [4,5,6] = 3', () => {
  assert.ok(Math.abs(cohensD([1, 2, 3], [4, 5, 6]) - 3) < 1e-9);
});

test('welchTTest: [1..5] vs [6..10] -> large t, tiny p', () => {
  const r = welchTTest([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]);
  assert.ok(Math.abs(r.t - 5) < 1e-9);
  assert.ok(r.pValue < 0.01);
});

test('twoProportionZTest: 40/100 vs 60/100 -> z ~ 2.83, p < 0.01', () => {
  const r = twoProportionZTest(40, 100, 60, 100);
  assert.ok(Math.abs(r.z - 2.828) < 0.01);
  assert.ok(r.pValue < 0.01);
});

test('regularizedIncompleteBeta: I_0.5(1,1) = 0.5', () => {
  assert.ok(Math.abs(regularizedIncompleteBeta(1, 1, 0.5) - 0.5) < 1e-6);
});

test('meanCI: contains the mean and widens with fewer samples', () => {
  const [lo, hi] = meanCI([10, 12, 14, 16]);
  assert.ok(lo < 13 && 13 < hi);
});

test('chiSquareIndependence: equal rates -> no association (p ~ 1)', () => {
  const r = chiSquareIndependence(50, 100, 50, 100);
  assert.equal(r.valid, true);
  assert.equal(r.significant, false);
  assert.ok(r.pValue > 0.9);
});

test('chiSquareIndependence: 10/100 vs 40/100 -> significant association', () => {
  const r = chiSquareIndependence(10, 100, 40, 100);
  assert.equal(r.valid, true);
  assert.equal(r.significant, true);
  assert.ok(r.pValue < 0.001);
  assert.ok(r.chiSquare > 20);
});

test('chiSquareIndependence: sparse table -> invalid (expected < 5)', () => {
  const r = chiSquareIndependence(1, 2, 0, 2);
  assert.equal(r.valid, false);
  assert.equal(r.significant, false);
});

test('chiSquarePValue: chi2=0 -> p=1; chi2=10.83 -> p<0.001', () => {
  assert.equal(chiSquarePValue(0, 1), 1);
  assert.ok(chiSquarePValue(10.83, 1) < 0.001);
});
