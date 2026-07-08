// ============================================================================
// @aigov/shared-types — Shared TypeScript interfaces and enums
// ============================================================================

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum EnforcementMode {
  ADVISORY = 'advisory',
  SCOPE_ONLY = 'scope_only',
  FULL = 'full',
}

export enum AuditVerdict {
  PASS = 'pass',
  FAIL = 'fail',
  WARNING = 'warning',
}

export enum Severity {
  ERROR = 'error',
  WARNING = 'warning',
  INFO = 'info',
}

export enum TaskSource {
  JIRA = 'jira',
  LINEAR = 'linear',
  MANUAL = 'manual',
}

export enum DecompositionConfidence {
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
}

export enum DeveloperRating {
  TOO_NARROW = 'too_narrow',
  JUST_RIGHT = 'just_right',
  TOO_BROAD = 'too_broad',
}

export enum SubTaskStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  DONE = 'done',
}

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

export interface Organization {
  id: string;
  name: string;
  slug: string;
  enforcementMode: EnforcementMode;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface Repository {
  id: string;
  organizationId: string;
  name: string;
  fullName: string;
  provider: 'github' | 'gitlab' | 'bitbucket';
  webhookSecret: string;
  reviewBranches: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// API Key
// ---------------------------------------------------------------------------

export interface ApiKey {
  id: string;
  organizationId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  isRevoked: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Code Guideline (Standard)
// ---------------------------------------------------------------------------

export interface CodeGuideline {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  pattern: string;
  severity: Severity;
  category: string;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// AI Audit
// ---------------------------------------------------------------------------

export interface AiAudit {
  id: string;
  organizationId: string;
  repositoryId: string;
  prNumber: number;
  prTitle: string;
  commitSha: string;
  verdict: AuditVerdict;
  totalViolations: number;
  errorCount: number;
  warningCount: number;
  scopeCreepDetected: boolean;
  complianceScore: number | null;
  efficiencyScore: number | null;
  coverageScore: number | null;
  actualLoc: number;
  estimatedLoc: number;
  auditDurationMs: number;
  completedAt: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Scope Violation
// ---------------------------------------------------------------------------

export interface ScopeViolation {
  id: string;
  auditId: string;
  filePath: string;
  violationType: 'unexpected_file' | 'loc_explosion' | 'forbidden_touch';
  description: string;
  actualLoc?: number;
  expectedLoc?: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Decomposed Task
// ---------------------------------------------------------------------------

export interface DecomposedTask {
  id: string;
  organizationId: string;
  repositoryId: string;
  source: TaskSource;
  sourceTaskId: string;
  sourceTaskTitle: string;
  parentTaskId: string | null;
  confidence: DecompositionConfidence;
  needsClarification: boolean;
  humanOverridesNeeded: number;
  estimatedLoc: number;
  filesInScope: string[];
  filesForbidden: string[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Sub Task — quantifiable breakdown of a decomposed task
// ---------------------------------------------------------------------------

export interface SubTask {
  id: string;
  decomposedTaskId: string;
  title: string;
  description: string;
  estimatedLoc: number;
  filesInScope: string[];
  acceptanceCriteria: string[];
  complexity: number;
  priority: number;
  status: SubTaskStatus;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Decomposition Feedback
// ---------------------------------------------------------------------------

export interface DecompositionFeedback {
  id: string;
  decomposedTaskId: string;
  developerRating: DeveloperRating;
  developerComment: string | null;
  missedFiles: string[];
  unnecessaryFiles: string[];
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Enforcement Event
// ---------------------------------------------------------------------------

export interface EnforcementEvent {
  id: string;
  organizationId: string;
  previousMode: EnforcementMode;
  newMode: EnforcementMode;
  changedBy: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Webhook Payloads
// ---------------------------------------------------------------------------

export interface GitHubPREvent {
  action: 'opened' | 'synchronize' | 'reopened';
  pull_request: {
    number: number;
    title: string;
    head: { sha: string; ref: string };
    base: { ref: string };
    html_url: string;
  };
  repository: {
    full_name: string;
    clone_url: string;
  };
}

export interface JiraIssueEvent {
  issue: {
    id: string;
    key: string;
    fields: {
      summary: string;
      description: string;
      status: { name: string };
    };
  };
}

export interface LinearIssueEvent {
  action: 'create' | 'update';
  data: {
    id: string;
    title: string;
    description: string;
    state: { name: string };
  };
}

// ---------------------------------------------------------------------------
// API Response wrappers
// ---------------------------------------------------------------------------

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ApiError {
  statusCode: number;
  message: string;
  error: string;
}

export interface ApiResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Audit / Standards context
// ---------------------------------------------------------------------------

export interface StandardsContext {
  organizationId: string;
  guidelines: Pick<CodeGuideline, 'name' | 'description' | 'pattern' | 'severity'>[];
  topViolations: Array<{
    guidelineId: string;
    guidelineName: string;
    count: number;
  }>;
  generatedAt: string;
}

export interface DecompositionRequest {
  organizationId: string;
  repositoryId: string;
  source: TaskSource;
  sourceTaskId: string;
  sourceTaskTitle: string;
  sourceTaskDescription: string;
  /** Parent task for hierarchical decomposition (sprint → tasks → sub-tasks) */
  parentTaskId?: string;
  /** Sprint context — improves decomposition accuracy by understanding the bigger goal */
  sprintTitle?: string;
  sprintGoal?: string;
}

export interface AuditRequest {
  organizationId: string;
  repositoryId: string;
  prNumber: number;
  prTitle: string;
  commitSha: string;
  diffContent: string;
  /** Full content of each changed file, keyed by path. Used by AI-powered analysis. */
  changedFiles?: Record<string, string>;
  /** Task description from the issue tracker — used for requirement coverage scoring */
  taskDescription?: string;
}

export interface StandardsContextMarkdown {
  contextMarkdown: string;
  organizationId: string;
  generatedAt: string;
}
