/**
 * experiment-stats.spec.ts — unit tests for the pure A/B statistics module.
 *
 * Pure functions only: no database, no Nest runtime, no jest infra required.
 * Runs with Node's native test runner (Node ≥ 23.6, type stripping):
 *
 *   node --test apps/backend/src/modules/experiments/__tests__/experiment-stats.spec.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clamp01,
  composeScore,
  costUsdOf,
  decisionToAccepted,
  deltaVerdict,
  hashBucket,
  normCI,
  selectWinner,
  wilsonCI,
} from '../experiment-stats.ts';
import type { CandidateArm } from '../experiment-stats.ts';

const W = { accuracy: 0.35, quality: 0.35, acceptance: 0.15, speed: 0.075, cost: 0.075 };

test('hashBucket is deterministic for the same key', () => {
  assert.equal(hashBucket('acme/core:42'), hashBucket('acme/core:42'));
});

test('hashBucket always returns 0..99', () => {
  for (let i = 0; i < 500; i += 1) {
    const b = hashBucket(`org/repo:pr-${i}`);
    assert.ok(b >= 0 && b < 100, `bucket ${b} out of range`);
  }
});

test('hashBucket spreads different keys (sanity, not proof)', () => {
  const keys = ['a:1', 'a:2', 'b:1', 'c:1', 'd:1', 'e:1', 'f:1', 'g:1'];
  const buckets = new Set(keys.map((k) => hashBucket(k)));
  assert.ok(buckets.size > 1);
});

test('costUsdOf computes USD for a known model', () => {
  // deepseek-v4-flash: $0.10 input / $0.30 output per 1M tokens
  assert.ok(Math.abs(costUsdOf('deepseek-v4-flash', 1_000_000, 500_000)! - 0.25) < 1e-6);
});

test('costUsdOf returns null for an unknown model — unknown ≠ free', () => {
  assert.equal(costUsdOf('some-unknown-model', 1000, 500), null);
});

test('decisionToAccepted: approve → true, revise → false, cancel → null', () => {
  assert.equal(decisionToAccepted('approve'), true);
  assert.equal(decisionToAccepted('revise'), false);
  assert.equal(decisionToAccepted('cancel'), null);
});

test('wilsonCI returns null with no trials', () => {
  assert.equal(wilsonCI(0, 0), null);
});

test('wilsonCI matches the known interval for 9/10', () => {
  const [lo, hi] = wilsonCI(9, 10)!;
  assert.ok(Math.abs(lo - 0.596) < 0.005);
  assert.ok(Math.abs(hi - 0.982) < 0.005);
});

test('normCI returns null with fewer than 2 observations', () => {
  assert.equal(normCI([5]), null);
  assert.equal(normCI([]), null);
});

test('normCI computes mean ± 1.96·sd/√n', () => {
  const [lo, hi] = normCI([10, 12, 14, 16])!;
  assert.ok(Math.abs(lo - 10.47) < 0.05);
  assert.ok(Math.abs(hi - 15.53) < 0.05);
});

test('deltaVerdict: better / worse / inconclusive at 95%', () => {
  assert.equal(deltaVerdict(2, 0.5), 'better');
  assert.equal(deltaVerdict(-2, 0.5), 'worse');
  assert.equal(deltaVerdict(0.5, 0.5), 'inconclusive');
});

test('composeScore renormalizes over available sub-scores (missing acceptance)', () => {
  const c = composeScore(
    { accuracy: 100, quality: 50, acceptance: null, speed: 100, cost: 100 },
    W,
  );
  // (35 + 17.5 + 7.5 + 7.5) / 0.85
  assert.ok(c !== null && Math.abs(c - 79.41) < 0.01);
});

test('composeScore passes through a single available sub-score', () => {
  const c = composeScore(
    { accuracy: 80, quality: null, acceptance: null, speed: null, cost: null },
    W,
  );
  assert.ok(c !== null && Math.abs(c - 80) < 1e-6);
});

test('composeScore returns null when nothing has data', () => {
  assert.equal(
    composeScore(
      { accuracy: null, quality: null, acceptance: null, speed: null, cost: null },
      W,
    ),
    null,
  );
});

test('clamp01 clamps into [0,1]', () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(0.5), 0.5);
});

// ---------------------------------------------------------------------------
// selectWinner — the decision-critical logic
// ---------------------------------------------------------------------------

const arm = (over: Partial<CandidateArm>): CandidateArm => ({
  variantId: 'treatment-1',
  vendor: 'deepseek',
  modelId: 'deepseek-v4-flash',
  composite: 80,
  samples: 60,
  minSampleReached: true,
  vsControl: { compositeDelta: 3, compositeVerdict: 'better' },
  ...over,
});

test('selectWinner returns null when no treatment is significantly better', () => {
  const arms = [
    arm({ vsControl: { compositeDelta: 2, compositeVerdict: 'inconclusive' } }),
    arm({ variantId: 'control', vsControl: null }),
  ];
  assert.equal(selectWinner(arms), null);
});

test('selectWinner ignores arms below the sample target', () => {
  const arms = [
    arm({ composite: 99, minSampleReached: false }),
    arm({ composite: 80, minSampleReached: true }),
  ];
  const w = selectWinner(arms);
  assert.equal(w?.variantId, 'treatment-1');
  assert.equal(w?.composite, 80);
});

test('selectWinner picks highest composite among significantly-better treatments', () => {
  const arms = [
    arm({ variantId: 't-a', composite: 82 }),
    arm({ variantId: 't-b', composite: 91 }),
    arm({
      variantId: 't-c',
      composite: 90,
      vsControl: { compositeDelta: 1, compositeVerdict: 'inconclusive' },
    }),
    arm({ variantId: 'control', vsControl: null }),
  ];
  const w = selectWinner(arms);
  assert.equal(w?.variantId, 't-b');
  assert.equal(w?.composite, 91);
  assert.equal(w?.compositeVerdict, 'better');
});

test('selectWinner never picks control (vsControl null)', () => {
  const arms = [
    arm({ variantId: 'control', composite: 99, vsControl: null }),
    arm({ composite: 70 }),
  ];
  const w = selectWinner(arms);
  assert.equal(w?.variantId, 'treatment-1');
});
