/**
 * flow-runner.service.ts — executes an audit against a configured agent
 * architecture: sequential (fixed pipeline, one LLM call) or orchestrator
 * (planner + tool loop with skills/MCP). Returns a normalized FlowOutcome so
 * both architectures are comparable in the deliberate A/B.
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuditStrategy } from '@aigov/shared-types';
import { AuditVerdict } from '@aigov/shared-types';
import {
  callDeepSeekChat,
  callDeepSeekWithTools,
  type DeepSeekMessage,
} from '../audits/llm-deepseek';
import { McpBridge, type McpServerConfig } from '../log-analyzer/mcp-bridge';
import {
  executeFlowGraph,
  presetGraph,
  type GraphContext,
  type GraphExecutors,
} from './flow-graph';
import { buildSkillSchema, executeSkill } from './tool-catalog';

export interface FlowGuideline {
  name: string;
  description: string | null;
  pattern: string;
  severity: string;
}

export interface FlowRunInput {
  prTitle: string;
  diffContent: string;
  taskDescription?: string;
  guidelines: FlowGuideline[];
}

export interface FlowOutcome {
  verdict: AuditVerdict;
  complianceScore: number | null;
  efficiencyScore: number | null;
  coverageScore: number | null;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  toolCalls: number;
  parseOk: boolean;
  flow: 'sequential' | 'orchestrator';
  summary: string | null;
  totalViolations: number;
  errorCount: number;
  warningCount: number;
  scopeCreepDetected: boolean;
  actualLoc: number;
  estimatedLoc: number;
}

/** JSON the review engine is asked to return (same shape as the audit pipeline). */
interface ReviewOutput {
  verdict: 'pass' | 'warning' | 'fail';
  totalViolations: number;
  errorCount: number;
  warningCount: number;
  scopeCreepDetected: boolean;
  actualLoc: number;
  estimatedLoc: number;
  complianceScore: number;
  efficiencyScore: number;
  coverageScore: number;
  summary: string;
}

const REVIEWER_SYSTEM =
  'You are a code reviewer for an automated governance platform. ' +
  'Return your findings as valid JSON only, with no markdown fences.';

const PLANNER_SYSTEM =
  'You are a code reviewer for an automated governance platform. ' +
  'Use the available tools to explore the diff and guidelines, then produce the final review JSON. ' +
  'The final assistant message must be ONLY the JSON object (no fences).';

function clampScore(v: number | null | undefined): number | null {
  if (v === null || v === undefined || isNaN(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** Map a parsed string verdict onto the AuditVerdict enum (default warning). */
function toVerdict(v: string | undefined): AuditVerdict {
  if (v === 'pass') return AuditVerdict.PASS;
  if (v === 'fail') return AuditVerdict.FAIL;
  return AuditVerdict.WARNING;
}

/** Extract the outermost JSON object from an LLM response. */
function parseReviewJson(raw: string): ReviewOutput | null {
  const fence = raw.match(/\`\`\`(?:json)?\s*\n?([\s\S]*?)\`\`\`/);
  const candidate = fence ? fence[1] : raw;
  const match = candidate.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as ReviewOutput;
  } catch {
    return null;
  }
}

function guidelinesText(guidelines: FlowGuideline[]): string {
  if (guidelines.length === 0) return '(No guidelines configured for this organization)';
  return guidelines
    .map((g) => '- **' + g.name + '** [' + g.severity + ']: ' + (g.description || g.pattern))
    .join('\n');
}

function buildUserPrompt(input: FlowRunInput): string {
  const task = input.taskDescription
    ? '## Task Description (requirements to check coverage against)\n' + input.taskDescription + '\n'
    : '';
  return [
    '## PR Title',
    input.prTitle,
    '',
    task,
    '## Coding Standards (check these)',
    guidelinesText(input.guidelines),
    '',
    '## Diff',
    '\`\`\`diff',
    input.diffContent.slice(0, 32000),
    '\`\`\`',
    '',
    '## Instructions',
    'Return your findings as valid JSON with exactly this shape:',
    '{',
    '  "verdict": "pass" | "warning" | "fail",',
    '  "totalViolations": <number>,',
    '  "errorCount": <number>,',
    '  "warningCount": <number>,',
    '  "scopeCreepDetected": <boolean>,',
    '  "actualLoc": <number>,',
    '  "estimatedLoc": <number>,',
    '  "complianceScore": <number 0-100>,',
    '  "efficiencyScore": <number 0-100>,',
    '  "coverageScore": <number 0-100>,',
    '  "summary": "<one-paragraph summary of findings>"',
    '}',
    'Do not output anything except the JSON object.',
  ].join('\n');
}

function toOutcome(
  parsed: ReviewOutput | null,
  flow: 'sequential' | 'orchestrator',
  start: number,
  promptTokens: number,
  completionTokens: number,
  toolCalls: number,
): FlowOutcome {
  return {
    verdict: toVerdict(parsed?.verdict),
    complianceScore: clampScore(parsed?.complianceScore),
    efficiencyScore: clampScore(parsed?.efficiencyScore),
    coverageScore: clampScore(parsed?.coverageScore),
    latencyMs: Date.now() - start,
    promptTokens,
    completionTokens,
    toolCalls,
    parseOk: parsed !== null,
    flow,
    summary: parsed?.summary ?? null,
    totalViolations: parsed?.totalViolations ?? 0,
    errorCount: parsed?.errorCount ?? 0,
    warningCount: parsed?.warningCount ?? 0,
    scopeCreepDetected: parsed?.scopeCreepDetected ?? false,
    actualLoc: parsed?.actualLoc ?? 0,
    estimatedLoc: parsed?.estimatedLoc ?? 150,
  };
}


@Injectable()
export class FlowRunnerService {
  constructor(private readonly configService: ConfigService) {}

  private apiKey(): string {
    return this.configService.get<string>('DEEPSEEK_API_KEY') ?? '';
  }

  /** Interpret the arm's flow graph (preset or custom) and run it. */
  async run(
    strategy: AuditStrategy,
    input: FlowRunInput,
    signal?: AbortSignal,
  ): Promise<FlowOutcome> {
    const start = Date.now();
    const flow = strategy.flow ?? 'sequential';
    const graph = strategy.flowGraph ?? presetGraph(flow);

    let promptTokens = 0;
    let completionTokens = 0;

    const mcp = await this.connectMcp(strategy.toolChain?.mcp ?? []);
    const skillSchema = buildSkillSchema(strategy.toolChain?.skills ?? []);
    const toolSchema: Array<Record<string, unknown>> = [
      ...skillSchema,
      ...(mcp ? mcp.tools : []),
    ];

    const ctx: GraphContext = {
      messages: [],
      output: '',
      toolCallCount: 0,
      diffContent: input.diffContent,
      guidelines: input.guidelines,
    };

    const exec: GraphExecutors = {
      llm: async (node, gctx) => {
        const role = (node.config?.role as string) ?? 'reviewer';
        if (role === 'planner') {
          const messages: DeepSeekMessage[] = [
            { role: 'system', content: PLANNER_SYSTEM },
            { role: 'user', content: buildUserPrompt(input) },
            ...(gctx.messages as unknown as DeepSeekMessage[]),
          ];
          const res = await callDeepSeekWithTools({
            apiKey: this.apiKey(),
            model: strategy.modelId,
            temperature: strategy.temperature,
            maxTokens: strategy.maxTokens,
            messages,
            tools: toolSchema,
            signal,
          });
          promptTokens += res.promptTokens;
          completionTokens += res.completionTokens;
          return { content: res.content, toolCalls: res.toolCalls };
        }
        const res = await callDeepSeekChat({
          apiKey: this.apiKey(),
          model: strategy.modelId,
          temperature: strategy.temperature,
          maxTokens: strategy.maxTokens,
          systemPrompt: REVIEWER_SYSTEM,
          userPrompt: buildUserPrompt(input),
          signal,
        });
        promptTokens += res.promptTokens;
        completionTokens += res.completionTokens;
        return { content: res.content, toolCalls: [] };
      },
      tool: async (name, args) => {
        const skill = executeSkill(name, args, {
          guidelines: input.guidelines,
          diffContent: input.diffContent,
        });
        if (skill !== null) return skill;
        if (mcp) {
          try {
            const r = await mcp.bridge.callTool(name, args);
            return (r.content ?? []).map((c) => c.text ?? '').join('\n');
          } catch (err) {
            return 'MCP tool error: ' + (err as Error).message;
          }
        }
        return 'Unknown tool: ' + name;
      },
    };

    const result = await executeFlowGraph(graph, ctx, exec, { signal, maxSteps: 50 });
    const parsed = parseReviewJson(result.output);
    return toOutcome(parsed, flow, start, promptTokens, completionTokens, result.toolCallCount);
  }

  /** Connect the arm's MCP servers; returns null when none connect. */
  private async connectMcp(
    names: string[],
  ): Promise<{ bridge: McpBridge; tools: Array<Record<string, unknown>> } | null> {
    if (names.length === 0) return null;
    const configs = this.buildMcpConfigs(names);
    if (Object.keys(configs).length === 0) return null;
    const bridge = new McpBridge();
    const mcpTools = await bridge.connect(configs);
    if (mcpTools.length === 0) return null;
    const tools = mcpTools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || 'MCP tool: ' + t.name,
        parameters: t.inputSchema || { type: 'object', properties: {} },
      },
    }));
    return { bridge, tools };
  }

  /** Map arm toolChain.mcp names to MCP server configs from env (best-effort). */
  private buildMcpConfigs(names: string[]): Record<string, McpServerConfig> {
    const configs: Record<string, McpServerConfig> = {};
    const mode = this.configService.get<string>('MCP_TRANSPORT_MODE') || 'sse';
    for (const name of names) {
      const key = name.toUpperCase();
      const url = this.configService.get<string>('MCP_' + key + '_URL');
      const command = this.configService.get<string>('MCP_' + key + '_COMMAND');
      const args = this.configService.get<string>('MCP_' + key + '_ARGS');
      if (mode === 'stdio' && command) {
        configs[name] = {
          transport: 'stdio',
          command,
          args: args ? args.split(' ') : [],
        };
      } else if (url) {
        configs[name] = { transport: 'sse', url };
      }
    }
    return configs;
  }
}
