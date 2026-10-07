import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, gte } from 'drizzle-orm';
import { db } from '../../database/client';
import { experiments, goldStandardReferences, referenceEvals, reviewTelemetry } from '../../database/schema';
import type { AuditStrategy } from '@aigov/shared-types';
import { FlowRunnerService, type FlowGuideline } from '../flow-runner/flow-runner.service';
import { MetricsService } from '../metrics/metrics.service';
import { costUsdOf } from './experiment-stats';
import { cohensD, editSimilarity, mean, meanCI, precisionRecallF1, welchTTest } from './eval-metrics';

/**
 * EvalService - reference-based evaluation via implicit labeling from
 * production data. High-quality interactions become gold/silver references;
 * variants are replayed against them and compared with t-tests + Cohen's d.
 */
@Injectable()
export class EvalService {
  constructor(
    private readonly flowRunner: FlowRunnerService,
    private readonly metrics: MetricsService,
  ) {}

  async recordTelemetry(input: {
    traceId: string;
    experimentId?: string | null;
    variantId?: string | null;
    organizationId?: string | null;
    codeSnippet?: string | null;
    taskDescription?: string | null;
    codeStandards?: Record<string, unknown> | null;
    aiReviewOutput?: string | null;
    humanAction?: 'approve' | 'revise' | 'cancel' | null;
    humanModifiedReview?: string | null;
    starRating?: number | null;
    latencyMs?: number | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    costUsd?: number | null;
  }) {
    await db.insert(reviewTelemetry).values({
      traceId: input.traceId,
      experimentId: input.experimentId ?? null,
      variantId: input.variantId ?? null,
      organizationId: input.organizationId ?? null,
      codeSnippet: input.codeSnippet ?? null,
      taskDescription: input.taskDescription ?? null,
      codeStandards: input.codeStandards ?? null,
      aiReviewOutput: input.aiReviewOutput ?? null,
      humanAction: input.humanAction ?? null,
      humanModifiedReview: input.humanModifiedReview ?? null,
      starRating: input.starRating ?? null,
      latencyMs: input.latencyMs ?? null,
      promptTokens: input.promptTokens ?? null,
      completionTokens: input.completionTokens ?? null,
      costUsd: input.costUsd ?? null,
    }).onConflictDoUpdate({
      target: [reviewTelemetry.traceId],
      set: {
        humanAction: input.humanAction ?? null,
        humanModifiedReview: input.humanModifiedReview ?? null,
        starRating: input.starRating ?? null,
      },
    });
    this.metrics.recordTelemetry(input.humanAction);
    return { traceId: input.traceId };
  }

  async generateReferences() {
    const gold = await db.select().from(reviewTelemetry).where(
      and(eq(reviewTelemetry.humanAction, 'revise'), gte(reviewTelemetry.starRating, 3)),
    );
    const silver = await db.select().from(reviewTelemetry).where(
      and(eq(reviewTelemetry.humanAction, 'approve'), gte(reviewTelemetry.starRating, 4)),
    );
    let g = 0;
    for (const row of gold) {
      const ref = row.humanModifiedReview ?? row.aiReviewOutput ?? '';
      if (!ref) continue;
      await db.insert(goldStandardReferences).values({
        traceId: row.traceId,
        codeSnippet: row.codeSnippet,
        taskDescription: row.taskDescription,
        codeStandards: row.codeStandards,
        referenceReview: ref,
        referenceType: 'gold',
      }).onConflictDoNothing();
      g += 1;
    }
    let s = 0;
    for (const row of silver) {
      const ref = row.aiReviewOutput ?? '';
      if (!ref) continue;
      await db.insert(goldStandardReferences).values({
        traceId: row.traceId,
        codeSnippet: row.codeSnippet,
        taskDescription: row.taskDescription,
        codeStandards: row.codeStandards,
        referenceReview: ref,
        referenceType: 'silver',
      }).onConflictDoNothing();
      s += 1;
    }
    return { gold: g, silver: s };
  }

  async runReferenceEval(experimentId: string) {
    const [exp] = await db.select().from(experiments).where(eq(experiments.id, experimentId)).limit(1);
    if (!exp) throw new NotFoundException('Experiment ' + experimentId + ' not found');
    const refs = await db.select().from(goldStandardReferences);
    const variants: Array<{ variantId: string; strategy: AuditStrategy }> = [
      { variantId: 'control', strategy: exp.controlStrategy },
      ...exp.treatmentStrategies.map((s, i) => ({ variantId: 'treatment-' + (i + 1), strategy: s })),
    ];
    for (const ref of refs) {
      const standards = (ref.codeStandards ?? {}) as { guidelines?: FlowGuideline[] };
      const input = {
        prTitle: 'reference ' + ref.referenceType,
        diffContent: ref.codeSnippet ?? '',
        taskDescription: ref.taskDescription ?? undefined,
        guidelines: standards.guidelines ?? [],
      };
      for (const v of variants) {
        const outcome = await this.flowRunner.run(v.strategy, input);
        const summary = outcome.summary ?? '';
        const f1 = precisionRecallF1(ref.referenceReview, summary);
        const sim = editSimilarity(ref.referenceReview, summary);
        this.metrics.recordReferenceEvalF1(v.variantId, f1.f1);
        this.metrics.recordReviewCosts(
          outcome.latencyMs,
          outcome.promptTokens,
          outcome.completionTokens,
          costUsdOf(v.strategy.modelId, outcome.promptTokens, outcome.completionTokens),
        );
        await db.insert(referenceEvals).values({
          experimentId,
          referenceId: ref.id,
          variantId: v.variantId,
          strategySnapshot: v.strategy,
          precision: f1.precision,
          recall: f1.recall,
          f1: f1.f1,
          lexicalSimilarity: sim,
          latencyMs: outcome.latencyMs,
          promptTokens: outcome.promptTokens,
          completionTokens: outcome.completionTokens,
          costUsd: costUsdOf(v.strategy.modelId, outcome.promptTokens, outcome.completionTokens),
        });
      }
    }
    return { references: refs.length, variants: variants.length };
  }

  async getEvalReport(experimentId: string) {
    const [exp] = await db.select().from(experiments).where(eq(experiments.id, experimentId)).limit(1);
    if (!exp) throw new NotFoundException('Experiment ' + experimentId + ' not found');
    const evals = await db.select().from(referenceEvals).where(eq(referenceEvals.experimentId, experimentId));
    const groups = new Map<string, typeof evals>();
    for (const e of evals) {
      const list = groups.get(e.variantId) ?? [];
      list.push(e);
      groups.set(e.variantId, list);
    }
    const variantIds = ['control', ...exp.treatmentStrategies.map((_, i) => 'treatment-' + (i + 1))];
    const arms = variantIds.map((variantId) => {
      const rows = groups.get(variantId) ?? [];
      const strategy = variantId === 'control' ? exp.controlStrategy : exp.treatmentStrategies[Number(variantId.split('-')[1]) - 1];
      const f1s = rows.map((r) => r.f1).filter((v): v is number => v !== null);
      const prec = rows.map((r) => r.precision).filter((v): v is number => v !== null);
      const rec = rows.map((r) => r.recall).filter((v): v is number => v !== null);
      const lex = rows.map((r) => r.lexicalSimilarity).filter((v): v is number => v !== null);
      const lat = rows.map((r) => r.latencyMs).filter((v): v is number => v !== null);
      const costs = rows.map((r) => r.costUsd).filter((v): v is number => v !== null);
      return {
        variantId,
        vendor: strategy?.vendor ?? null,
        modelId: strategy?.modelId ?? null,
        flow: strategy?.flow ?? 'sequential',
        n: rows.length,
        meanF1: f1s.length ? mean(f1s) : null,
        f1CI: f1s.length >= 2 ? meanCI(f1s) : null,
        meanPrecision: prec.length ? mean(prec) : null,
        meanRecall: rec.length ? mean(rec) : null,
        meanLexicalSimilarity: lex.length ? mean(lex) : null,
        meanLatencyMs: lat.length ? mean(lat) : null,
        meanCostUsd: costs.length ? mean(costs) : null,
        f1s,
        lat,
      };
    });
    const control = arms.find((a) => a.variantId === 'control');
    const scored = arms.map((a) => {
      if (!control || a.variantId === 'control') {
        const { f1s: _f, lat: _l, ...rest } = a as typeof a & { f1s: unknown; lat: unknown };
        void _f; void _l;
        return { ...rest, vsControl: null };
      }
      const f1T = welchTTest(control.f1s, a.f1s);
      const f1D = cohensD(control.f1s, a.f1s);
      const latD = cohensD(control.lat, a.lat);
      const { f1s: _f, lat: _l, ...rest } = a as typeof a & { f1s: unknown; lat: unknown };
      void _f; void _l;
      return {
        ...rest,
        vsControl: {
          f1Delta: a.meanF1 !== null && control.meanF1 !== null ? a.meanF1 - control.meanF1 : null,
          f1T: f1T.t,
          f1P: f1T.pValue,
          f1CohenD: f1D,
          latencyCohenD: latD,
        },
      };
    });
    return {
      experiment: exp,
      arms: scored,
      caveat: 'References derive from human acceptance/modification, not an objective oracle.',
    };
  }
}