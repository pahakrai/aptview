import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { db } from '../../database/client';
import {
  adminRankings,
  agentStructures,
  benchmarkJobs,
  codeGuidelines,
  experimentRuns,
  experiments,
  reviewDecisions,
} from '../../database/schema';
import type {
  AuditStrategy,
  AuditVerdict,
  ExperimentStatus,
  MetricsWeights,
  ReviewDecisionAction,
} from '@aigov/shared-types';
import type { BenchmarkInputSnapshot } from '@aigov/shared-types';
import { FlowRunnerService } from '../flow-runner/flow-runner.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { NotificationsService } from './notifications.service';
import { PromotionsService } from './promotions.service';
import { EvalService } from './eval.service';
import { MetricsService } from '../metrics/metrics.service';
import { SettingsService } from '../settings/settings.service';
import { logEvent } from '../../common/structured-log';
import {
  clamp01,
  composeScore,
  costUsdOf,
  decisionToAccepted,
  deltaVerdict,
  hashBucket,
  mean,
  normCI,
  sd,
  selectWinner,
  wilsonCI,
} from './experiment-stats';
import { blendFinalScore, normalizeRankings, pickHighestScore } from './experiment-ranking';
import { chiSquareIndependence } from './eval-metrics';

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
  /** Optional telemetry fields captured for the reference-based eval flow. */
  starRating?: number | null;
  modifiedReview?: string | null;
  aiReviewOutput?: string | null;
  codeSnippet?: string | null;
  taskDescription?: string | null;
  codeStandards?: Record<string, unknown> | null;
  contextRetrieved?: Record<string, unknown> | null;
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
  pricedRuns: number;
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
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(
    private readonly configService: ConfigService,
    private readonly flowRunner: FlowRunnerService,
    @InjectQueue('benchmarks') private readonly benchmarksQueue: Queue,
    private readonly notifications: NotificationsService,
    private readonly promotions: PromotionsService,
    private readonly evalService: EvalService,
    private readonly metrics: MetricsService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Global kill-switch. Reads the persisted 'experiments_enabled' setting first
   * (configurable from the UI), then falls back to the EXPERIMENTS_ENABLED env.
   */
  async isEnabled(): Promise<boolean> {
    const persisted = await this.settings.getBoolean('experiments_enabled');
    if (persisted !== null) return persisted;
    return this.configService.get<string>('EXPERIMENTS_ENABLED') === 'true';
  }

  /**
   * Resolve the running experiment for an org, or null → untouched production path.
   */
  async resolveExperiment(organizationId: string) {
    if (!(await this.isEnabled())) return null;

    // Prefer the org's own running experiment over a global one; a newer
    // global experiment must not shadow an org-level decision.
    const [orgExp] = await db
      .select()
      .from(experiments)
      .where(
        and(
          eq(experiments.status, 'running'),
          eq(experiments.organizationId, organizationId),
        ),
      )
      .orderBy(desc(experiments.createdAt))
      .limit(1);
    if (orgExp) return orgExp;

    const [globalExp] = await db
      .select()
      .from(experiments)
      .where(
        and(
          eq(experiments.status, 'running'),
          isNull(experiments.organizationId),
        ),
      )
      .orderBy(desc(experiments.createdAt))
      .limit(1);

    return globalExp ?? null;
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
      prNumber: input.prNumber,
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

    this.metrics.recordExperimentRun(input.variantId, input.verdict);
    this.metrics.recordReviewCosts(
      input.latencyMs,
      input.promptTokens ?? 0,
      input.completionTokens ?? 0,
      costUsdOf(input.strategy.modelId, input.promptTokens ?? 0, input.completionTokens ?? 0),
    );
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

    // Also fold the decision into any promoted-flow (plugin) run for the same PR,
    // so a promoted architecture keeps accumulating live acceptance.
    await this.promotions.foldHumanDecision(
      input.repositoryFullName,
      input.prNumber,
      input.action,
      humanAccepted,
      input.revisionCount,
    );

    // Capture production telemetry for the reference-based eval flow.
    await this.evalService.recordTelemetry({
      traceId: input.threadId,
      repositoryFullName: input.repositoryFullName,
      prNumber: input.prNumber,
      humanAction: input.action,
      humanModifiedReview: input.modifiedReview ?? input.note ?? null,
      starRating: input.starRating ?? null,
      aiReviewOutput: input.aiReviewOutput ?? null,
      codeSnippet: input.codeSnippet ?? null,
      taskDescription: input.taskDescription ?? null,
      codeStandards: input.codeStandards ?? null,
      contextRetrieved: input.contextRetrieved ?? null,
    });

    this.metrics.recordReviewDecision(input.action);
    this.metrics.recordStarRating(input.starRating);

    logEvent('review_decision', {
      trace_id: input.threadId,
      action: input.action,
      star_rating: input.starRating ?? null,
      repository_full_name: input.repositoryFullName,
      pr_number: input.prNumber,
      human_modified_review: input.modifiedReview ?? input.note ?? null,
    });
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
        pricedRuns: 0,
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
        const runCost = costUsdOf(
          r.modelId,
          r.promptTokens ?? 0,
          r.completionTokens ?? 0,
        );
        if (runCost !== null) {
          acc.costUsd += runCost;
          acc.pricedRuns += 1;
        }
      }
      accumulators.push(acc);
    }

    // Cross-arm normalization baselines (lower is better).
    const maxLatency = accumulators.reduce(
      (m, a) => Math.max(m, mean(a.latency) ?? 0),
      1,
    );
    // Cost is compared in USD only when at least one priced run exists;
    // otherwise we fall back to token counts. (Init the reduce with 0 — the
    // previous 1 seed made this condition always true and the token fallback
    // dead code.)
    const pricedAnywhere = accumulators.some((a) => a.costUsd > 0);
    const maxCostUsd = pricedAnywhere
      ? accumulators.reduce((m, a) => Math.max(m, a.costUsd), 0)
      : 0;
    const maxTokens = accumulators.reduce(
      (m, a) => Math.max(m, a.promptTokens + a.completionTokens),
      1,
    );

    const scored = accumulators.map((a) => {
      const acceptanceRate = a.decided > 0 ? a.accepted / a.decided : null;
      const agreedRate = a.agreedSamples > 0 ? a.agreed / a.agreedSamples : null;
      const parseOkRate = a.samples > 0 ? a.parseOk / a.samples : null;
      const avgCompliance = mean(a.compliance);
      const avgEfficiency = mean(a.efficiency);
      const avgCoverage = mean(a.coverage);
      const avgLatencyMs = mean(a.latency);
      const totalTokens = a.promptTokens + a.completionTokens;
      const avgCostUsd = a.pricedRuns > 0 ? a.costUsd / a.pricedRuns : 0;

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
          r.modelId,
          r.promptTokens ?? 0,
          r.completionTokens ?? 0,
        );
        // Unknown-model runs contribute no cost signal (null) rather than a
        // perfect 100, so an unpriced model can't game the composite.
        const cost =
          runCost !== null && pricedAnywhere
            ? clamp01(1 - runCost / maxCostUsd) * 100
            : runCost === null && !pricedAnywhere
              ? clamp01(1 - runTokens / maxTokens) * 100
              : null;

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
      const cost = pricedAnywhere
        ? a.pricedRuns > 0
          ? clamp01(1 - a.costUsd / maxCostUsd) * 100
          : null
        : clamp01(1 - totalTokens / maxTokens) * 100;

      const minSampleReached = a.samples >= exp.minSampleSize;
      const acceptanceCI =
        acceptanceRate !== null ? wilsonCI(a.accepted, a.decided) : null;

      return {
        variantId: a.variantId,
        vendor: a.vendor,
        modelId: a.modelId,
        samples: a.samples,
        decided: a.decided,
        accepted: a.accepted,
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
        minSampleReached,
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
      // Preliminary screening decision: a chi-square test of independence
      // on the 2x2 acceptance table (control vs treatment). The acceptance
      // verdict is gated on this — no "better"/"worse" on acceptance unless the
      // association is real (valid + significant), not a gut reading of rates.
      const acceptanceChiSquare = chiSquareIndependence(
        control.accepted,
        control.decided,
        s.accepted,
        s.decided,
      );
      const acceptancePrepro = !acceptanceChiSquare.valid
        ? 'insufficient'
        : acceptanceChiSquare.significant
          ? 'pass'
          : 'fail';
      const acceptanceVerdict =
        acceptancePrepro === 'pass' && acceptanceDelta !== null && seAcceptance !== null
          ? deltaVerdict(acceptanceDelta, seAcceptance)
          : 'inconclusive';

      return {
        ...s,
        vsControl: {
          compositeDelta,
          compositeVerdict,
          acceptanceDelta,
          acceptanceVerdict,
          acceptancePrepro,
          acceptanceChiSquare: {
            chiSquare: acceptanceChiSquare.chiSquare,
            dof: acceptanceChiSquare.dof,
            pValue: acceptanceChiSquare.pValue,
            valid: acceptanceChiSquare.valid,
            significant: acceptanceChiSquare.significant,
          },
        },
      };
    });

    // A treatment is recommended only when it is significantly better than
    // control (95% composite verdict). A bare mean advantage — or a winner
    // picked before significance — is exactly the premature "winner" the
    // significance machinery exists to prevent.
    const winner = selectWinner(arms);

    for (const arm of arms) {
      this.metrics.recordAcceptanceArm(
        id,
        arm.variantId,
        arm.acceptanceRate,
        arm.acceptanceCI ? arm.acceptanceCI[0] : null,
        arm.acceptanceCI ? arm.acceptanceCI[1] : null,
      );
    }

    return {
      experiment: exp,
      metricsWeights: exp.metricsWeights,
      arms,
      recommendation: winner,
      caveat:
        'Speed and cost are normalized against the largest values seen so far ' +
        'in this experiment, so composite scores and their CIs are relative ' +
        'rankings whose baselines drift as more audits arrive — not fixed-property ' +
        'intervals. "Min sample reached" is a configured sample target, not a ' +
        'statistical power computation. A treatment is recommended only when its ' +
        'composite is significantly better than control at 95%; no multiple-' +
        'comparison correction is applied when several treatments are compared.',
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

  /**
   * Create an A/B experiment from saved agent structures: one control + N
   * treatments. Structure ids are stored for provenance (which designs this
   * experiment actually ran), alongside the resolved strategy snapshots.
   */
  async createFromStructures(input: {
    name: string;
    organizationId?: string | null;
    controlStructureId: string;
    treatmentStructureIds: string[];
    rolloutPercent?: number;
    minSampleSize?: number;
    metricsWeights?: MetricsWeights;
  }) {
    const control = await this.getStructureStrategy(input.controlStructureId);
    const treatments = await Promise.all(
      input.treatmentStructureIds.map((id) => this.getStructureStrategy(id)),
    );

    const [exp] = await db
      .insert(experiments)
      .values({
        name: input.name,
        organizationId: input.organizationId ?? null,
        status: 'draft',
        rolloutPercent: input.rolloutPercent ?? 0,
        minSampleSize: input.minSampleSize ?? 50,
        controlStrategy: control,
        treatmentStrategies: treatments,
        controlStructureId: input.controlStructureId,
        treatmentStructureIds: input.treatmentStructureIds,
        metricsWeights: input.metricsWeights ?? DEFAULT_METRICS_WEIGHTS,
      })
      .returning();
    return exp;
  }

  private async getStructureStrategy(id: string): Promise<AuditStrategy> {
    const [s] = await db
      .select()
      .from(agentStructures)
      .where(eq(agentStructures.id, id))
      .limit(1);
    if (!s) throw new NotFoundException('Agent structure ' + id + ' not found');
    return s.strategy;
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

  // ==========================================================================
  // Deliberate flow A/B — benchmark runs, ranking, promotion ("the plugin")
  // ==========================================================================

  /**
   * Enqueue an async deliberate benchmark run. Returns the job immediately;
   * the worker (BenchmarksProcessor) executes the arms in the background and
   * writes a notification on completion. Only one queued/running job is
   * allowed per experiment at a time.
   */
  async enqueueBenchmark(
    experimentId: string,
    input: {
      organizationId: string;
      repositoryFullName?: string | null;
      prNumber?: number | null;
      prTitle?: string;
      diffContent?: string;
      taskDescription?: string;
      createdBy?: string;
    },
  ) {
    const exp = await this.getById(experimentId);
    if (!exp) throw new NotFoundException('Experiment ' + experimentId + ' not found');

    const [active] = await db
      .select({ id: benchmarkJobs.id })
      .from(benchmarkJobs)
      .where(
        and(
          eq(benchmarkJobs.experimentId, experimentId),
          or(eq(benchmarkJobs.status, 'queued'), eq(benchmarkJobs.status, 'running')),
        ),
      )
      .limit(1);
    if (active) {
      throw new ConflictException('A benchmark is already queued or running for this experiment');
    }

    const guidelines = await db
      .select()
      .from(codeGuidelines)
      .where(
        and(
          eq(codeGuidelines.organizationId, input.organizationId),
          eq(codeGuidelines.isEnabled, true),
        ),
      );

    const snapshot: BenchmarkInputSnapshot = {
      repositoryFullName: input.repositoryFullName ?? null,
      prNumber: input.prNumber ?? null,
      prTitle: input.prTitle ?? '',
      diffContent: input.diffContent ?? '',
      taskDescription: input.taskDescription ?? '',
      guidelines: guidelines.map((g) => ({
        name: g.name,
        severity: g.severity,
        pattern: g.pattern,
      })),
    };

    const [job] = await db
      .insert(benchmarkJobs)
      .values({
        experimentId,
        organizationId: input.organizationId,
        status: 'queued',
        inputSnapshot: snapshot,
        createdBy: input.createdBy ?? 'admin',
      })
      .returning();

    this.abortControllers.set(job.id, new AbortController());
    await this.benchmarksQueue.add(
      'run-benchmark',
      { benchmarkJobId: job.id, experimentId, organizationId: input.organizationId },
      { jobId: job.id },
    );

    return job;
  }

  /**
   * Execute a queued benchmark job (called by BenchmarksProcessor). Runs every
   * arm sequentially, records telemetry, and writes a completion notification.
   * Cooperative cancellation: checks the job's AbortSignal before each arm.
   */
  async runBenchmarkJob(benchmarkJobId: string): Promise<void> {
    const [job] = await db
      .select()
      .from(benchmarkJobs)
      .where(eq(benchmarkJobs.id, benchmarkJobId))
      .limit(1);
    if (!job || job.status === 'cancelled') return;

    await db
      .update(benchmarkJobs)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(benchmarkJobs.id, benchmarkJobId));

    const signal = this.abortControllers.get(benchmarkJobId)?.signal;

    try {
      const exp = await this.getById(job.experimentId);
      if (!exp) throw new Error('Experiment ' + job.experimentId + ' not found');

      const snapshot = job.inputSnapshot;
      const guidelines = await db
        .select()
        .from(codeGuidelines)
        .where(
          and(
            eq(codeGuidelines.organizationId, job.organizationId),
            eq(codeGuidelines.isEnabled, true),
          ),
        );

      const flowGuidelines = guidelines.map((g) => ({
        name: g.name,
        description: g.description,
        pattern: g.pattern,
        severity: g.severity,
      }));

      const variants: Array<{ variantId: string; strategy: AuditStrategy }> = [
        { variantId: 'control', strategy: exp.controlStrategy },
        ...exp.treatmentStrategies.map((s, i) => ({
          variantId: 'treatment-' + (i + 1),
          strategy: s,
        })),
      ];

      for (const v of variants) {
        if (signal?.aborted) break;
        const outcome = await this.flowRunner.run(
          v.strategy,
          {
            prTitle: snapshot?.prTitle ?? 'PR ' + (snapshot?.prNumber ?? 'benchmark'),
            diffContent: snapshot?.diffContent ?? '',
            taskDescription: snapshot?.taskDescription,
            guidelines: flowGuidelines,
          },
          signal,
        );

        await db.insert(experimentRuns).values({
          experimentId: job.experimentId,
          variantId: v.variantId,
          auditId: null,
          prNumber: snapshot?.prNumber ?? 0,
          vendor: v.strategy.vendor,
          modelId: v.strategy.modelId,
          repositoryFullName: snapshot?.repositoryFullName ?? null,
          strategySnapshot: v.strategy,
          source: 'benchmark',
          inputSnapshot: snapshot,
          toolCalls: outcome.toolCalls,
          verdict: outcome.verdict,
          complianceScore: outcome.complianceScore,
          efficiencyScore: outcome.efficiencyScore,
          coverageScore: outcome.coverageScore,
          latencyMs: outcome.latencyMs,
          promptTokens: outcome.promptTokens,
          completionTokens: outcome.completionTokens,
          agreedWithInline: null,
          parseOk: outcome.parseOk,
        });
      }

      if (signal?.aborted) {
        await db
          .update(benchmarkJobs)
          .set({ status: 'cancelled', completedAt: new Date() })
          .where(eq(benchmarkJobs.id, benchmarkJobId));
        return;
      }

      await db
        .update(benchmarkJobs)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(benchmarkJobs.id, benchmarkJobId));

      this.metrics.recordBenchmarkRun('completed');
      logEvent('benchmark_run', { benchmark_job_id: benchmarkJobId, experiment_id: job.experimentId, status: 'completed' });
      await this.notifications.notify(job.organizationId, 'benchmark_completed', 'Benchmark completed', 'Experiment benchmark finished.');
    } catch (err) {
      const aborted = signal?.aborted;
      if (aborted) {
        await db
          .update(benchmarkJobs)
          .set({ status: 'cancelled', completedAt: new Date() })
          .where(eq(benchmarkJobs.id, benchmarkJobId));
      } else {
        await db
          .update(benchmarkJobs)
          .set({ status: 'failed', error: (err as Error).message, completedAt: new Date() })
          .where(eq(benchmarkJobs.id, benchmarkJobId));
        this.metrics.recordBenchmarkRun('failed');
        logEvent('benchmark_run', { benchmark_job_id: benchmarkJobId, experiment_id: job.experimentId, status: 'failed' });
        await this.notifications.notify(job.organizationId, 'benchmark_failed', 'Benchmark failed', (err as Error).message);
      }
    } finally {
      this.abortControllers.delete(benchmarkJobId);
    }
  }

  async getBenchmarkJob(id: string) {
    const [job] = await db
      .select()
      .from(benchmarkJobs)
      .where(eq(benchmarkJobs.id, id))
      .limit(1);
    return job ?? null;
  }

  async listBenchmarkJobs(experimentId: string) {
    return db
      .select()
      .from(benchmarkJobs)
      .where(eq(benchmarkJobs.experimentId, experimentId))
      .orderBy(desc(benchmarkJobs.createdAt));
  }

  async cancelBenchmark(id: string) {
    const [job] = await db
      .select()
      .from(benchmarkJobs)
      .where(eq(benchmarkJobs.id, id))
      .limit(1);
    if (!job) throw new NotFoundException('Benchmark job ' + id + ' not found');
    if (job.status === 'queued' || job.status === 'running') {
      this.abortControllers.get(id)?.abort();
      await db
        .update(benchmarkJobs)
        .set({ status: 'cancelled', completedAt: new Date() })
        .where(eq(benchmarkJobs.id, id));
      this.metrics.recordBenchmarkRun('cancelled');
    }
    const [updated] = await db
      .select()
      .from(benchmarkJobs)
      .where(eq(benchmarkJobs.id, id))
      .limit(1);
    return updated;
  }

  /**
   * Benchmark report: per-variant telemetry + the admin ranking vector + the
   * blended final score. The winner is the highest final score (a manual/blended
   * signal — not the significance-gated winner used for live traffic).
   */
  async getBenchmarkReport(experimentId: string) {
    const exp = await this.getById(experimentId);
    if (!exp) throw new NotFoundException('Experiment ' + experimentId + ' not found');

    const runs = await db
      .select()
      .from(experimentRuns)
      .where(
        and(
          eq(experimentRuns.experimentId, experimentId),
          eq(experimentRuns.source, 'benchmark'),
        ),
      );

    const rankings = await db
      .select()
      .from(adminRankings)
      .where(eq(adminRankings.experimentId, experimentId));

    // Normalize ranks per PR, then average into a per-variant ranking vector.
    const votesByPr = new Map<string, Array<{ variantId: string; rank: number }>>();
    for (const r of rankings) {
      const key = r.repositoryFullName + '#' + r.prNumber;
      const list = votesByPr.get(key) ?? [];
      list.push({ variantId: r.variantId, rank: r.rank });
      votesByPr.set(key, list);
    }
    const rankByVariant = new Map<string, number[]>();
    for (const votes of votesByPr.values()) {
      for (const nv of normalizeRankings(votes)) {
        const arr = rankByVariant.get(nv.variantId) ?? [];
        arr.push(nv.rankScore);
        rankByVariant.set(nv.variantId, arr);
      }
    }

    const groups = new Map<string, ExperimentRunRow[]>();
    for (const r of runs) {
      const list = groups.get(r.variantId) ?? [];
      list.push(r);
      groups.set(r.variantId, list);
    }

    const variantIds = [
      'control',
      ...exp.treatmentStrategies.map((_, i) => 'treatment-' + (i + 1)),
    ];

    const arms = variantIds.map((variantId) => {
      const index = variantId === 'control' ? -1 : Number(variantId.split('-')[1]) - 1;
      const strategy = index === -1 ? exp.controlStrategy : exp.treatmentStrategies[index];
      const rs = groups.get(variantId) ?? [];
      const n = rs.length;

      const avg = (vals: number[]) =>
        vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;

      const avgCompliance = avg(rs.map((r) => r.complianceScore).filter((v): v is number => v !== null));
      const avgEfficiency = avg(rs.map((r) => r.efficiencyScore).filter((v): v is number => v !== null));
      const avgCoverage = avg(rs.map((r) => r.coverageScore).filter((v): v is number => v !== null));
      const avgLatencyMs = avg(rs.map((r) => r.latencyMs).filter((v): v is number => v !== null));
      const totalPromptTokens = rs.reduce((s, r) => s + (r.promptTokens ?? 0), 0);
      const totalCompletionTokens = rs.reduce((s, r) => s + (r.completionTokens ?? 0), 0);
      const totalToolCalls = rs.reduce((s, r) => s + (r.toolCalls ?? 0), 0);
      const parseOk = rs.filter((r) => r.parseOk).length;

      let priced = 0;
      let totalCost = 0;
      for (const r of rs) {
        const c = costUsdOf(r.modelId, r.promptTokens ?? 0, r.completionTokens ?? 0);
        if (c !== null) {
          priced += 1;
          totalCost += c;
        }
      }
      const avgCostUsd = priced > 0 ? totalCost / priced : 0;

      // Automated composite = average of the available score axes (transparent).
      const scoreParts = [avgCompliance, avgEfficiency, avgCoverage].filter(
        (v): v is number => v !== null,
      );
      const composite = scoreParts.length
        ? scoreParts.reduce((a, b) => a + b, 0) / scoreParts.length
        : null;

      const rankVals = rankByVariant.get(variantId) ?? [];
      const rankingScore = rankVals.length
        ? rankVals.reduce((a, b) => a + b, 0) / rankVals.length
        : null;

      const finalScore = blendFinalScore(
        composite,
        rankingScore,
        exp.metricsWeights.ranking ?? 0.2,
      );

      return {
        variantId,
        vendor: strategy?.vendor ?? null,
        modelId: strategy?.modelId ?? null,
        flow: strategy?.flow ?? 'sequential',
        samples: n,
        verdictCounts: {
          pass: rs.filter((r) => r.verdict === 'pass').length,
          fail: rs.filter((r) => r.verdict === 'fail').length,
          warning: rs.filter((r) => r.verdict === 'warning').length,
        },
        avgCompliance,
        avgEfficiency,
        avgCoverage,
        avgLatencyMs,
        totalPromptTokens,
        totalCompletionTokens,
        totalToolCalls,
        avgCostUsd,
        parseOkRate: n > 0 ? parseOk / n : null,
        composite,
        rankingScore,
        finalScore,
      };
    });

    const winner = pickHighestScore(
      arms.map((a) => ({
        variantId: a.variantId,
        vendor: a.vendor ?? '',
        modelId: a.modelId ?? '',
        finalScore: a.finalScore,
      })),
    );

    return {
      experiment: exp,
      metricsWeights: exp.metricsWeights,
      arms,
      winner,
      caveat:
        'Benchmark runs are deliberate (self-selected inputs), so their scores ' +
        'are side-by-side comparisons, not randomized live traffic. The winner is ' +
        'the highest blended final score (automated composite blended with the ' +
        'admin ranking vector); it is not significance-gated.',
    };
  }

  /** Upsert admin rankings for one PR (re-rankable). */
  async upsertRankings(
    experimentId: string,
    input: {
      repositoryFullName: string;
      prNumber: number;
      rankedBy?: string;
      rankings: Array<{ variantId: string; rank: number }>;
    },
  ) {
    const exp = await this.getById(experimentId);
    if (!exp) throw new NotFoundException('Experiment ' + experimentId + ' not found');
    const rankedBy = input.rankedBy ?? 'admin';

    for (const r of input.rankings) {
      await db
        .insert(adminRankings)
        .values({
          experimentId,
          repositoryFullName: input.repositoryFullName,
          prNumber: input.prNumber,
          variantId: r.variantId,
          rank: r.rank,
          rankedBy,
        })
        .onConflictDoUpdate({
          target: [
            adminRankings.experimentId,
            adminRankings.repositoryFullName,
            adminRankings.prNumber,
            adminRankings.variantId,
          ],
          set: { rank: r.rank, rankedBy, updatedAt: new Date() },
        });
    }
    return { experimentId, updated: input.rankings.length };
  }
}
