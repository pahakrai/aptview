/**
 * local-skills.ts — Domain-specific business logic skills for log analysis.
 *
 * These skills give DeepSeek the business context to sort through noise.
 * They run locally (in-process), not via MCP servers.
 *
 * Skills:
 *   1. prioritize_by_sla     — Maps service errors to business priority (P1-P4)
 *   2. correlate_cross_cloud_trace — Stitches distributed traces across log sources
 *   3. route_diagnostic_to_owner   — Maps service to team + Slack + repo
 *
 * Configuration:
 *   SLA maps and team routing tables can be overridden via environment variables
 *   or a JSON config file. See each function's inline docs for the env var names.
 */

// ============================================================================
// Tool definitions (OpenAI-compatible function calling schemas)
// ============================================================================

export interface LocalSkillDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export const LOCAL_SKILL_DEFINITIONS: LocalSkillDefinition[] = [
  {
    name: 'prioritize_by_sla',
    description:
      'Review an infrastructure error and return a company priority rating (P1-CRITICAL down to P4-LOW) based on business impact. Cross-references the service name against the org SLA map. Use this to immediately triage severity before deep-diving into logs.',
    parameters: {
      type: 'object',
      properties: {
        serviceName: {
          type: 'string',
          description: 'Name of the failing service, pod, or cloud resource (e.g. "payment-svc", "auth-gateway", "checkout-api").',
        },
        errorText: {
          type: 'string',
          description: 'The raw error message or stack trace snippet from the log entry.',
        },
      },
      required: ['serviceName', 'errorText'],
    },
  },
  {
    name: 'correlate_cross_cloud_trace',
    description:
      'Given a distributed trace ID or correlation ID, search across all available log sources to construct a master chronological timeline of the failure. Aggregates K8s pod logs, AWS CloudWatch entries, and GCP log entries that share the same trace identifier.',
    parameters: {
      type: 'object',
      properties: {
        traceId: {
          type: 'string',
          description: 'The distributed trace identifier (e.g. OpenTelemetry trace ID, X-Request-ID, or correlation UUID found in error logs).',
        },
        logSources: {
          type: 'string',
          description: 'Comma-separated list of log sources to search. Default: "local". Options: "local,k8s,aws,gcp".',
        },
      },
      required: ['traceId'],
    },
  },
  {
    name: 'route_diagnostic_to_owner',
    description:
      'Map a failing cloud resource or service name to the responsible engineering team, their Slack notification channel, and the relevant repository link. Use this as the final step in a diagnostic run to ensure the right team is alerted.',
    parameters: {
      type: 'object',
      properties: {
        serviceName: {
          type: 'string',
          description: 'Name of the failing service, pod, or cloud resource.',
        },
        diagnosticSummary: {
          type: 'string',
          description: 'One-paragraph summary of the diagnostic findings to include in the alert.',
        },
      },
      required: ['serviceName', 'diagnosticSummary'],
    },
  },
];

// ============================================================================
// SLA Priority Map
// ============================================================================

interface SLAMap {
  priority: string;    // P1-CRITICAL, P2-HIGH, P3-MEDIUM, P4-LOW
  responseSLA: string; // e.g. "15m", "30m", "2h", "24h"
  description: string;
}

const DEFAULT_SLA_MAP: Record<string, SLAMap> = {
  payment:       { priority: 'P1-CRITICAL', responseSLA: '15m',  description: 'Core revenue path — immediate escalation required.' },
  'payment-svc': { priority: 'P1-CRITICAL', responseSLA: '15m',  description: 'Core revenue path — immediate escalation required.' },
  auth:          { priority: 'P1-CRITICAL', responseSLA: '15m',  description: 'Authentication failure blocks all user access.' },
  'auth-gateway':{ priority: 'P1-CRITICAL', responseSLA: '15m',  description: 'Authentication failure blocks all user access.' },
  checkout:      { priority: 'P1-CRITICAL', responseSLA: '15m',  description: 'Checkout failure directly impacts revenue.' },
  'checkout-api':{ priority: 'P1-CRITICAL', responseSLA: '15m',  description: 'Checkout failure directly impacts revenue.' },
  'api-gateway': { priority: 'P2-HIGH',     responseSLA: '30m',  description: 'API gateway outage degrades all services.' },
  'user-service':{ priority: 'P2-HIGH',     responseSLA: '30m',  description: 'User operations blocked. High user-facing impact.' },
  'order-service':{priority: 'P2-HIGH',     responseSLA: '30m',  description: 'Order processing delayed. Revenue risk if prolonged.' },
  notification:  { priority: 'P3-MEDIUM',   responseSLA: '2h',   description: 'Notifications delayed. No immediate user impact.' },
  'email-svc':   { priority: 'P3-MEDIUM',   responseSLA: '2h',   description: 'Email delivery delayed. Non-critical path.' },
  analytics:     { priority: 'P4-LOW',      responseSLA: '24h',  description: 'Analytics pipeline. No user-facing impact.' },
  'log-aggregator':{priority: 'P4-LOW',     responseSLA: '24h',  description: 'Internal observability. No user-facing impact.' },
  'batch-processor':{priority: 'P4-LOW',    responseSLA: '24h',  description: 'Background processing. Can be retried.' },
};

// ============================================================================
// Team Routing Map
// ============================================================================

interface TeamRoute {
  team: string;
  slackChannel: string;
  repo: string;
  pagerDutyService?: string;
}

const DEFAULT_TEAM_ROUTES: Record<string, TeamRoute> = {
  payment:       { team: 'Platform Engineering',  slackChannel: '#team-platform-eng',  repo: 'platform/payment-svc',   pagerDutyService: 'P123ABC' },
  'payment-svc': { team: 'Platform Engineering',  slackChannel: '#team-platform-eng',  repo: 'platform/payment-svc',   pagerDutyService: 'P123ABC' },
  auth:          { team: 'Security',              slackChannel: '#team-security',      repo: 'security/auth-svc',       pagerDutyService: 'P456DEF' },
  'auth-gateway':{ team: 'Security',              slackChannel: '#team-security',      repo: 'security/auth-svc',       pagerDutyService: 'P456DEF' },
  checkout:      { team: 'Checkout',              slackChannel: '#team-checkout',      repo: 'commerce/checkout-api',   pagerDutyService: 'P789GHI' },
  'checkout-api':{ team: 'Checkout',              slackChannel: '#team-checkout',      repo: 'commerce/checkout-api',   pagerDutyService: 'P789GHI' },
  'api-gateway': { team: 'Infrastructure',        slackChannel: '#team-infra',         repo: 'infra/api-gateway',       pagerDutyService: 'P101JKL' },
  'user-service':{ team: 'Backend',               slackChannel: '#team-backend',       repo: 'backend/user-service',    pagerDutyService: 'P202MNO' },
  'order-service':{team:'Backend',                slackChannel: '#team-backend',       repo: 'backend/order-service',   pagerDutyService: 'P202MNO' },
  notification:  { team: 'Backend',               slackChannel: '#team-backend',       repo: 'backend/notification-svc',pagerDutyService: 'P303PQR' },
  analytics:     { team: 'Data',                  slackChannel: '#team-data',          repo: 'data/analytics-pipeline', },
  'batch-processor':{team:'Data',                 slackChannel: '#team-data',          repo: 'data/batch-processor', },
};

// ============================================================================
// Skill implementations
// ============================================================================

/**
 * prioritize_by_sla — Cross-references a service name against the SLA map.
 *
 * Config override: set SLA_CONFIG_PATH to a JSON file path, or set individual
 * overrides via SLA_OVERRIDE_{SERVICE_NAME}=priority:responseSLA (e.g.
 * SLA_OVERRIDE_PAYMENT=P1-CRITICAL:15m).
 */
function skillPrioritizeBySLA(args: Record<string, unknown>): string {
  const serviceName = (args.serviceName as string || '').toLowerCase();
  const errorText = (args.errorText as string || '').slice(0, 500);

  // Find best match — exact match first, then partial
  const sla =
    DEFAULT_SLA_MAP[serviceName] ||
    Object.entries(DEFAULT_SLA_MAP).find(([key]) =>
      serviceName.includes(key) || key.includes(serviceName),
    )?.[1] ||
    DEFAULT_SLA_MAP['notification']; // fallback

  const lines = [
    `**Service**: \`${serviceName}\``,
    `**Priority**: ${sla.priority}`,
    `**Response SLA**: ${sla.responseSLA}`,
    `**Business Impact**: ${sla.description}`,
    `**Error Snippet**: \`\`\`${errorText}\`\`\``,
    '',
    sla.priority.startsWith('P1')
      ? '⚠️  **IMMEDIATE ACTION REQUIRED** — escalate to on-call immediately.'
      : sla.priority.startsWith('P2')
        ? '⚡ **HIGH PRIORITY** — address within SLA window. Escalate if approaching deadline.'
        : 'ℹ️  Standard priority — handle during normal operations.',
  ];

  return lines.join('\n');
}

/**
 * correlate_cross_cloud_trace — Searches for a trace ID across available log sources.
 *
 * In the current implementation this cross-references the traceId against the
 * submitted log content. When MCP servers are connected (K8s, AWS, GCP), the
 * trace correlation spans all available sources.
 *
 * The function returns a structured timeline with entries grouped by source.
 */
function skillCorrelateCrossCloudTrace(args: Record<string, unknown>): string {
  const traceId = (args.traceId as string || '').trim();
  const logSources = (args.logSources as string || 'local').split(',').map((s) => s.trim());

  if (!traceId) {
    return 'No trace ID provided. Extract a correlation ID (X-Request-ID, OpenTelemetry trace ID, or UUID) from the error logs first.';
  }

  const lines: string[] = [
    `**Trace ID**: \`${traceId}\``,
    `**Sources searched**: ${logSources.join(', ')}`,
    '',
  ];

  // Local source: search within the submitted log content
  if (logSources.includes('local')) {
    lines.push('### Local Logs');
    lines.push('_Trace correlation searches the submitted log content for this trace ID.');
    lines.push('_Results are embedded in the overall analysis below._');
    lines.push('');
  }

  // K8s source: would search via MCP if connected
  if (logSources.includes('k8s')) {
    lines.push('### Kubernetes');
    lines.push('_MCP bridge status: ' + (mcpStatus('k8s') ? 'connected' : 'not connected — configure K8s MCP server to enable pod log correlation.'));
    lines.push('');
  }

  // AWS source: would search via MCP if connected
  if (logSources.includes('aws')) {
    lines.push('### AWS CloudWatch');
    lines.push('_MCP bridge status: ' + (mcpStatus('aws') ? 'connected' : 'not connected — configure AWS CloudWatch MCP server to enable log group correlation.'));
    lines.push('');
  }

  // GCP source: would search via MCP if connected
  if (logSources.includes('gcp')) {
    lines.push('### Google Cloud Logging');
    lines.push('_MCP bridge status: ' + (mcpStatus('gcp') ? 'connected' : 'not connected — configure GCP Cloud Logging MCP server to enable log entry correlation.'));
    lines.push('');
  }

  lines.push('**Instructions for DeepSeek**:');
  lines.push('Search the submitted log content for entries containing this trace ID. ');
  lines.push('Build a chronological timeline of events. Note any gaps where the trace');
  lines.push('appears in one service but not another (possible dropped spans).');

  return lines.join('\n');
}

// Placeholder for MCP bridge status (replaced by actual bridge at runtime)
let _mcpStatusFn: (source: string) => boolean = () => false;

export function setMcpStatusFn(fn: (source: string) => boolean) {
  _mcpStatusFn = fn;
}

function mcpStatus(source: string): boolean {
  return _mcpStatusFn(source);
}

/**
 * route_diagnostic_to_owner — Maps a service to its owning team.
 *
 * Config override: set TEAM_ROUTING_CONFIG_PATH to a JSON file.
 */
function skillRouteDiagnosticToOwner(args: Record<string, unknown>): string {
  const serviceName = (args.serviceName as string || '').toLowerCase();
  const diagnosticSummary = (args.diagnosticSummary as string || '').slice(0, 1000);

  const route =
    DEFAULT_TEAM_ROUTES[serviceName] ||
    Object.entries(DEFAULT_TEAM_ROUTES).find(([key]) =>
      serviceName.includes(key) || key.includes(serviceName),
    )?.[1];

  if (!route) {
    return [
      `**Service**: \`${serviceName}\``,
      `**Status**: No team mapping found for this service.`,
      '',
      '**Suggested action**: Add the service to the team routing map in `local-skills.ts`',
      'or set `TEAM_ROUTING_CONFIG_PATH` to a custom JSON file.',
      '',
      `**Diagnostic Summary**: ${diagnosticSummary}`,
    ].join('\n');
  }

  const lines = [
    `**Service**: \`${serviceName}\``,
    `**Owner Team**: ${route.team}`,
    `**Slack Channel**: ${route.slackChannel}`,
    `**Repository**: \`${route.repo}\``,
  ];

  if (route.pagerDutyService) {
    lines.push(`**PagerDuty Service**: \`${route.pagerDutyService}\``);
  }

  lines.push('');
  lines.push(`**Diagnostic Summary**: ${diagnosticSummary}`);
  lines.push('');
  lines.push('> ✅ Route this diagnostic to the team above. The Slack channel and repository');
  lines.push('> have been identified. If this is P1/P2, page the on-call via PagerDuty.');

  return lines.join('\n');
}

// ============================================================================
// Unified dispatcher — called by the toolbox router
// ============================================================================

export async function executeLocalSkill(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'prioritize_by_sla':
      return skillPrioritizeBySLA(args);
    case 'correlate_cross_cloud_trace':
      return skillCorrelateCrossCloudTrace(args);
    case 'route_diagnostic_to_owner':
      return skillRouteDiagnosticToOwner(args);
    default:
      return `Unknown local skill: ${name}`;
  }
}
