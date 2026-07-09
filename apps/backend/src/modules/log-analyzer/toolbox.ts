/**
 * toolbox.ts — Unified tool registry for the log analyzer.
 *
 * Merges three layers of tools into a single DeepSeek-compatible tool list:
 *   1. Core tools      — log parsing, error extraction, search, counting
 *   2. Local skills    — business context (SLA, trace correlation, team routing)
 *   3. MCP tools       — cloud-native log sources (K8s, AWS CloudWatch, GCP Logging)
 *
 * The router dispatches tool calls to the correct handler:
 *   - Core tools     → executeCoreTool()   (regex/heuristic, in-process)
 *   - Local skills   → executeLocalSkill() (business logic, in-process)
 *   - MCP tools      → mcpBridge.callTool()(external MCP server)
 */

import { McpBridge, type McpToolDefinition } from './mcp-bridge';
import { executeLocalSkill, LOCAL_SKILL_DEFINITIONS, setMcpStatusFn } from './local-skills';

// ============================================================================
// Core tool definitions (same as original log-analyzer.graph.ts)
// ============================================================================

const CORE_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'ParseLogFormat',
      description:
        'Analyze the log structure. Returns format type (JSON/syslog/plain), detected fields, and sample entries. Call this FIRST to understand what you are looking at.',
      parameters: { type: 'object' as const, properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'ExtractErrors',
      description:
        'Extract all ERROR/FATAL/CRITICAL level entries from the logs with surrounding context lines.',
      parameters: {
        type: 'object' as const,
        properties: {
          contextLines: { type: 'number', description: 'Context lines before/after each error (default: 2, max: 10)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'SearchLogs',
      description:
        'Search the log content for a regex pattern. Use this to find specific error messages, stack traces, or identifiers.',
      parameters: {
        type: 'object' as const,
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          caseInsensitive: { type: 'boolean', description: 'Case-insensitive search (default: true)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'CountByLevel',
      description:
        'Count log entries grouped by severity level (ERROR, WARN, INFO, DEBUG, TRACE, FATAL).',
      parameters: { type: 'object' as const, properties: {}, required: [] },
    },
  },
];

// ============================================================================
// Core tool implementations (inline — same logic as before)
// ============================================================================

function toolParseLogFormat(logContent: string): string {
  const lines = logContent.split('\n').filter((l) => l.trim().length > 0);
  const sample = lines.slice(0, 50);
  const jsonLike = sample.filter((l) => l.trim().startsWith('{')).length;
  const syslogLike = sample.filter((l) => /^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}/.test(l)).length;
  const isoLike = sample.filter((l) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(l)).length;
  const levelLike = sample.filter((l) => /\b(ERROR|WARN|WARNING|INFO|DEBUG|TRACE|FATAL|CRITICAL|CRIT)\b/i.test(l)).length;
  const stackTraceLike = sample.filter((l) => /^\s+at\s+/.test(l)).length;

  const parts: string[] = [];
  if (jsonLike > sample.length * 0.5) {
    parts.push('**Format**: JSON (structured logging)');
    parts.push(`**JSON entries**: ${jsonLike}/${sample.length} sample lines`);
  } else if (syslogLike > sample.length * 0.5) {
    parts.push('**Format**: Syslog (traditional)');
  } else {
    parts.push('**Format**: Plain text / mixed');
  }
  if (isoLike > 0) parts.push(`**ISO-8601 timestamps**: ${isoLike} lines`);
  if (levelLike > 0) parts.push(`**Log levels detected**: ${levelLike} lines`);
  if (stackTraceLike > 0) parts.push(`**Stack traces detected**: ${stackTraceLike} lines`);
  parts.push(`\n**Sample entries** (first 5):\n\`\`\`\n${sample.slice(0, 5).join('\n')}\n\`\`\``);
  return parts.join('\n');
}

function toolExtractErrors(logContent: string, contextLines: number = 2): string {
  const lines = logContent.split('\n');
  const errorRegex = /\b(ERROR|FATAL|CRITICAL|CRIT|SEVERE|PANIC)\b/i;
  const results: string[] = [];
  let errorCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (errorRegex.test(lines[i])) {
      errorCount++;
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length, i + contextLines + 1);
      results.push(`--- Error #${errorCount} (line ${i + 1}) ---`);
      for (let j = start; j < end; j++) {
        results.push(`${j === i ? '>>>' : '   '} ${j + 1}: ${lines[j]}`);
      }
      results.push('');
    }
  }
  return errorCount === 0
    ? 'No ERROR/FATAL/CRITICAL level entries found.'
    : `**Total errors found**: ${errorCount}\n\n${results.join('\n')}`;
}

function toolSearchLogs(logContent: string, pattern: string, caseInsensitive: boolean = true): string {
  const lines = logContent.split('\n');
  const results: string[] = [];
  let matchCount = 0;
  const maxMatches = 30;
  try {
    const regex = new RegExp(pattern, caseInsensitive ? 'gi' : 'g');
    for (let i = 0; i < lines.length && matchCount < maxMatches; i++) {
      if (regex.test(lines[i])) { matchCount++; results.push(`Line ${i + 1}: ${lines[i].trim().slice(0, 200)}`); }
    }
  } catch { return `Invalid regex: "${pattern}"`; }
  return matchCount === 0
    ? `No lines matched "${pattern}".`
    : `**${matchCount} matches**${matchCount >= maxMatches ? ' (showing first 30)' : ''}:\n\n${results.join('\n')}`;
}

function toolCountByLevel(logContent: string): string {
  const lines = logContent.split('\n');
  const counts: Record<string, number> = {};
  const levelPatterns: Record<string, RegExp> = {
    FATAL: /\bFATAL\b/i, ERROR: /\bERROR\b/i, WARN: /\bWARN(?:ING)?\b/i,
    INFO: /\bINFO\b/i, DEBUG: /\bDEBUG\b/i, TRACE: /\bTRACE\b/i,
  };
  let unclassified = 0;
  for (const line of lines) {
    let matched = false;
    for (const [level, regex] of Object.entries(levelPatterns)) {
      if (regex.test(line)) { counts[level] = (counts[level] || 0) + 1; matched = true; break; }
    }
    if (!matched && line.trim().length > 0) unclassified++;
  }
  const parts: string[] = ['**Log entries by severity**:'];
  let total = unclassified;
  for (const level of ['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE']) {
    if (counts[level]) {
      parts.push(`- **${level}**: ${counts[level]} (${((counts[level] / lines.length) * 100).toFixed(1)}%)`);
      total += counts[level];
    }
  }
  if (unclassified > 0) parts.push(`- **Unclassified**: ${unclassified} (${((unclassified / lines.length) * 100).toFixed(1)}%)`);
  parts.push(`\n**Total lines with content**: ${total}`);
  return parts.join('\n');
}

// ============================================================================
// Unified toolbox builder
// ============================================================================

export interface UnifiedToolbox {
  /** All tool definitions (DeepSeek-compatible) */
  toolDefinitions: Array<Record<string, unknown>>;
  /** Route a tool call to the correct handler */
  executeTool: (name: string, args: Record<string, unknown>, logContent: string) => Promise<string>;
  /** For diagnostics: which layer owns each tool */
  toolLayers: Map<string, 'core' | 'local-skill' | 'mcp'>;
}

let mcpBridgeInstance: McpBridge | null = null;

export function setMcpBridge(bridge: McpBridge) {
  mcpBridgeInstance = bridge;
  // Wire the bridge status into the local-skills module
  setMcpStatusFn((source: string) => bridge.isConnected(source));
}

export function getMcpBridge(): McpBridge | null {
  return mcpBridgeInstance;
}

/**
 * Build the unified toolbox from all three layers.
 */
export async function buildUnifiedToolbox(): Promise<UnifiedToolbox> {
  const toolLayers = new Map<string, 'core' | 'local-skill' | 'mcp'>();
  const toolDefinitions: Array<Record<string, unknown>> = [];

  // Layer 1: Core tools
  for (const tool of CORE_TOOLS) {
    toolDefinitions.push(tool);
    toolLayers.set(tool.function.name, 'core');
  }

  // Layer 2: Local skills
  for (const skill of LOCAL_SKILL_DEFINITIONS) {
    toolDefinitions.push({
      type: 'function',
      function: {
        name: skill.name,
        description: skill.description,
        parameters: skill.parameters,
      },
    });
    toolLayers.set(skill.name, 'local-skill');
  }

  // Layer 3: MCP tools (from connected MCP servers)
  if (mcpBridgeInstance) {
    const mcpToolDefs = mcpBridgeInstance.getToolDefinitions();
    for (const mcpTool of mcpToolDefs) {
      toolDefinitions.push({
        type: 'function',
        function: {
          name: mcpTool.name,
          description: mcpTool.description || `MCP tool: ${mcpTool.name}`,
          parameters: mcpTool.inputSchema || { type: 'object', properties: {} },
        },
      });
      toolLayers.set(mcpTool.name, 'mcp');
    }
  }

  const executeTool = async (
    name: string,
    args: Record<string, unknown>,
    logContent: string,
  ): Promise<string> => {
    const layer = toolLayers.get(name);

    if (layer === 'core') {
      // Dispatch to core tool implementations
      switch (name) {
        case 'ParseLogFormat': return toolParseLogFormat(logContent);
        case 'ExtractErrors': return toolExtractErrors(logContent, (args.contextLines as number) ?? 2);
        case 'SearchLogs': return toolSearchLogs(logContent, args.pattern as string, (args.caseInsensitive as boolean) ?? true);
        case 'CountByLevel': return toolCountByLevel(logContent);
        default: return `Unknown core tool: ${name}`;
      }
    }

    if (layer === 'local-skill') {
      return executeLocalSkill(name, args);
    }

    if (layer === 'mcp' && mcpBridgeInstance) {
      const result = await mcpBridgeInstance.callTool(name, args);
      return JSON.stringify(result.content);
    }

    return `Unknown tool: ${name} (layer: ${layer || 'unregistered'}). Available tools: ${[...toolLayers.keys()].join(', ')}`;
  };

  return { toolDefinitions, executeTool, toolLayers };
}
