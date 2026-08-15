/**
 * experiment-stats.ts — pure, dependency-free statistics for A/B experiment
 * reporting. Kept separate from ExperimentsService so the math can be unit
 * tested without a database connection.
 */

import type { MetricsWeights, ReviewDecisionAction } from '@aigov/shared-types';

/**
 * Stage-1 pricing ($ per 1M tokens, input/output). Swap for a live pricing
 * table before treating cost as authoritative.
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'deepseek-v4-pro': { input: 0.4, output: 1.1 },
  'deepseek-v4-flash': { input: 0.1, output: 0.3 },
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-2.0-pro': { input: 1.25, output: 5 },
};

/**
 * Cost of one run in USD, or null when the model is not in the pricing table.
 * A null cost means "unknown", which is different from "free": unknown-model
 * runs must not silently score a perfect cost sub-score.
 */
export function costUsdOf(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const price = MODEL_PRICING[modelId];
  if (!price) return null;
  return (promptTokens * price.input + completionTokens * price.output) / 1_000_000;
}

/** Deterministic FNV-1a hash → 0..99 for stable, reproducible bucketing. */
export function hashBucket(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // h is a signed 32-bit int; Math.abs on a double is always safe here.
  return Math.abs(h) % 100;
}

/** Map a human decision to the `humanAccepted` boolean (null = no judgment). */
export function decisionToAccepted(action: ReviewDecisionAction): boolean | null {
  if (action === 'approve') return true;
  if (action === 'revise') return false;
  return null;
}

/** Clamp a value into [0, 1]. */
export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * Weighted composite (0–100) over the available sub-scores. Weights are
 * renormalized over the components that actually have data, so a missing
 * signal (e.g. no human decisions yet) doesn't zero out the score.
 */
export function composeScore(
  subs: Record<'accuracy' | 'quality' | 'acceptance' | 'speed' | 'cost', number | null>,
  weights: MetricsWeights,
): number | null {
  let numerator = 0;
  let denominator = 0;
  for (const key of ['accuracy', 'quality', 'acceptance', 'speed', 'cost'] as const) {
    const value = subs[key];
    const weight = weights[key] ?? 0;
    if (value === null || value === undefined || !Number.isFinite(value) || weight <= 0) {
      continue;
    }
    numerator += value * weight;
    denominator += weight;
  }
  return denominator > 0 ? numerator / denominator : null;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function sd(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values) as number;
  const variance =
    values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Normal-approx 95% CI for a mean, or null with <2 observations. */
export function normCI(values: number[]): [number, number] | null {
  const m = mean(values);
  const s = sd(values);
  if (m === null || s === null) return null;
  const margin = (1.96 * s) / Math.sqrt(values.length);
  return [m - margin, m + margin];
}

/**
 * Wilson score interval (95%) for a binomial proportion, e.g. acceptance rate.
 * Returns [lower, upper] in 0..1, or null when there are no trials.
 */
export function wilsonCI(successes: number, trials: number): [number, number] | null {
  if (trials <= 0) return null;
  const z = 1.96;
  const p = successes / trials;
  const denom = 1 + (z * z) / trials;
  const center = (p + (z * z) / (2 * trials)) / denom;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) /
    denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

/** Two-sided 95% verdict for a difference, given its standard error. */
export function deltaVerdict(
  delta: number,
  se: number,
): 'better' | 'worse' | 'inconclusive' {
  if (delta - 1.96 * se > 0) return 'better';
  if (delta + 1.96 * se < 0) return 'worse';
  return 'inconclusive';
}

/** The per-arm shape selectWinner needs (subset of the report arm). */
export interface CandidateArm {
  variantId: string;
  vendor: string;
  modelId: string;
  composite: number | null;
  samples: number;
  minSampleReached: boolean;
  vsControl: {
    compositeDelta: number | null;
    compositeVerdict: 'better' | 'worse' | 'inconclusive';
  } | null;
}

export interface Winner {
  variantId: string;
  vendor: string;
  modelId: string;
  composite: number;
  samples: number;
  compositeVerdict: 'better';
}

/**
 * Select the experiment winner.
 *
 * A treatment is only recommended when ALL of the following hold:
 *   1. it has reached the configured per-arm sample target
 *   2. it has a composite score
 *   3. its composite is SIGNIFICANTLY better than control at 95%
 *      (compositeVerdict === 'better', not merely a higher mean)
 *
 * Among those, the highest composite wins. Returns null when no treatment is
 * significantly better — the correct business answer is "keep control".
 */
export function selectWinner(arms: CandidateArm[]): Winner | null {
  const eligible = arms.filter(
    (a) =>
      a.minSampleReached &&
      a.composite !== null &&
      a.vsControl !== null &&
      a.vsControl.compositeVerdict === 'better',
  );
  if (eligible.length === 0) return null;

  let best = eligible[0];
  for (const a of eligible) {
    if ((a.composite as number) > (best.composite as number)) best = a;
  }
  return {
    variantId: best.variantId,
    vendor: best.vendor,
    modelId: best.modelId,
    composite: best.composite as number,
    samples: best.samples,
    compositeVerdict: 'better',
  };
}
