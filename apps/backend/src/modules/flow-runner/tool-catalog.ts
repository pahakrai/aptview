/**
 * tool-catalog.ts — centralized registry of tools an orchestrator agent can
 * call. Skills are in-process; MCP servers are referenced by name and resolved
 * through the McpBridge. Each tool declares a config schema so the design UI
 * can render a per-tool configuration form and store instance values in
 * toolChain.toolConfig.
 *
 * Skills have two facets:
 *   - handler: runs when the LLM invokes the skill as a tool.
 *   - guard:   runs AUTOMATICALLY before every MCP tool call (tenant isolation,
 *              PII scrubbing, etc.). The canvas author never sees the session
 *              context the guard reads — only the skill's declared enforcement.
 */

import type { ToolCatalogEntry, ToolConfigField } from '@aigov/shared-types';

export interface GuardResult {
  action: 'allow' | 'block' | 'rewrite';
  args?: Record<string, unknown>;
  reason?: string;
}

export interface ToolDef extends ToolCatalogEntry {
  handler?: (args: Record<string, unknown>, ctx: Record<string, unknown>) => string;
  guard?: (args: Record<string, unknown>, ctx: Record<string, unknown>) => GuardResult;
}

function field(
  key: string,
  label: string,
  type: ToolConfigField['type'],
  extra: Partial<ToolConfigField> = {},
): ToolConfigField {
  return { key, label, type, ...extra };
}

/** Declared enforcement policy for a guardrail skill. */
function enforcementField(
  defaultValue: 'strict_block' | 'sanitize_or_halt' | 'advisory',
): ToolConfigField {
  return field('enforcement', 'Enforcement', 'enum', {
    enumValues: ['strict_block', 'sanitize_or_halt', 'advisory'],
    default: defaultValue,
    description: 'How the runner enforces this guardrail.',
  });
}

/** Connection fields shared by every MCP server (override env-based defaults). */
function connectionFields(): ToolConfigField[] {
  return [
    field('transport', 'Transport', 'enum', { enumValues: ['sse', 'stdio'], default: 'sse' }),
    field('url', 'SSE URL', 'string', { placeholder: 'http://localhost:8081/sse' }),
    field('command', 'Command (stdio)', 'string', { placeholder: 'npx' }),
    field('args', 'Args (space-separated)', 'string', { placeholder: '-y @some/mcp-server' }),
  ];
}

/** Append a tenant predicate to a SQL/query string (idempotent). */
function appendTenantClause(sql: string, tenant: string): string {
  const t = tenant.replace(/'/g, "''");
  const lower = sql.toLowerCase();
  if (lower.includes('tenant_id')) return sql;
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  const whereIdx = lower.lastIndexOf('where');
  if (whereIdx === -1) return trimmed + " WHERE tenant_id = '" + t + "'";
  return trimmed + " AND tenant_id = '" + t + "'";
}

/** Inject the session tenant into MCP tool args (best-effort, non-destructive). */
function injectTenantScope(args: Record<string, unknown>, tenant: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args, tenant_id: tenant };
  for (const key of ['sql', 'query']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim().length > 0) {
      out[key] = appendTenantClause(v, tenant);
    }
  }
  const filter = args.filter;
  if (filter && typeof filter === 'object' && filter !== null) {
    out.filter = { ...(filter as Record<string, unknown>), tenant_id: tenant };
  }
  return out;
}

export const REVIEW_SKILLS: ToolDef[] = [
  {
    kind: 'skill',
    name: 'search_guidelines',
    description: 'Search the configured coding standards for ones matching a keyword.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Keyword to search for.' } },
      required: ['query'],
    },
    configSchema: {
      fields: [
        field('maxResults', 'Max results', 'number', { default: 10, description: 'Cap the number of guidelines returned.' }),
        field('defaultQuery', 'Default query', 'string', { description: 'Keyword applied when the model passes no query.' }),
        enforcementField('advisory'),
      ],
    },
    handler: (args, ctx) => {
      const cfg = (ctx.toolConfig ?? {}) as Record<string, unknown>;
      const q = String(args.query ?? cfg.defaultQuery ?? '').toLowerCase();
      const maxResults = typeof cfg.maxResults === 'number' ? cfg.maxResults : 10;
      const guidelines =
        (ctx.guidelines as Array<{
          name: string;
          severity: string;
          pattern: string;
          description?: string | null;
        }>) ?? [];
      const hits = guidelines.filter(
        (g) =>
          !q ||
          g.name.toLowerCase().includes(q) ||
          (g.description ?? '').toLowerCase().includes(q) ||
          g.pattern.toLowerCase().includes(q),
      );
      const limited = maxResults > 0 ? hits.slice(0, maxResults) : hits;
      if (limited.length === 0) return 'No matching guidelines.';
      return limited
        .map((g) => g.name + ' [' + g.severity + ']: ' + (g.description || g.pattern))
        .join('\n');
    },
  },
  {
    kind: 'skill',
    name: 'assess_diff_size',
    description: 'Return added/removed line counts for scope assessment.',
    parameters: { type: 'object', properties: {} },
    configSchema: {
      fields: [
        field('countContextLines', 'Count context lines', 'boolean', { default: false, description: 'Also count unchanged context lines in the diff.' }),
        enforcementField('advisory'),
      ],
    },
    handler: (_args, ctx) => {
      const cfg = (ctx.toolConfig ?? {}) as Record<string, unknown>;
      const diff = String(ctx.diffContent ?? '');
      const lines = diff.split('\n');
      const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
      const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
      let context = 0;
      if (cfg.countContextLines === true) {
        context = lines.filter((l) => l.startsWith(' ') && l.trim().length > 0).length;
      }
      return (
        'Added lines: ' +
        added +
        ', removed lines: ' +
        removed +
        (context > 0 ? ', context lines: ' + context : '') +
        ', total changed: ' +
        (added + removed + context)
      );
    },
  },
  {
    kind: 'skill',
    name: 'tenant_scope_guard',
    description: 'Hard-lock MCP tool calls to the current tenant (injects tenant_id filters).',
    parameters: { type: 'object', properties: {} },
    configSchema: {
      fields: [enforcementField('strict_block')],
    },
    handler: (_args, ctx) => {
      const tenant = ctx.tenantId;
      if (!tenant) return 'BLOCK: tenant_scope_guard has no tenant context';
      return 'Tenant scope enforced: tenant_id=' + String(tenant);
    },
    guard: (args, ctx) => {
      const tenant = ctx.tenantId;
      if (!tenant) {
        return { action: 'block', reason: 'tenant_scope_guard: no tenant context available' };
      }
      return { action: 'rewrite', args: injectTenantScope(args, String(tenant)) };
    },
  },
];

export const MCP_SOURCES: ToolDef[] = [
  {
    kind: 'mcp',
    name: 'k8s',
    description: 'Kubernetes cluster tools (pods, logs, describe).',
    configSchema: {
      fields: [
        ...connectionFields(),
        field('namespace', 'Namespace', 'string', { default: 'default' }),
        field('kubeconfig', 'Kubeconfig', 'secretRef', { placeholder: 'env:K8S_KUBECONFIG', description: 'Reference (env:VAR), never the raw secret.' }),
      ],
    },
  },
  {
    kind: 'mcp',
    name: 'aws',
    description: 'AWS CloudWatch log tools.',
    configSchema: {
      fields: [
        ...connectionFields(),
        field('region', 'Region', 'string', { default: 'us-east-1' }),
        field('logGroupPrefix', 'Log group prefix', 'string', {}),
        field('accessKeyId', 'Access key id', 'secretRef', { placeholder: 'env:AWS_ACCESS_KEY_ID' }),
        field('secretAccessKey', 'Secret access key', 'secretRef', { placeholder: 'env:AWS_SECRET_ACCESS_KEY' }),
      ],
    },
  },
  {
    kind: 'mcp',
    name: 'gcp',
    description: 'Google Cloud Logging tools.',
    configSchema: {
      fields: [
        ...connectionFields(),
        field('projectId', 'Project id', 'string', {}),
        field('credentialsJson', 'Credentials JSON', 'secretRef', { placeholder: 'env:GCP_CREDENTIALS_JSON' }),
      ],
    },
  },
  {
    kind: 'mcp',
    name: 'kubetail',
    description: 'Aggregated log scanning across replicas.',
    configSchema: {
      fields: [
        ...connectionFields(),
        field('namespace', 'Namespace', 'string', { default: 'default' }),
        field('since', 'Default time range', 'string', { default: '15m' }),
      ],
    },
  },
];

export function listSkillNames(): string[] {
  return REVIEW_SKILLS.map((s) => s.name);
}

/** All discoverable tools (skills + MCP), for the design UI catalog. */
export function listTools(): ToolDef[] {
  return [...REVIEW_SKILLS, ...MCP_SOURCES];
}

/** Enabled guard skills (empty = all), resolved from the arm's toolChain.skills. */
export function listGuardSkills(enabled: string[]): ToolDef[] {
  const defs = enabled.length === 0 ? REVIEW_SKILLS : REVIEW_SKILLS.filter((s) => enabled.includes(s.name));
  return defs.filter((s) => s.guard);
}

/** Build the DeepSeek function-calling schema for the enabled skills. */
export function buildSkillSchema(enabled: string[]): Array<Record<string, unknown>> {
  const defs = enabled.length === 0 ? REVIEW_SKILLS : REVIEW_SKILLS.filter((s) => enabled.includes(s.name));
  return defs.map((d) => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: d.parameters },
  }));
}

/** Execute an in-process skill; returns null when the name is not a skill. */
export function executeSkill(
  name: string,
  args: Record<string, unknown>,
  ctx: Record<string, unknown>,
): string | null {
  const def = REVIEW_SKILLS.find((s) => s.name === name && s.kind === 'skill');
  if (!def || !def.handler) return null;
  try {
    return def.handler(args, ctx);
  } catch (err) {
    return 'Skill error: ' + (err as Error).message;
  }
}
