/**
 * experiment-ranking.spec.ts — unit tests for ranking normalization + blending.
 * Run: node --test apps/backend/src/modules/experiments/__tests__/experiment-ranking.spec.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  blendFinalScore,
  normalizeRankScore,
  normalizeRankings,
  pickHighestScore,
} from '../experiment-ranking.ts';

test('normalizeRankScore: best rank is 100, worst is 0', () => {
  assert.equal(normalizeRankScore(1, 3), 100);
  assert.equal(normalizeRankScore(2, 3), 50);
  assert.equal(normalizeRankScore(3, 3), 0);
});

test('normalizeRankScore: single item is 100', () => {
  assert.equal(normalizeRankScore(1, 1), 100);
});

test('normalizeRankScore: clamps out-of-range ranks', () => {
  assert.equal(normalizeRankScore(0, 3), 100); // below range -> best
  assert.equal(normalizeRankScore(9, 3), 0);   // above range -> worst
});

test('normalizeRankings: builds a 0..100 vector', () => {
  const v = normalizeRankings([
    { variantId: 'control', rank: 1 },
    { variantId: 'treatment-1', rank: 2 },
    { variantId: 'treatment-2', rank: 3 },
  ]);
  assert.equal(v[0].rankScore, 100);
  assert.equal(v[1].rankScore, 50);
  assert.equal(v[2].rankScore, 0);
});

test('blendFinalScore: weights ranking vs composite', () => {
  // 80 composite, 60 ranking, 0.25 ranking weight => 80*0.75 + 60*0.25 = 75
  assert.ok(Math.abs((blendFinalScore(80, 60, 0.25) as number) - 75) < 1e-9);
});

test('blendFinalScore: falls back when one signal is missing', () => {
  assert.equal(blendFinalScore(null, 60, 0.25), 60);
  assert.equal(blendFinalScore(80, null, 0.25), 80);
  assert.equal(blendFinalScore(null, null, 0.25), null);
});

test('blendFinalScore: clamps ranking weight', () => {
  assert.equal(blendFinalScore(80, 60, 2) as number, 60); // w clamped to 1
  assert.equal(blendFinalScore(80, 60, -1) as number, 80); // w clamped to 0
});

test('pickHighestScore: highest final score wins', () => {
  const winner = pickHighestScore([
    { variantId: 'control', vendor: 'deepseek', modelId: 'v4-pro', finalScore: 70 },
    { variantId: 'treatment-1', vendor: 'deepseek', modelId: 'v4-flash', finalScore: 85 },
    { variantId: 'treatment-2', vendor: 'deepseek', modelId: 'reasoner', finalScore: null },
  ]);
  assert.equal(winner?.variantId, 'treatment-1');
});

test('pickHighestScore: returns null when all missing', () => {
  assert.equal(
    pickHighestScore([{ variantId: 'control', vendor: 'd', modelId: 'm', finalScore: null }]),
    null,
  );
});
