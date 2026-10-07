import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * MetricsService - exposes Prometheus metrics for the review / A/B / eval
 * pipelines. A single Registry holds counters and histograms; the
 * MetricsController renders it at /metrics (plain text).
 */
@Injectable()
export class MetricsService {
  private readonly registry = new Registry();

  readonly reviewDecisionsTotal: Counter<string>;
  readonly reviewStarRating: Histogram<string>;
  readonly reviewLatencySeconds: Histogram<string>;
  readonly reviewTokensTotal: Counter<string>;
  readonly reviewCostUsd: Histogram<string>;
  readonly experimentRunsTotal: Counter<string>;
  readonly benchmarkRunsTotal: Counter<string>;
  readonly referenceEvalF1: Histogram<string>;
  readonly flowPromotionsTotal: Counter<string>;
  readonly telemetryTotal: Counter<string>;

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'aigov_' });

    this.reviewDecisionsTotal = new Counter({
      name: 'aigov_review_decisions_total',
      help: 'Human review decisions (approve / revise / cancel)',
      labelNames: ['action'],
      registers: [this.registry],
    });
    this.reviewStarRating = new Histogram({
      name: 'aigov_review_star_rating',
      help: 'Star rating given by the reviewer (1-5)',
      buckets: [1, 2, 3, 4, 5],
      registers: [this.registry],
    });
    this.reviewLatencySeconds = new Histogram({
      name: 'aigov_review_latency_seconds',
      help: 'Review latency in seconds',
      buckets: [1, 5, 10, 30, 60, 120, 300],
      registers: [this.registry],
    });
    this.reviewTokensTotal = new Counter({
      name: 'aigov_review_tokens_total',
      help: 'Total tokens consumed by reviews',
      labelNames: ['kind'],
      registers: [this.registry],
    });
    this.reviewCostUsd = new Histogram({
      name: 'aigov_review_cost_usd',
      help: 'Cost per review in USD',
      buckets: [0.0001, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
      registers: [this.registry],
    });
    this.experimentRunsTotal = new Counter({
      name: 'aigov_experiment_runs_total',
      help: 'Experiment observations',
      labelNames: ['variant_id', 'verdict'],
      registers: [this.registry],
    });
    this.benchmarkRunsTotal = new Counter({
      name: 'aigov_benchmark_runs_total',
      help: 'Benchmark jobs by status',
      labelNames: ['status'],
      registers: [this.registry],
    });
    this.referenceEvalF1 = new Histogram({
      name: 'aigov_reference_eval_f1',
      help: 'F1 score of a variant against a reference',
      labelNames: ['variant_id'],
      buckets: [0, 0.2, 0.4, 0.6, 0.8, 1],
      registers: [this.registry],
    });
    this.flowPromotionsTotal = new Counter({
      name: 'aigov_flow_promotions_total',
      help: 'Active flow promotions',
      labelNames: ['scope'],
      registers: [this.registry],
    });
    this.telemetryTotal = new Counter({
      name: 'aigov_telemetry_total',
      help: 'Review telemetry rows recorded',
      labelNames: ['action'],
      registers: [this.registry],
    });
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }

  recordReviewDecision(action: string): void {
    this.reviewDecisionsTotal.inc({ action });
  }

  recordStarRating(rating: number | null | undefined): void {
    if (rating !== null && rating !== undefined && rating >= 1 && rating <= 5) {
      this.reviewStarRating.observe(rating);
    }
  }

  recordReviewCosts(latencyMs: number | null, promptTokens: number, completionTokens: number, costUsd: number | null): void {
    if (latencyMs !== null && latencyMs !== undefined) {
      this.reviewLatencySeconds.observe(latencyMs / 1000);
    }
    if (promptTokens) this.reviewTokensTotal.inc({ kind: 'prompt' }, promptTokens);
    if (completionTokens) this.reviewTokensTotal.inc({ kind: 'completion' }, completionTokens);
    if (costUsd !== null && costUsd !== undefined) this.reviewCostUsd.observe(costUsd);
  }

  recordExperimentRun(variantId: string, verdict: string): void {
    this.experimentRunsTotal.inc({ variant_id: variantId, verdict });
  }

  recordBenchmarkRun(status: string): void {
    this.benchmarkRunsTotal.inc({ status });
  }

  recordReferenceEvalF1(variantId: string, f1: number): void {
    this.referenceEvalF1.observe({ variant_id: variantId }, f1);
  }

  recordPromotion(scope: string): void {
    this.flowPromotionsTotal.inc({ scope });
  }

  recordTelemetry(action: string | null | undefined): void {
    this.telemetryTotal.inc({ action: action ?? 'none' });
  }
}
