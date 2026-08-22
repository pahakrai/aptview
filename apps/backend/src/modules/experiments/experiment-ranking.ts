/**
 * experiment-ranking.ts — pure functions for the deliberate-flow A/B ranking
 * vector and the final blended score. No I/O; unit-testable.
 */

/** Clamp a value into [0, 1]. */
function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * Normalize a 1..N rank into a 0..100 score: (N - rank) / (N - 1) * 100.
 * rank 1 (best) => 100; rank N (worst) => 0; a single item => 100.
 */
export function normalizeRankScore(rank: number, n: number): number {
  if (n <= 1) return 100;
  const clamped = Math.max(1, Math.min(n, Math.round(rank)));
  return ((n - clamped) / (n - 1)) * 100;
}

export interface RankedVariant {
  variantId: string;
  rankScore: number;
}

/** Normalize a list of (variantId, rank) votes into 0..100 rank scores. */
export function normalizeRankings(
  rankings: Array<{ variantId: string; rank: number }>,
): RankedVariant[] {
  const n = rankings.length;
  return rankings.map((r) => ({
    variantId: r.variantId,
    rankScore: normalizeRankScore(r.rank, n),
  }));
}

/**
 * Blend the automated composite (0..100) with the human ranking score (0..100).
 * rankingWeight is clamped to [0,1]; the composite carries the rest.
 * Missing signals are ignored; null only when both are missing.
 */
export function blendFinalScore(
  composite: number | null,
  rankingScore: number | null,
  rankingWeight: number,
): number | null {
  const w = clamp01(rankingWeight);
  if (composite === null && rankingScore === null) return null;
  if (composite === null) return rankingScore;
  if (rankingScore === null) return composite;
  return composite * (1 - w) + rankingScore * w;
}

export interface ScoredVariant {
  variantId: string;
  vendor: string;
  modelId: string;
  finalScore: number | null;
}

/** Pick the variant with the highest final score (a manual/blended signal). */
export function pickHighestScore(arms: ScoredVariant[]): ScoredVariant | null {
  let best: ScoredVariant | null = null;
  for (const a of arms) {
    if (a.finalScore === null) continue;
    if (best === null || a.finalScore > (best.finalScore as number)) best = a;
  }
  return best;
}
