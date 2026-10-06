/**
 * eval-metrics.ts — pure statistical evaluation for the reference-based A/B
 * flow. No I/O. Given an AI review output and a human-derived reference, it
 * computes token-overlap precision/recall/F1, Jaccard similarity, normalized
 * edit-distance similarity, plus the two-sample stats used to compare variants
 * (Welch t-test, Cohen's d, two-proportion z-test, 95% CI).
 */

/** Tokenize review text: lowercase + split on non-alphanumeric. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function toSet(tokens: string[]): Set<string> {
  return new Set(tokens);
}

export interface F1Result {
  precision: number;
  recall: number;
  f1: number;
}

/** Token-overlap precision/recall/F1 of pred against a reference. */
export function precisionRecallF1(reference: string, predicted: string): F1Result {
  const ref = toSet(tokenize(reference));
  const pred = toSet(tokenize(predicted));
  if (ref.size === 0 && pred.size === 0) return { precision: 1, recall: 1, f1: 1 };
  if (ref.size === 0 || pred.size === 0) return { precision: 0, recall: 0, f1: 0 };
  let inter = 0;
  for (const t of pred) if (ref.has(t)) inter += 1;
  const precision = inter / pred.size;
  const recall = inter / ref.size;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

/** Jaccard similarity over tokens (0..1). */
export function jaccardSimilarity(a: string, b: string): number {
  const sa = toSet(tokenize(a));
  const sb = toSet(tokenize(b));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sb) if (sa.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Levenshtein distance between two strings. */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/** Normalized edit-distance similarity (1 = identical, 0 = maximally different). */
export function editSimilarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const dist = levenshteinDistance(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function sampleVariance(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
}

export function pooledStd(valuesA: number[], valuesB: number[]): number {
  const na = valuesA.length;
  const nb = valuesB.length;
  if (na < 2 || nb < 2) return NaN;
  const va = sampleVariance(valuesA);
  const vb = sampleVariance(valuesB);
  return Math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2));
}

/** Cohen's d effect size (mean difference / pooled SD). */
export function cohensD(valuesA: number[], valuesB: number[]): number {
  const sd = pooledStd(valuesA, valuesB);
  if (!Number.isFinite(sd) || sd === 0) return NaN;
  return (mean(valuesB) - mean(valuesA)) / sd;
}

// ---------------------------------------------------------------------------
// Regularized incomplete beta function I_x(a, b) via continued fraction
// (Numerical Recipes). Used for the Student t-distribution CDF.
// ---------------------------------------------------------------------------

function logGamma(x: number): number {
  // Lanczos approximation for ln(Gamma(x)), x > 0.
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = c[0];
  const t = z + g + 0.5;
  for (let i = 1; i < g + 2; i += 1) a += c[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function beta(a: number, b: number): number {
  return Math.exp(logGamma(a) + logGamma(b) - logGamma(a + b));
}

function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

export function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

// ---------------------------------------------------------------------------
// Two-sample Welch t-test (unequal variances), returns two-sided p-value.
// ---------------------------------------------------------------------------

export interface WelchResult {
  t: number;
  df: number;
  pValue: number;
}

export function welchTTest(valuesA: number[], valuesB: number[]): WelchResult {
  const na = valuesA.length;
  const nb = valuesB.length;
  if (na < 2 || nb < 2) return { t: NaN, df: NaN, pValue: NaN };
  const ma = mean(valuesA);
  const mb = mean(valuesB);
  const va = sampleVariance(valuesA);
  const vb = sampleVariance(valuesB);
  const se = Math.sqrt(va / na + vb / nb);
  if (se === 0) return { t: 0, df: na + nb - 2, pValue: 1 };
  const t = (mb - ma) / se;
  const df =
    ((va / na + vb / nb) ** 2) /
    ((va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1));
  // Two-sided p = I_{x}(df/2, 1/2) with x = df/(df + t^2).
  const x = df / (df + t * t);
  const pValue = regularizedIncompleteBeta(df / 2, 0.5, x);
  return { t, df, pValue };
}

// ---------------------------------------------------------------------------
// Two-proportion z-test (two-sided).
// ---------------------------------------------------------------------------

function erfc(x: number): number {
  // Abramowitz-Stegun 7.1.26 approximation of the complementary error function.
  const t = 1 / (1 + 0.5 * Math.abs(x));
  const tau =
    t *
    Math.exp(
      -x * x -
        1.26551223 +
        t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? tau : 2 - tau;
}

export interface ZResult {
  z: number;
  pValue: number;
}

export function twoProportionZTest(
  successA: number,
  nA: number,
  successB: number,
  nB: number,
): ZResult {
  if (nA <= 0 || nB <= 0) return { z: NaN, pValue: NaN };
  const pA = successA / nA;
  const pB = successB / nB;
  const pooled = (successA + successB) / (nA + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  if (se === 0) return { z: 0, pValue: 1 };
  const z = (pB - pA) / se;
  const pValue = erfc(Math.abs(z) / Math.SQRT2);
  return { z, pValue };
}

/** 95% confidence interval for a mean (normal approximation). */
export function meanCI(values: number[]): [number, number] {
  const n = values.length;
  if (n < 2) return [mean(values), mean(values)];
  const m = mean(values);
  const margin = (1.96 * Math.sqrt(sampleVariance(values))) / Math.sqrt(n);
  return [m - margin, m + margin];
}
