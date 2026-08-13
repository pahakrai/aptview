import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { db } from '../../database/client';
import { experimentRuns, experiments, reviewDecisions } from '../../database/schema';
import type {
  AuditStrategy,
  AuditVerdict,
  ExperimentStatus,
  MetricsWeights,
  ReviewDecisionAction,
} from '@aigov/shared-types';

export const DEFAULT_METRICS_WEIGHTS: MetricsWeights = {
  accuracy: 0.35,
  quality: 0.35,
  acceptance: 0.15,
  speed: 0.075,
  cost: 0.075,
};

export interface CreateExperimentInput {
  name: string;
  organizationId?: string | null;
  rolloutPercent?: number;
  minSampleSize?: number;
  controlStrategy: AuditStrategy;
  treatmentStrategies?: AuditStrategy[];
  metricsWeights?: MetricsWeights;
}

/** A resolved experiment arm: which strategy a bucketed audit should run. */
export interface ResolvedArm {
  experimentId: string;
  variantId: string;
  strategy: AuditStrategy;
}

export interface RecordRunInput {
  experimentId: string;
  variantId: string;
  auditId: string;
  prNumber: number;
  repositoryFullName: string | null;
  strategy: AuditStrategy;
  verdict: AuditVerdict;
  complianceScore: number | null;
  efficiencyScore: number | null;
  coverageScore: number | null;
  latencyMs: number | null;
  promptTokens?: number;
  completionTokens?: number;
  agreedWithInline: boolean | null;
  parseOk: boolean | null;
}

export interface ReviewDecisionInput {
  threadId: string;
  prNumber: number;
  repositoryFullName: string;
  action: ReviewDecisionAction;
  revisionCount: number;
  note?: string | null;
}

/** Deterministic FNV-1a hash → 0..99 for stable, reproducible bucketing. */
function hashBucket(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h) % 100;
}

/** Map a human decision to the `humanAccepted` boolean (null = no judgment). */
function decisionToAccepted(action: ReviewDecisionAction): boolean | null {
  if (action === 'approve') return true;
  if (action === 'revise') return false;
  return null;
}

/** Clamp a value into [0, 1]. */
function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * Weighted composite (0–100) over the available sub-scores. Weights are
 * renormalized over the components that actually have data, so a missing
 * signal (e.g. no human decisions yet) doesn't zero out the score.
 */
function composeScore(
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

/**
 * Wilson score interval (95%) for a binomial proportion, e.g. acceptance rate.
 * Returns [lower, upper] in 0..1, or null when there are no trials.
 */
function wilsonCI(successes: number, trials: number): [number, number] | null {
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

/**
 * Stage-1 pricing ($ per 1M tokens, input/output). Swap for a live pricing
 * table before treating cost as authoritative.
 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
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

/** Cost of one run in USD, from token usage and per-model pricing. */
function costUsdOf(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const price = MODEL_PRICING[modelId];
  if (!price) return 0;
  return (promptTokens * price.input + completionTokens * price.output) / 1_000_000;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function sd(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values) as number;
  const variance =
    values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Normal-approx 95% CI for a mean, or null with <2 observations. */
function normCI(values: number[]): [number, number] | null {
  const m = mean(values);
  const s = sd(values);
  if (m === null || s === null) return null;
  const margin = (1.96 * s) / Math.sqrt(values.length);
  return [m - margin, m + margin];
}

/** Two-sided 95% verdict for a difference, given its standard error. */
function deltaVerdict(
  delta: number,
  se: number,
): 'better' | 'worse' | 'inconclusive' {
  if (delta - 1.96 * se > 0) return 'better';
  if (delta + 1.96 * se < 0) return 'worse';
  return 'inconclusive';
}

type ExperimentRunRow = typeof experimentRuns.$inferSelect;

interface ArmAccumulator {
  variantId: string;
  vendor: string;
  modelId: string;
  runs: ExperimentRunRow[];
  samples: number;
  decided: number;
  accepted: number;
  agreed: number;
  agreedSamples: number;
  parseOk: number;
  compliance: number[];
  efficiency: number[];
  coverage: number[];
  latency: number[];
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

/**
 * ExperimentsService — feature-flag + A/B experiment management.
 *
 * The whole thing is inert unless `EXPERIMENTS_ENABLED=true` AND an experiment
 * is `running`. That invariant keeps the audit pipeline byte-for-byte identical
 * to its pre-experiment behavior in the default configuration.
 */
@Injectable()
export class ExperimentsService {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Global kill-switch. Reads `EXPERIMENTS_ENABLED` (default: off).
   */
  isEnabled(): boolean {
    return this.configService.get<string>('EXPERIMENTS_ENABLED') === 'true';
  }

  /**
   * Resolve the running experiment for an org, or null → untouched production path.
   */
  async resolveExperiment(organizationId: string) {
    if (!this.isEnabled()) return null;

    const [exp] = await db
      .select()
      .from(experiments)
      .where(
        and(
          eq(experiments.status, 'running'),
          or(
            isNull(experiments.organizationId),
            eq(experiments.organizationId, organizationId),
          ),
        ),
      )
      .orderBy(desc(experiments.createdAt))
      .limit(1);

    return exp ?? null;
  }

  /**
   * Deterministically assign an audit to an experiment arm (control vs treatment),
   * or return null when the audit is outside the experiment rollout.
   */
  async resolveArm(
    organizationId: string,
    prNumber: number,
    repositoryFullName?: string,
  ): Promise<ResolvedArm | null> {
    const exp = await this.resolveExperiment(organizationId);
    if (!exp) return null;

    const key = `${repositoryFullName ?? organizationId}:${prNumber}`;
    const bucket = hashBucket(key) % 100;
    if (bucket >= exp.rolloutPercent) return null;

    const armCount = 1 + (exp.treatmentStrategies?.length ?? 0);
    const armIndex = hashBucket(`${key}:arm`) % armCount;
    const strategy =
      armIndex === 0
        ? exp.controlStrategy
        : exp.treatmentStrategies[armIndex - 1];

    return {
      experimentId: exp.id,
      variantId: armIndex === 0 ? 'control' : `treatment-${armIndex}`,
      strategy,
    };
  }

  /**
   * Record one observation for a bucketed audit. Carries the automated review
   * signal (verdict/scores/latency/tokens/parse) and, when a human decision has
   * already arrived, backfills that acceptance signal too.
   */
  async recordRun(input: RecordRunInput): Promise<void> {
    // One observation per PR — ignore re-audits of an already-bucketed PR.
    if (input.repositoryFullName) {
      const [existing] = await db
        .select({ id: experimentRuns.id })
        .from(experimentRuns)
        .where(
          and(
            eq(experimentRuns.experimentId, input.experimentId),
            eq(experimentRuns.repositoryFullName, input.repositoryFullName),
            eq(experimentRuns.prNumber, input.prNumber),
          ),
        )
        .limit(1);
      if (existing) return;
    }

    let humanDecision: ReviewDecisionAction | null = null;
    let humanAccepted: boolean | null = null;
    let revisionCount: number | null = null;
    let acceptedAt: Date | null = null;

    if (input.repositoryFullName) {
      const [last] = await db
        .select()
        .from(reviewDecisions)
        .where(
          and(
            eq(reviewDecisions.repositoryFullName, input.repositoryFullName),
            eq(reviewDecisions.prNumber, input.prNumber),
          ),
        )
        .orderBy(desc(reviewDecisions.createdAt))
        .limit(1);

      if (last) {
        humanDecision = last.action;
        humanAccepted = decisionToAccepted(last.action);
        revisionCount = last.revisionCount;
        acceptedAt = last.action === 'approve' ? last.createdAt : null;
      }
    }

    await db.insert(experimentRuns).values({
      experimentId: input.experimentId,
      variantId: input.variantId,
      auditId: input.auditId,
      vendor: input.strategy.vendor,
      modelId: input.strategy.modelId,
      repositoryFullName: input.repositoryFullName,
      strategySnapshot: input.strategy,
      verdict: input.verdict,
      complianceScore: input.complianceScore,
      efficiencyScore: input.efficiencyScore,
      coverageScore: input.coverageScore,
      latencyMs: input.latencyMs,
      promptTokens: input.promptTokens ?? null,
      completionTokens: input.completionTokens ?? null,
      agreedWithInline: input.agreedWithInline,
      parseOk: input.parseOk,
      humanDecision,
      humanAccepted,
      revisionCount,
      acceptedAt,
    });
  }

  /**
   * Persist a human review decision and fold it into any matching experiment
   * runs (correlated by repository full name + PR number).
   */
  async recordHumanDecision(input: ReviewDecisionInput): Promise<void> {
    await db.insert(reviewDecisions).values({
      threadId: input.threadId,
      prNumber: input.prNumber,
      repositoryFullName: input.repositoryFullName,
      action: input.action,
      revisionCount: input.revisionCount,
      note: input.note ?? null,
    });

    const humanAccepted = decisionToAccepted(input.action);

    await db
      .update(experimentRuns)
      .set({
        humanDecision: input.action,
        humanAccepted,
        revisionCount: input.revisionCount,
        ...(input.action === 'approve' ? { acceptedAt: new Date() } : {}),
      })
      .where(
        and(
          eq(experimentRuns.repositoryFullName, input.repositoryFullName),
          eq(experimentRuns.prNumber, input.prNumber),
        ),
      );
  }

  /**
   * Per-arm report: automated review averages plus reviewer acceptance rate.
   */
  async getReport(id: string) {
    const exp = await this.getById(id);
    if (!exp) throw new NotFoundException(`Experiment ${id} not found`);

    const runs = await db
      .select()
      .from(experimentRuns)
      .where(eq(experimentRuns.experimentId, id));

    // Group runs by variant.
    const groups = new Map<string, ExperimentRunRow[]>();
    for (const r of runs) {
      const list = groups.get(r.variantId) ?? [];
      list.push(r);
      groups.set(r.variantId, list);
    }

    const accumulators: ArmAccumulator[] = [];
    for (const [variantId, rs] of groups) {
      const acc: ArmAccumulator = {
        variantId,
        vendor: rs[0].vendor,
        modelId: rs[0].modelId,
        runs: rs,
        samples: rs.length,
        decided: 0,
        accepted: 0,
        agreed: 0,
        agreedSamples: 0,
        parseOk: 0,
        compliance: [],
        efficiency: [],
        coverage: [],
        latency: [],
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
      };
      for (const r of rs) {
        if (r.humanAccepted !== null && r.humanAccepted !== undefined) {
          acc.decided += 1;
          if (r.humanAccepted) acc.accepted += 1;
        }
        if (r.agreedWithInline !== null && r.agreedWithInline !== undefined) {
          acc.agreedSamples += 1;
          if (r.agreedWithInline) acc.agreed += 1;
        }
        if (r.parseOk) acc.parseOk += 1;
        if (r.complianceScore !== null && r.complianceScore !== undefined) {
          acc.compliance.push(r.complianceScore);
        }
        if (r.efficiencyScore !== null && r.efficiencyScore !== undefined) {
          acc.efficiency.push(r.efficiencyScore);
        }
        if (r.coverageScore !== null && r.coverageScore !== undefined) {
          acc.coverage.push(r.coverageScore);
        }
        if (r.latencyMs !== null && r.latencyMs !== undefined) {
          acc.latency.push(r.latencyMs);
        }
        acc.promptTokens += r.promptTokens ?? 0;
        acc.completionTokens += r.completionTokens ?? 0;
        acc.costUsd += costUsdOf(
          acc.modelId,
          r.promptTokens ?? 0,
          r.completionTokens ?? 0,
        );
      }
      accumulators.push(acc);
    }

    // Cross-arm normalization baselines (lower is better).
    const maxLatency = accumulators.reduce(
      (m, a) => Math.max(m, mean(a.latency) ?? 0),
      1,
    );
    const maxCostUsd = accumulators.reduce((m, a) => Math.max(m, a.costUsd), 1);
    const maxTokens = accumulators.reduce(
      (m, a) => Math.max(m, a.promptTokens + a.completionTokens),
      1,
    );
    const useCostUsd = maxCostUsd > 0;

    const scored = accumulators.map((a) => {
      const acceptanceRate = a.decided > 0 ? a.accepted / a.decided : null;
      const agreedRate = a.agreedSamples > 0 ? a.agreed / a.agreedSamples : null;
      const parseOkRate = a.samples > 0 ? a.parseOk / a.samples : null;
      const avgCompliance = mean(a.compliance);
      const avgEfficiency = mean(a.efficiency);
      const avgCoverage = mean(a.coverage);
      const avgLatencyMs = mean(a.latency);
      const totalTokens = a.promptTokens + a.completionTokens;
      const avgCostUsd = a.samples > 0 ? a.costUsd / a.samples : 0;

      // Per-run composite so the composite carries a real confidence interval.
      const compositeVals: number[] = [];
      for (const r of a.runs) {
        const runAgreed = r.agreedWithInline;
        const accuracy =
          r.complianceScore ??
          (runAgreed !== null && runAgreed !== undefined
            ? runAgreed
              ? 100
              : 0
            : null);
        const qualityParts = [r.efficiencyScore, r.coverageScore].filter(
          (v): v is number => v !== null && v !== undefined,
        );
        const quality =
          qualityParts.length > 0
            ? qualityParts.reduce((s, v) => s + v, 0) / qualityParts.length
            : null;
        const acceptance =
          r.humanAccepted !== null && r.humanAccepted !== undefined
            ? r.humanAccepted
              ? 100
              : 0
            : null;
        const speed =
          r.latencyMs !== null
            ? clamp01(1 - r.latencyMs / maxLatency) * 100
            : null;
        const runTokens = (r.promptTokens ?? 0) + (r.completionTokens ?? 0);
        const runCost = costUsdOf(
          a.modelId,
          r.promptTokens ?? 0,
          r.completionTokens ?? 0,
        );
        const cost = useCostUsd
          ? clamp01(1 - runCost / maxCostUsd) * 100
          : clamp01(1 - runTokens / maxTokens) * 100;

        const c = composeScore(
          { accuracy, quality, acceptance, speed, cost },
          exp.metricsWeights,
        );
        if (c !== null) compositeVals.push(c);
      }

      const composite = mean(compositeVals);
      const compositeCI = normCI(compositeVals);
      const compositeSd = sd(compositeVals);

      // Arm-level sub-scores for display.
      const accuracy =
        avgCompliance ?? (agreedRate !== null ? agreedRate * 100 : null);
      const qualityParts = [avgEfficiency, avgCoverage].filter(
        (v): v is number => v !== null && v !== undefined,
      );
      const quality =
        qualityParts.length > 0
          ? qualityParts.reduce((s, v) => s + v, 0) / qualityParts.length
          : null;
      const acceptance = acceptanceRate !== null ? acceptanceRate * 100 : null;
      const speed =
        avgLatencyMs !== null
          ? clamp01(1 - avgLatencyMs / maxLatency) * 100
          : null;
      const cost = useCostUsd
        ? clamp01(1 - a.costUsd / maxCostUsd) * 100
        : clamp01(1 - totalTokens / maxTokens) * 100;

      const powered = a.samples >= exp.minSampleSize;
      const acceptanceCI =
        acceptanceRate !== null ? wilsonCI(a.accepted, a.decided) : null;

      return {
        variantId: a.variantId,
        vendor: a.vendor,
        modelId: a.modelId,
        samples: a.samples,
        decided: a.decided,
        undecided: a.samples - a.decided,
        acceptanceRate,
        acceptanceCI,
        agreedWithInlineRate: agreedRate,
        parseOkRate,
        avgCompliance,
        avgEfficiency,
        avgCoverage,
        avgLatencyMs,
        complianceCI: normCI(a.compliance),
        efficiencyCI: normCI(a.efficiency),
        coverageCI: normCI(a.coverage),
        latencyCI: normCI(a.latency),
        totalPromptTokens: a.promptTokens,
        totalCompletionTokens: a.completionTokens,
        totalCostUsd: a.costUsd,
        avgCostUsd,
        subScores: { accuracy, quality, acceptance, speed, cost },
        composite,
        compositeCI,
        compositeN: compositeVals.length,
        compositeSd,
        powered,
      };
    });

    const control = scored.find((s) => s.variantId === 'control');
    const arms = scored.map((s) => {
      if (!control || s.variantId === 'control') {
        return { ...s, vsControl: null };
      }

      const compositeDelta =
        s.composite !== null && control.composite !== null
          ? s.composite - control.composite
          : null;
      const seComposite =
        s.compositeSd !== null &&
        control.compositeSd !== null &&
        s.compositeN > 0 &&
        control.compositeN > 0
          ? Math.sqrt(
              (s.compositeSd ** 2) / s.compositeN +
                (control.compositeSd ** 2) / control.compositeN,
            )
          : null;
      const compositeVerdict =
        compositeDelta !== null && seComposite !== null
          ? deltaVerdict(compositeDelta, seComposite)
          : 'inconclusive';

      const acceptanceDelta =
        s.acceptanceRate !== null && control.acceptanceRate !== null
          ? s.acceptanceRate - control.acceptanceRate
          : null;
      const seAcceptance =
        s.acceptanceRate !== null && control.acceptanceRate !== null
          ? Math.sqrt(
              (s.acceptanceRate * (1 - s.acceptanceRate)) /
                Math.max(1, s.decided) +
                (control.acceptanceRate * (1 - control.acceptanceRate)) /
                  Math.max(1, control.decided),
            )
          : null;
      const acceptanceVerdict =
        acceptanceDelta !== null && seAcceptance !== null
          ? deltaVerdict(acceptanceDelta, seAcceptance)
          : 'inconclusive';

      return {
        ...s,
        vsControl: {
          compositeDelta,
          compositeVerdict,
          acceptanceDelta,
          acceptanceVerdict,
        },
      };
    });

    const poweredArms = arms.filter((s) => s.powered && s.composite !== null);
    const winner = poweredArms.reduce<(typeof poweredArms)[number] | null>(
      (best, s) => {
        if (s.composite === null) return best;
        if (
          best === null ||
          best.composite === null ||
          s.composite > best.composite
        ) {
          return s;
        }
        return best;
      },
      null,
    );

    return {
      experiment: exp,
      metricsWeights: exp.metricsWeights,
      arms,
      recommendation: winner
        ? {
            variantId: winner.variantId,
            vendor: winner.vendor,
            modelId: winner.modelId,
            composite: winner.composite,
            samples: winner.samples,
          }
        : null,
    };
  }

  async list() {
    return db.select().from(experiments).orderBy(desc(experiments.createdAt));
  }

  async getById(id: string) {
    const [exp] = await db
      .select()
      .from(experiments)
      .where(eq(experiments.id, id))
      .limit(1);
    return exp ?? null;
  }

  async create(input: CreateExperimentInput) {
    const [exp] = await db
      .insert(experiments)
      .values({
        name: input.name,
        organizationId: input.organizationId ?? null,
        status: 'draft',
        rolloutPercent: input.rolloutPercent ?? 0,
        minSampleSize: input.minSampleSize ?? 50,
        controlStrategy: input.controlStrategy,
        treatmentStrategies: input.treatmentStrategies ?? [],
        metricsWeights: input.metricsWeights ?? DEFAULT_METRICS_WEIGHTS,
      })
      .returning();
    return exp;
  }

  async updateStatus(
    id: string,
    status: ExperimentStatus,
    rolloutPercent?: number,
  ) {
    const [exp] = await db
      .update(experiments)
      .set({
        status,
        ...(rolloutPercent !== undefined ? { rolloutPercent } : {}),
        ...(status === 'running' ? { startedAt: new Date() } : {}),
        ...(status === 'completed' ? { endedAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(experiments.id, id))
      .returning();
    return exp ?? null;
  }
}
