/**
 * flow-graph.ts — pure agent-flow graph interpreter. A FlowGraphSpec is a
 * node/edge DAG; this module validates it and walks it with injected LLM/tool
 * executors. No I/O, so the execution logic is fully unit-testable.
 */

import type { FlowEdge, FlowGraphSpec, FlowNode, FlowType } from '@aigov/shared-types';

export interface GraphContext {
  messages: Array<Record<string, unknown>>;
  output: string;
  toolCallCount: number;
  [key: string]: unknown;
}

export interface GraphLLMResult {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
}

export interface GraphExecutors {
  llm: (node: FlowNode, ctx: GraphContext) => Promise<GraphLLMResult>;
  tool: (name: string, args: Record<string, unknown>) => Promise<string>;
}

export const PRESET_SEQUENTIAL: FlowGraphSpec = {
  version: 1,
  name: 'sequential',
  entry: 'start',
  nodes: [
    { id: 'start', type: 'start' },
    { id: 'review', type: 'llm', config: { role: 'reviewer' } },
    { id: 'end', type: 'end' },
  ],
  edges: [
    { from: 'start', to: 'review' },
    { from: 'review', to: 'end', when: 'done' },
  ],
};

export const PRESET_ORCHESTRATOR: FlowGraphSpec = {
  version: 1,
  name: 'orchestrator',
  entry: 'start',
  nodes: [
    { id: 'start', type: 'start' },
    { id: 'planner', type: 'llm', config: { role: 'planner', maxTurns: 8 } },
    { id: 'end', type: 'end' },
  ],
  edges: [
    { from: 'start', to: 'planner' },
    { from: 'planner', to: 'planner', when: 'tools' },
    { from: 'planner', to: 'end', when: 'done' },
  ],
};

export function presetGraph(flow: FlowType): FlowGraphSpec {
  return flow === 'orchestrator' ? PRESET_ORCHESTRATOR : PRESET_SEQUENTIAL;
}

/** Return a list of validation errors; empty means valid. */
export function validateFlowGraph(graph: FlowGraphSpec): string[] {
  const errors: string[] = [];
  const ids = new Set(graph.nodes.map((n) => n.id));
  if (!graph.entry) errors.push('missing entry node');
  if (graph.entry && !ids.has(graph.entry)) errors.push('entry node not found: ' + graph.entry);
  for (const e of graph.edges) {
    if (!ids.has(e.from)) errors.push('edge from unknown node: ' + e.from);
    if (!ids.has(e.to)) errors.push('edge to unknown node: ' + e.to);
  }
  if (hasCycle(graph)) errors.push('graph contains a cycle (only llm self-loops are allowed)');
  return errors;
}

/** DFS cycle detection (ignores llm self-loop edges with when='tools'). */
function hasCycle(graph: FlowGraphSpec): boolean {
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.from === e.to && e.when === 'tools') continue;
    const list = adj.get(e.from) ?? [];
    list.push(e.to);
    adj.set(e.from, list);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dfs = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of adj.get(id) ?? []) {
      if (dfs(next)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const n of graph.nodes) {
    if (dfs(n.id)) return true;
  }
  return false;
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Walk a flow graph from its entry node. The llm executor runs llm nodes; the
 * tool executor runs tool invocations. Returns the context with the final
 * output in ctx.output.
 */
export async function executeFlowGraph(
  graph: FlowGraphSpec,
  ctx: GraphContext,
  exec: GraphExecutors,
  opts: { maxSteps?: number; signal?: AbortSignal } = {},
): Promise<GraphContext> {
  const errors = validateFlowGraph(graph);
  if (errors.length > 0) {
    throw new Error('Invalid flow graph: ' + errors.join('; '));
  }

  const maxSteps = opts.maxSteps ?? 50;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const outEdges = new Map<string, FlowEdge[]>();
  for (const e of graph.edges) {
    const list = outEdges.get(e.from) ?? [];
    list.push(e);
    outEdges.set(e.from, list);
  }

  const nextNode = (edges: FlowEdge[], when?: string): FlowNode | null => {
    const edge = edges.find((e) => e.when === when) ?? edges[0];
    return edge ? byId.get(edge.to) ?? null : null;
  };

  let current: FlowNode | null = byId.get(graph.entry) ?? null;
  let steps = 0;

  while (current && steps < maxSteps) {
    steps += 1;
    if (opts.signal?.aborted) break;
    const edges = outEdges.get(current.id) ?? [];

    switch (current.type) {
      case 'end':
        return ctx;
      case 'start':
        current = nextNode(edges);
        break;
      case 'llm': {
        const res = await exec.llm(current, ctx);
        if (res.toolCalls.length > 0) {
          ctx.messages.push({
            role: 'assistant',
            content: res.content,
            tool_calls: res.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            })),
          });
          for (const tc of res.toolCalls) {
            if (opts.signal?.aborted) break;
            ctx.toolCallCount += 1;
            const result = await exec.tool(tc.name, safeJson(tc.arguments));
            ctx.messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
          }
          current = nextNode(edges, 'tools');
        } else {
          ctx.output = res.content;
          ctx.messages.push({ role: 'assistant', content: res.content });
          current = nextNode(edges, 'done');
        }
        break;
      }
      case 'tool': {
        const toolName = (current.config?.tool as string) ?? '';
        const result = await exec.tool(toolName, (current.config?.args as Record<string, unknown>) ?? {});
        ctx.messages.push({ role: 'tool', name: toolName, content: result });
        current = nextNode(edges);
        break;
      }
      case 'route': {
        const key = (current.config?.key as string) ?? '';
        const value = String(ctx[key] ?? '');
        current = nextNode(edges, value);
        break;
      }
      default:
        current = nextNode(edges);
    }
  }

  return ctx;
}
