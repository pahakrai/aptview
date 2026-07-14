import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  pgEnum,
} from 'drizzle-orm/pg-core';

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
