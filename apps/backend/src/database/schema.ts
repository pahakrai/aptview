import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  real,
  jsonb,
  index,
  uniqueIndex,
  pgEnum,
} from 'drizzle-orm/pg-core';
import type {
  AuditStrategy,
  BenchmarkInputSnapshot,
  MetricsWeights,
} from '@aigov/shared-types';

// ============================================================================
// Enums
// ============================================================================

export const enforcementModeEnum = pgEnum('enforcement_mode', [
  'advisory',
  'scope_only',
  'full',
]);

export const auditVerdictEnum = pgEnum('audit_verdict', [
  'pass',
  'fail',
  'warning',
]);

export const severityEnum = pgEnum('severity', [
  'error',
  'warning',
  'info',
]);

export const taskSourceEnum = pgEnum('task_source', [
  'jira',
  'linear',
  'manual',
]);

export const subTaskStatusEnum = pgEnum('sub_task_status', [
  'pending',
  'in_progress',
  'done',
]);

export const decompositionConfidenceEnum = pgEnum('decomposition_confidence', [
  'high',
  'medium',
  'low',
]);

export const developerRatingEnum = pgEnum('developer_rating', [
  'too_narrow',
  'just_right',
  'too_broad',
]);

export const experimentStatusEnum = pgEnum('experiment_status', [
  'draft',
  'running',
  'paused',
  'completed',
]);

export const reviewDecisionActionEnum = pgEnum('review_decision_action', [
  'approve',
  'revise',
  'cancel',
]);

export const runSourceEnum = pgEnum('run_source', [
  'live',
  'benchmark',
]);

export const benchmarkJobStatusEnum = pgEnum('benchmark_job_status', [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export const referenceTypeEnum = pgEnum('reference_type', [
  'gold',
  'silver',
]);

// ============================================================================
// Tables
// ============================================================================

/**
 * organizations — tenants of the platform.
 */
export const organizations = pgTable('organizations', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  enforcementMode: enforcementModeEnum('enforcement_mode')
    .notNull()
    .default('advisory'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * repositories — linked repositories per organization.
 */
export const repositories = pgTable('repositories', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  fullName: varchar('full_name', { length: 512 }).notNull(),
  provider: varchar('provider', { length: 50 }).notNull().default('github'),
  webhookSecret: varchar('webhook_secret', { length: 255 }),
  reviewBranches: jsonb('review_branches')
    .$type<string[]>()
    .default(['dev'])
    .notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * api_keys — organization-scoped API tokens.
 */
export const apiKeys = pgTable('api_keys', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  keyHash: varchar('key_hash', { length: 255 }).notNull().unique(),
  keyPrefix: varchar('key_prefix', { length: 12 }).notNull(),
  lastUsedAt: timestamp('last_used_at'),
  expiresAt: timestamp('expires_at'),
  isRevoked: boolean('is_revoked').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * code_guidelines — organization-specific coding standards / rules.
 */
export const codeGuidelines = pgTable('code_guidelines', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  pattern: text('pattern').notNull(),
  severity: severityEnum('severity').notNull().default('warning'),
  category: varchar('category', { length: 100 }).default('general'),
  isEnabled: boolean('is_enabled').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * ai_audits — audit results per PR.
 */
export const aiAudits = pgTable('ai_audits', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  repositoryId: uuid('repository_id')
    .notNull()
    .references(() => repositories.id, { onDelete: 'cascade' }),
  prNumber: integer('pr_number').notNull(),
  prTitle: varchar('pr_title', { length: 512 }),
  commitSha: varchar('commit_sha', { length: 40 }).notNull(),
  verdict: auditVerdictEnum('verdict').notNull(),
  totalViolations: integer('total_violations').default(0).notNull(),
  errorCount: integer('error_count').default(0).notNull(),
  warningCount: integer('warning_count').default(0).notNull(),
  scopeCreepDetected: boolean('scope_creep_detected').default(false).notNull(),
  complianceScore: integer('compliance_score'),
  efficiencyScore: integer('efficiency_score'),
  coverageScore: integer('coverage_score'),
  actualLoc: integer('actual_loc'),
  estimatedLoc: integer('estimated_loc'),
  auditDurationMs: integer('audit_duration_ms'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * scope_violations — detected scope creep events within an audit.
 */
export const scopeViolations = pgTable('scope_violations', {
  id: uuid('id').defaultRandom().primaryKey(),
  auditId: uuid('audit_id')
    .notNull()
    .references(() => aiAudits.id, { onDelete: 'cascade' }),
  filePath: varchar('file_path', { length: 1024 }).notNull(),
  violationType: varchar('violation_type', { length: 50 }).notNull(),
  description: text('description'),
  actualLoc: integer('actual_loc'),
  expectedLoc: integer('expected_loc'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * decomposed_tasks — AI-generated task-scope breakouts.
 */
export const decomposedTasks = pgTable('decomposed_tasks', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  repositoryId: uuid('repository_id')
    .notNull()
    .references(() => repositories.id, { onDelete: 'cascade' }),
  source: taskSourceEnum('source').notNull(),
  sourceTaskId: varchar('source_task_id', { length: 255 }).notNull(),
  sourceTaskTitle: varchar('source_task_title', { length: 512 }),
  parentTaskId: uuid('parent_task_id'),
  confidence: decompositionConfidenceEnum('confidence')
    .notNull()
    .default('medium'),
  needsClarification: boolean('needs_clarification').default(false).notNull(),
  humanOverridesNeeded: integer('human_overrides_needed').default(0).notNull(),
  estimatedLoc: integer('estimated_loc').default(0).notNull(),
  filesInScope: jsonb('files_in_scope').$type<string[]>().default([]).notNull(),
  filesForbidden: jsonb('files_forbidden').$type<string[]>().default([]).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * decomposition_feedback — developer ratings of decomposition quality.
 */
export const decompositionFeedback = pgTable('decomposition_feedback', {
  id: uuid('id').defaultRandom().primaryKey(),
  decomposedTaskId: uuid('decomposed_task_id')
    .notNull()
    .references(() => decomposedTasks.id, { onDelete: 'cascade' }),
  developerRating: developerRatingEnum('developer_rating').notNull(),
  developerComment: text('developer_comment'),
  missedFiles: jsonb('missed_files').$type<string[]>().default([]).notNull(),
  unnecessaryFiles: jsonb('unnecessary_files').$type<string[]>().default([]).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * sub_tasks — AI-generated sub-task breakdowns from task decomposition.
 *
 * Each decomposed task can produce 1–N quantifiable sub-tasks with:
 *   - Concrete acceptance criteria (measurable "done" conditions)
 *   - Complexity rating (1–5 scale)
 *   - File boundaries and LOC estimates
 *   - Lifecycle status tracking
 */
export const subTasks = pgTable('sub_tasks', {
  id: uuid('id').defaultRandom().primaryKey(),
  decomposedTaskId: uuid('decomposed_task_id')
    .notNull()
    .references(() => decomposedTasks.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 512 }).notNull(),
  description: text('description'),
  estimatedLoc: integer('estimated_loc').default(0).notNull(),
  filesInScope: jsonb('files_in_scope').$type<string[]>().default([]).notNull(),
  acceptanceCriteria: jsonb('acceptance_criteria')
    .$type<string[]>()
    .default([])
    .notNull(),
  complexity: integer('complexity').default(3).notNull(),
  priority: integer('priority').default(0).notNull(),
  status: subTaskStatusEnum('status').notNull().default('pending'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * enforcement_events — audit log of enforcement mode changes.
 */
export const enforcementEvents = pgTable('enforcement_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  previousMode: enforcementModeEnum('previous_mode').notNull(),
  newMode: enforcementModeEnum('new_mode').notNull(),
  changedBy: varchar('changed_by', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ============================================================================
// SSO Tables — OAuth 2.0 / OpenID Connect Authorization Server
// ============================================================================

/**
 * sso_users — internal user accounts for SSO authentication.
 */
export const ssoUsers = pgTable('sso_users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  attributes: jsonb('attributes').$type<Record<string, unknown>>().default({}).notNull(),
  lastLoginAt: timestamp('last_login_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * oauth_clients — registered applications authorized to use SSO.
 */
export const oauthClients = pgTable('oauth_clients', {
  id: uuid('id').defaultRandom().primaryKey(),
  clientId: varchar('client_id', { length: 100 }).notNull().unique(),
  clientSecretHash: varchar('client_secret_hash', { length: 255 }).notNull(),
  clientName: varchar('client_name', { length: 255 }).notNull(),
  allowedRedirectUris: jsonb('allowed_redirect_uris').$type<string[]>().default([]).notNull(),
  audienceTarget: varchar('audience_target', { length: 255 }),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * oauth_authorization_codes — single-use codes exchanged for tokens.
 * Codes expire after 5 minutes.
 */
export const oauthAuthorizationCodes = pgTable('oauth_authorization_codes', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: varchar('code', { length: 64 }).notNull().unique(),
  userId: uuid('user_id')
    .notNull()
    .references(() => ssoUsers.id, { onDelete: 'cascade' }),
  clientId: varchar('client_id', { length: 100 }).notNull(),
  redirectUri: varchar('redirect_uri', { length: 1024 }).notNull(),
  isUsed: boolean('is_used').default(false).notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ============================================================================
// A/B Experiments — model & strategy evaluation (feature-flagged)
// ============================================================================

/**
 * experiments — a feature-flagged A/B test: one control strategy vs N treatments.
 * When no experiment is `running` (or EXPERIMENTS_ENABLED is off), the audit
 * pipeline is completely unaffected.
 */
export const experiments = pgTable('experiments', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  organizationId: uuid('organization_id')
    .references(() => organizations.id, { onDelete: 'cascade' }), // null = global experiment
  status: experimentStatusEnum('status').notNull().default('draft'),
  rolloutPercent: integer('rollout_percent').default(0).notNull(),
  minSampleSize: integer('min_sample_size').default(50).notNull(),
  controlStrategy: jsonb('control_strategy').$type<AuditStrategy>().notNull(),
  treatmentStrategies: jsonb('treatment_strategies')
    .$type<AuditStrategy[]>()
    .default([])
    .notNull(),
  metricsWeights: jsonb('metrics_weights').$type<MetricsWeights>().notNull(),
  startedAt: timestamp('started_at'),
  endedAt: timestamp('ended_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * experiment_runs — one observation per audited PR that hit a variant bucket.
 * Denormalized `vendor` + `modelId` columns power the hierarchical report.
 */
export const experimentRuns = pgTable('experiment_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  experimentId: uuid('experiment_id')
    .notNull()
    .references(() => experiments.id, { onDelete: 'cascade' }),
  variantId: varchar('variant_id', { length: 50 }).notNull(),
  auditId: uuid('audit_id').references(() => aiAudits.id, { onDelete: 'set null' }),
  prNumber: integer('pr_number').notNull(),
  vendor: varchar('vendor', { length: 50 }).notNull(),
  modelId: varchar('model_id', { length: 100 }).notNull(),
  repositoryFullName: varchar('repository_full_name', { length: 512 }),
  strategySnapshot: jsonb('strategy_snapshot').$type<AuditStrategy>().notNull(),
  source: runSourceEnum('source').notNull().default('live'),
  inputSnapshot: jsonb('input_snapshot').$type<BenchmarkInputSnapshot>(),
  toolCalls: integer('tool_calls'),
  verdict: auditVerdictEnum('verdict'),
  complianceScore: integer('compliance_score'),
  efficiencyScore: integer('efficiency_score'),
  coverageScore: integer('coverage_score'),
  latencyMs: integer('latency_ms'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  agreedWithInline: boolean('agreed_with_inline'),
  parseOk: boolean('parse_ok'),
  humanDecision: reviewDecisionActionEnum('human_decision'),
  humanAccepted: boolean('human_accepted'),
  revisionCount: integer('revision_count'),
  acceptedAt: timestamp('accepted_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  experimentRunsExperimentIdx: index('experiment_runs_experiment_idx').on(
    table.experimentId,
  ),
  experimentRunsRepoPrIdx: index('experiment_runs_repo_pr_idx').on(
    table.repositoryFullName,
    table.prNumber,
  ),
}));

/**
 * review_decisions — durable record of each human code-reviewer decision
 * (approve / revise / cancel) on a HITL review. Correlates to experiment_runs
 * via (repository_full_name, pr_number) so reviewer acceptance becomes an
 * A/B evaluation metric.
 */
export const reviewDecisions = pgTable('review_decisions', {
  id: uuid('id').defaultRandom().primaryKey(),
  threadId: varchar('thread_id', { length: 255 }).notNull(),
  prNumber: integer('pr_number').notNull(),
  repositoryFullName: varchar('repository_full_name', { length: 512 }).notNull(),
  action: reviewDecisionActionEnum('action').notNull(),
  revisionCount: integer('revision_count').default(0).notNull(),
  note: text('note'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  reviewDecisionsRepoPrIdx: index('review_decisions_repo_pr_idx').on(
    table.repositoryFullName,
    table.prNumber,
  ),
}));

// ============================================================================
// Deliberate Flow A/B — architecture ranking + promotion ("the plugin")
// ============================================================================

/**
 * admin_rankings — a manual 1..N ordering of an arm's output for one PR.
 * Normalized into the final score's ranking vector. Re-rankable (upsert).
 */
export const adminRankings = pgTable('admin_rankings', {
  id: uuid('id').defaultRandom().primaryKey(),
  experimentId: uuid('experiment_id')
    .notNull()
    .references(() => experiments.id, { onDelete: 'cascade' }),
  repositoryFullName: varchar('repository_full_name', { length: 512 }).notNull(),
  prNumber: integer('pr_number').notNull(),
  variantId: varchar('variant_id', { length: 50 }).notNull(),
  rank: integer('rank').notNull(),
  note: text('note'),
  rankedBy: varchar('ranked_by', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  adminRankingsUniqueVote: uniqueIndex('admin_rankings_unique_vote').on(
    table.experimentId,
    table.repositoryFullName,
    table.prNumber,
    table.variantId,
  ),
  adminRankingsExperimentIdx: index('admin_rankings_experiment_idx').on(
    table.experimentId,
  ),
  adminRankingsRepoPrIdx: index('admin_rankings_repo_pr_idx').on(
    table.repositoryFullName,
    table.prNumber,
  ),
}));

/**
 * active_flows — a promoted flow variant ("the plugin"): the architecture that
 * becomes the default live reviewer for an org/repo. Append-only history: each
 * promotion inserts a new row; the "active" flow for a scope is the latest
 * (highest version / promotedAt). Repo-scoped rows override org-scoped;
 * previousId forms the rollback chain.
 *
 * Scope convention:
 *   - org-scoped row:  organizationId set, repositoryId NULL.
 *   - repo-scoped row: repositoryId set, organizationId NULL (derivable from
 *     repositories.organizationId).
 */
export const activeFlows = pgTable('active_flows', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id').references(() => organizations.id, {
    onDelete: 'cascade',
  }),
  repositoryId: uuid('repository_id').references(() => repositories.id, {
    onDelete: 'cascade',
  }),
  variant: jsonb('variant').$type<AuditStrategy>().notNull(),
  version: integer('version').default(1).notNull(),
  promotedBy: varchar('promoted_by', { length: 255 }).notNull(),
  promotedAt: timestamp('promoted_at').defaultNow().notNull(),
  previousId: uuid('previous_id'),
}, (table) => ({
  activeFlowsOrgIdx: index('active_flows_org_idx').on(table.organizationId),
  activeFlowsRepoIdx: index('active_flows_repo_idx').on(table.repositoryId),
}));

/**
 * active_flow_runs — one observation per PR reviewed by a promoted flow
 * (the plugin). Correlates to review_decisions via (repository_full_name,
 * pr_number) so a promoted architecture keeps accumulating live HITL
 * acceptance — the post-promotion flywheel.
 */
export const activeFlowRuns = pgTable('active_flow_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  activeFlowId: uuid('active_flow_id')
    .notNull()
    .references(() => activeFlows.id, { onDelete: 'cascade' }),
  repositoryFullName: varchar('repository_full_name', { length: 512 }).notNull(),
  prNumber: integer('pr_number').notNull(),
  verdict: auditVerdictEnum('verdict'),
  complianceScore: integer('compliance_score'),
  efficiencyScore: integer('efficiency_score'),
  coverageScore: integer('coverage_score'),
  latencyMs: integer('latency_ms'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  toolCalls: integer('tool_calls'),
  flow: varchar('flow', { length: 50 }),
  humanDecision: reviewDecisionActionEnum('human_decision'),
  humanAccepted: boolean('human_accepted'),
  revisionCount: integer('revision_count'),
  acceptedAt: timestamp('accepted_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  activeFlowRunsUnique: uniqueIndex('active_flow_runs_unique').on(
    table.activeFlowId,
    table.repositoryFullName,
    table.prNumber,
  ),
  activeFlowRunsRepoPrIdx: index('active_flow_runs_repo_pr_idx').on(
    table.repositoryFullName,
    table.prNumber,
  ),
}));

/**
 * benchmark_jobs — an async deliberate benchmark run. One job runs every arm
 * of an experiment against a snapshot input; status is polled by the UI and
 * surfaced via notifications.
 */
export const benchmarkJobs = pgTable('benchmark_jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  experimentId: uuid('experiment_id')
    .notNull()
    .references(() => experiments.id, { onDelete: 'cascade' }),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  status: benchmarkJobStatusEnum('status').notNull().default('queued'),
  inputSnapshot: jsonb('input_snapshot').$type<BenchmarkInputSnapshot>(),
  error: text('error'),
  createdBy: varchar('created_by', { length: 255 }),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  benchmarkJobsExperimentIdx: index('benchmark_jobs_experiment_idx').on(
    table.experimentId,
  ),
}));

/**
 * notifications — durable in-app notices (e.g. a benchmark job finishing or
 * failing). The UI polls these or renders them from a notification bell.
 */
export const notifications = pgTable('notifications', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id').references(() => organizations.id, {
    onDelete: 'cascade',
  }),
  type: varchar('type', { length: 100 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  body: text('body'),
  read: boolean('read').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  notificationsOrgIdx: index('notifications_org_idx').on(table.organizationId),
}));

// ============================================================================
// Reference-based evaluation — implicit labeling from production data
// ============================================================================

/**
 * review_telemetry — structured log of one production review interaction.
 * The human action (accept / revise / cancel) + optional star rating are the
 * implicit labels; gold/silver references are promoted from these rows.
 */
export const reviewTelemetry = pgTable('review_telemetry', {
  id: uuid('id').defaultRandom().primaryKey(),
  traceId: varchar('trace_id', { length: 255 }).notNull().unique(),
  experimentId: uuid('experiment_id').references(() => experiments.id, {
    onDelete: 'set null',
  }),
  variantId: varchar('variant_id', { length: 50 }),
  organizationId: uuid('organization_id').references(() => organizations.id, {
    onDelete: 'set null',
  }),
  codeSnippet: text('code_snippet'),
  taskDescription: text('task_description'),
  codeStandards: jsonb('code_standards').$type<Record<string, unknown>>(),
  aiReviewOutput: text('ai_review_output'),
  humanAction: reviewDecisionActionEnum('human_action'),
  humanModifiedReview: text('human_modified_review'),
  starRating: integer('star_rating'),
  latencyMs: integer('latency_ms'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  costUsd: real('cost_usd'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  reviewTelemetryExperimentIdx: index('review_telemetry_experiment_idx').on(
    table.experimentId,
  ),
  reviewTelemetryActionIdx: index('review_telemetry_action_idx').on(table.humanAction),
}));

/**
 * gold_standard_references — auto-promoted reference cases.
 *   gold   = human modified the review (final version is closest to truth).
 *   silver = human accepted without modification (weak but abundant).
 */
export const goldStandardReferences = pgTable('gold_standard_references', {
  id: uuid('id').defaultRandom().primaryKey(),
  traceId: varchar('trace_id', { length: 255 }).notNull().unique(),
  codeSnippet: text('code_snippet'),
  taskDescription: text('task_description'),
  codeStandards: jsonb('code_standards').$type<Record<string, unknown>>(),
  referenceReview: text('reference_review').notNull(),
  referenceType: referenceTypeEnum('reference_type').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * reference_evals — one row per (reference, variant): the variant's output
 * scored against the reference (F1 / lexical similarity / latency / cost).
 */
export const referenceEvals = pgTable('reference_evals', {
  id: uuid('id').defaultRandom().primaryKey(),
  experimentId: uuid('experiment_id')
    .notNull()
    .references(() => experiments.id, { onDelete: 'cascade' }),
  referenceId: uuid('reference_id')
    .notNull()
    .references(() => goldStandardReferences.id, { onDelete: 'cascade' }),
  variantId: varchar('variant_id', { length: 50 }).notNull(),
  strategySnapshot: jsonb('strategy_snapshot').$type<AuditStrategy>(),
  precision: real('precision'),
  recall: real('recall'),
  f1: real('f1'),
  lexicalSimilarity: real('lexical_similarity'),
  latencyMs: integer('latency_ms'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  costUsd: real('cost_usd'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  referenceEvalsExperimentIdx: index('reference_evals_experiment_idx').on(
    table.experimentId,
  ),
  referenceEvalsRefIdx: index('reference_evals_ref_idx').on(table.referenceId),
  referenceEvalsVariantIdx: index('reference_evals_variant_idx').on(table.variantId),
}));
