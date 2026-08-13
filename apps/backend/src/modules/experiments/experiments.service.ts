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

    const arms = new Map<
      string,
      {
        variantId: string;
        vendor: string;
        modelId: string;
        samples: number;
        decided: number;
        accepted: number;
        agreedSamples: number;
        agreed: number;
        parseOk: number;
        complianceSum: number;
        complianceSamples: number;
        efficiencySum: number;
        efficiencySamples: number;
        coverageSum: number;
        coverageSamples: number;
        latencySum: number;
        latencySamples: number;
        promptTokens: number;
        completionTokens: number;
      }
    >();

    for (const r of runs) {
      const existing = arms.get(r.variantId);
      const arm = existing ?? {
        variantId: r.variantId,
        vendor: r.vendor,
        modelId: r.modelId,
        samples: 0,
        decided: 0,
        accepted: 0,
        agreedSamples: 0,
        agreed: 0,
        parseOk: 0,
        complianceSum: 0,
        complianceSamples: 0,
        efficiencySum: 0,
        efficiencySamples: 0,
        coverageSum: 0,
        coverageSamples: 0,
        latencySum: 0,
        latencySamples: 0,
        promptTokens: 0,
        completionTokens: 0,
      };

      arm.samples += 1;

      if (r.humanAccepted !== null && r.humanAccepted !== undefined) {
        arm.decided += 1;
        if (r.humanAccepted) arm.accepted += 1;
      }
      if (r.agreedWithInline !== null && r.agreedWithInline !== undefined) {
        arm.agreedSamples += 1;
        if (r.agreedWithInline) arm.agreed += 1;
      }
      if (r.parseOk) arm.parseOk += 1;
      if (r.complianceScore !== null && r.complianceScore !== undefined) {
        arm.complianceSum += r.complianceScore;
        arm.complianceSamples += 1;
      }
      if (r.efficiencyScore !== null && r.efficiencyScore !== undefined) {
        arm.efficiencySum += r.efficiencyScore;
        arm.efficiencySamples += 1;
      }
      if (r.coverageScore !== null && r.coverageScore !== undefined) {
        arm.coverageSum += r.coverageScore;
        arm.coverageSamples += 1;
      }
      if (r.latencyMs !== null && r.latencyMs !== undefined) {
        arm.latencySum += r.latencyMs;
        arm.latencySamples += 1;
      }
      arm.promptTokens += r.promptTokens ?? 0;
      arm.completionTokens += r.completionTokens ?? 0;

      arms.set(r.variantId, arm);
    }

    const avg = (sum: number, n: number): number | null => (n > 0 ? sum / n : null);

    const armList = Array.from(arms.values());

    // Cross-arm baselines for speed/cost normalization (lower is better).
    const maxLatency = armList.reduce(
      (m, a) => Math.max(m, avg(a.latencySum, a.latencySamples) ?? 0),
      1,
    );
    const maxTokens = armList.reduce(
      (m, a) => Math.max(m, a.promptTokens + a.completionTokens),
      1,
    );

    const scored = armList.map((a) => {
      const acceptanceRate = a.decided > 0 ? a.accepted / a.decided : null;
      const agreedRate = a.agreedSamples > 0 ? a.agreed / a.agreedSamples : null;
      const parseOkRate = a.samples > 0 ? a.parseOk / a.samples : null;
      const avgCompliance = avg(a.complianceSum, a.complianceSamples);
      const avgEfficiency = avg(a.efficiencySum, a.efficiencySamples);
      const avgCoverage = avg(a.coverageSum, a.coverageSamples);
      const avgLatencyMs = avg(a.latencySum, a.latencySamples);
      const totalTokens = a.promptTokens + a.completionTokens;

      // Business-decision sub-scores, normalized 0–100.
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
        avgLatencyMs !== null ? clamp01(1 - avgLatencyMs / maxLatency) * 100 : null;
      const cost = clamp01(1 - totalTokens / maxTokens) * 100;

      const subScores = { accuracy, quality, acceptance, speed, cost };
      const composite = composeScore(subScores, exp.metricsWeights);

      return {
        variantId: a.variantId,
        vendor: a.vendor,
        modelId: a.modelId,
        samples: a.samples,
        acceptanceRate,
        agreedWithInlineRate: agreedRate,
        parseOkRate,
        avgCompliance,
        avgEfficiency,
        avgCoverage,
        avgLatencyMs,
        totalPromptTokens: a.promptTokens,
        totalCompletionTokens: a.completionTokens,
        subScores,
        composite,
      };
    });

    const withSamples = scored.filter((s) => s.samples > 0);
    const winner = withSamples.reduce<(typeof withSamples)[number] | null>(
      (best, s) =>
        s.composite !== null &&
        (best === null || best.composite === null || s.composite > best.composite)
          ? s
          : best,
      null,
    );

    return {
      experiment: exp,
      metricsWeights: exp.metricsWeights,
      arms: scored,
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
