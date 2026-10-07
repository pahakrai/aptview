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
  /** GitHub "owner/repo" full name — correlates the audit with its HITL review decision. */
  repositoryFullName?: string;
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

// ============================================================================
// A/B Experiments — model & strategy evaluation (feature-flagged)
// ============================================================================

/** Top-level model vendor. Reporting groups by this, then by modelId. */
export type ModelVendor = 'deepseek' | 'claude' | 'gemini';

/** Cross-vendor capability tier (used to draw "flash vs flash" comparisons). */
export type ModelTier = 'flash' | 'base' | 'pro' | 'reasoner';

export interface ModelEntry {
  vendor: ModelVendor;
  modelId: string;
  label: string;
  tier: ModelTier;
}

/** How an audit is produced. `deepseek` = direct DeepSeek chat API (new, additive). */
export type AuditEngine = 'inline' | 'sdk' | 'sandbox' | 'deepseek';

export type PromptVariant = 'baseline' | 'json' | 'cot' | 'few-shot';

/**
 * How an agent is architected. sequential = fixed pipeline (harness, one
 * LLM call); orchestrator = planner + LangGraph tool loop (skills + MCP).
 */
export type FlowType = 'sequential' | 'orchestrator';

/** A single tool capability an orchestrator arm may call. */
export interface ToolSpec {
  kind: 'skill' | 'mcp';
  /** Catalog id — a local skill name or an MCP server source (e.g. "k8s"). */
  name: string;
  /** v1 default: read-only. Writable tools require explicit opt-in. */
  readOnly?: boolean;
}

/**
 * Per-arm tool chain for an orchestrator agent. Skills are the baseline
 * (in-process review helpers); MCP servers are an OPTIONAL add-on (external
 * tools). An empty skills array means "all built-in skills"; an empty mcp
 * array means "no MCP servers" (skills only).
 */
/** A single configurable field on a tool (skill or MCP server). */
export interface ToolConfigField {
  key: string;
  label: string;
  /** UI control type. */
  type: 'string' | 'text' | 'number' | 'boolean' | 'enum' | 'secret';
  description?: string;
  required?: boolean;
  /** Default value (used when the user leaves the field blank). */
  default?: unknown;
  /** Choices for type 'enum'. */
  enumValues?: string[];
  placeholder?: string;
}

/** The set of configurable fields a tool declares. */
export interface ToolConfigSchema {
  fields: ToolConfigField[];
}

/** A tool (skill or MCP server) as declared by the catalog. */
export interface ToolCatalogEntry {
  kind: 'skill' | 'mcp';
  name: string;
  description: string;
  configSchema: ToolConfigSchema;
  /** Function-calling parameters (skills only). */
  parameters?: Record<string, unknown>;
}

export interface ToolChain {
  /** Skill names to enable (empty = all built-in). */
  skills: string[];
  /** MCP server source names to connect (empty = none). */
  mcp: string[];
  /** Per-tool instance configuration, keyed by tool name. */
  toolConfig?: Record<string, Record<string, unknown>>;
}

/**
 * v1 preset flow diagram. version 1 is a fixed preset; rich node/edge
 * editing (draw.io-style) is stored in a richer schema in a later version.
 */
/** What kind of step a flow node is. */
export type FlowNodeType = 'start' | 'llm' | 'tool' | 'route' | 'end';

/** A node in an agent flow graph (the unit the user edits in the diagram UI). */
export interface FlowNode {
  id: string;
  type: FlowNodeType;
  label?: string;
  /** Node config: llm = role/prompt/tools; tool = tool name; route = key. */
  config?: Record<string, unknown>;
}

/** A directed edge between two nodes; when routes out of an llm/route node. */
export interface FlowEdge {
  from: string;
  to: string;
  when?: string;
}

/**
 * A user-editable agent flow graph (draw.io-style). v1 ships two presets:
 * sequential and orchestrator; the executor interprets the DAG.
 */
export interface FlowGraphSpec {
  version: 1;
  name?: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  entry: string;
}

/**
 * AuditStrategy — the fully-resolved configuration of a single experiment arm.
 * This is the unit that gets A/B tested: engine + model + sampling + prompt,
 * and now the agent architecture (flow + tool chain).
 */
export interface AuditStrategy {
  engine: AuditEngine;
  vendor: ModelVendor;
  modelId: string;
  temperature: number;
  maxTokens: number;
  promptVariant: PromptVariant;
  /** Agent architecture. Absent = legacy sequential behavior (backward compat). */
  flow?: FlowType;
  /** Tool chain for orchestrator arms (ignored when flow is 'sequential'). */
  toolChain?: ToolChain;
  /** Preset flow diagram. Absent = legacy. */
  flowGraph?: FlowGraphSpec;
}

/**
 * Weights for the composite eval score. Must sum to 1.
 * `acceptance` folds in the human reviewer's accept/reject signal so that
 * automated review scores and human judgment are both represented.
 */
export interface MetricsWeights {
  accuracy: number;
  quality: number;
  acceptance: number;
  speed: number;
  cost: number;
  /** Optional weight for the admin manual-ranking vector (default 0.20, renormalized). */
  ranking?: number;
}

export type ExperimentStatus = 'draft' | 'running' | 'paused' | 'completed';

/** Human code-reviewer decision on a review, captured as an experiment signal. */
export type ReviewDecisionAction = 'approve' | 'revise' | 'cancel';

/**
 * MODEL_CATALOG — the vendor → sub-model hierarchy used by the report page.
 * Baseline for the DeepSeek-first evaluation is `deepseek-v4-pro`.
 */
export const MODEL_CATALOG: ModelEntry[] = [
  { vendor: 'deepseek', modelId: 'deepseek-v4-pro', label: 'V4 Pro', tier: 'pro' },
  { vendor: 'deepseek', modelId: 'deepseek-v4-flash', label: 'V4 Flash', tier: 'flash' },
  { vendor: 'deepseek', modelId: 'deepseek-chat', label: 'Chat (V3)', tier: 'base' },
  { vendor: 'deepseek', modelId: 'deepseek-reasoner', label: 'Reasoner (R1)', tier: 'reasoner' },
  { vendor: 'claude', modelId: 'claude-sonnet-4-20250514', label: 'Sonnet 4', tier: 'pro' },
  { vendor: 'claude', modelId: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', tier: 'flash' },
  { vendor: 'claude', modelId: 'claude-opus-4-20250514', label: 'Opus 4', tier: 'pro' },
  { vendor: 'gemini', modelId: 'gemini-2.0-flash', label: '2.0 Flash', tier: 'flash' },
  { vendor: 'gemini', modelId: 'gemini-2.0-pro', label: '2.0 Pro', tier: 'pro' },
];

export interface Experiment {
  id: string;
  name: string;
  /** null = global experiment (applies to all orgs). */
  organizationId: string | null;
  status: ExperimentStatus;
  rolloutPercent: number;
  minSampleSize: number;
  controlStrategy: AuditStrategy;
  treatmentStrategies: AuditStrategy[];
  metricsWeights: MetricsWeights;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One observation per audited PR that hit a variant bucket. */
export interface ExperimentRun {
  id: string;
  experimentId: string;
  variantId: string;
  auditId: string | null;
  /** PR this observation belongs to — correlation key for human decisions. */
  prNumber: number;
  vendor: ModelVendor;
  modelId: string;
  strategySnapshot: AuditStrategy;
  verdict: AuditVerdict | null;
  complianceScore: number | null;
  efficiencyScore: number | null;
  coverageScore: number | null;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  agreedWithInline: boolean | null;
  parseOk: boolean | null;
  /** GitHub "owner/repo" correlation key to the HITL review decision. */
  repositoryFullName: string | null;
  humanDecision: ReviewDecisionAction | null;
  /** true on approve, false on revise, null on cancel/no judgment. */
  humanAccepted: boolean | null;
  revisionCount: number | null;
  acceptedAt: string | null;
  /** Where the run came from: live webhook traffic or an admin benchmark. */
  source: RunSource;
  /** Input the run executed against (benchmark runs; null for live). */
  inputSnapshot: BenchmarkInputSnapshot | null;
  /** Total tool calls in the orchestrator loop (null for sequential). */
  toolCalls: number | null;
  createdAt: string;
}

/** Where a run originated: live webhook traffic or an admin-triggered benchmark. */
export type RunSource = 'live' | 'benchmark';

/** Snapshot of the input a benchmark run executed against (reproducibility). */
export interface BenchmarkInputSnapshot {
  repositoryFullName?: string | null;
  prNumber?: number | null;
  prTitle?: string;
  diffContent?: string;
  taskDescription?: string;
  guidelines?: { name: string; severity: string; pattern: string }[];
}

/** A manual 1..N ordering of one arm's output for one PR (1 = best). */
export interface AdminRanking {
  id: string;
  experimentId: string;
  repositoryFullName: string;
  prNumber: number;
  variantId: string;
  rank: number;
  note: string | null;
  rankedBy: string;
  createdAt: string;
}

/** A promoted flow — the org/repo's active live review architecture ("plugin"). */
export interface ActiveFlow {
  id: string;
  organizationId: string | null;
  /** Repo-scoped flows override org-scoped ones. */
  repositoryId: string | null;
  variant: AuditStrategy;
  version: number;
  promotedBy: string;
  promotedAt: string;
  previousId: string | null;
}

/** Lifecycle of an async benchmark job. */
export type BenchmarkJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** An async deliberate benchmark run. */
export interface BenchmarkJob {
  id: string;
  experimentId: string;
  organizationId: string;
  status: BenchmarkJobStatus;
  inputSnapshot: BenchmarkInputSnapshot | null;
  error: string | null;
  createdBy: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** A durable in-app notification. */
export interface Notification {
  id: string;
  organizationId: string | null;
  type: string;
  title: string;
  body: string | null;
  read: boolean;
  createdAt: string;
}

/** One observation per PR reviewed by a promoted flow (the plugin). */
export interface ActiveFlowRun {
  id: string;
  activeFlowId: string;
  repositoryFullName: string;
  prNumber: number;
  verdict: AuditVerdict | null;
  complianceScore: number | null;
  efficiencyScore: number | null;
  coverageScore: number | null;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  toolCalls: number | null;
  flow: string | null;
  humanDecision: ReviewDecisionAction | null;
  humanAccepted: boolean | null;
  revisionCount: number | null;
  acceptedAt: string | null;
  createdAt: string;
}
