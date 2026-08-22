/**
 * tool-catalog.ts — centralized registry of tools an orchestrator agent can
 * call. Skills are in-process; MCP servers are referenced by name and resolved
 * through the McpBridge. One source of truth for "add skills/MCP to an agent"
 * (promotable to a DB table later).
 */

export interface ToolDef {
  kind: 'skill' | 'mcp';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler?: (args: Record<string, unknown>, ctx: Record<string, unknown>) => string;
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
    handler: (args, ctx) => {
      const q = String(args.query ?? '').toLowerCase();
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
      if (hits.length === 0) return 'No matching guidelines.';
      return hits.map((g) => g.name + ' [' + g.severity + ']: ' + (g.description || g.pattern)).join('\n');
    },
  },
  {
    kind: 'skill',
    name: 'assess_diff_size',
    description: 'Return added/removed line counts for scope assessment.',
    parameters: { type: 'object', properties: {} },
    handler: (_args, ctx) => {
      const diff = String(ctx.diffContent ?? '');
      const lines = diff.split('\n');
      const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
      const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
      return 'Added lines: ' + added + ', removed lines: ' + removed + ', total changed: ' + (added + removed);
    },
  },
];

export function listSkillNames(): string[] {
  return REVIEW_SKILLS.map((s) => s.name);
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
