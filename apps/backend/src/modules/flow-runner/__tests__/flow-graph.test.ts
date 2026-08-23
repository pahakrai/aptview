import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeFlowGraph,
  PRESET_ORCHESTRATOR,
  PRESET_SEQUENTIAL,
  validateFlowGraph,
  type GraphContext,
  type GraphExecutors,
} from '../flow-graph.ts';

test('validateFlowGraph: presets are valid', () => {
  assert.deepEqual(validateFlowGraph(PRESET_SEQUENTIAL), []);
  assert.deepEqual(validateFlowGraph(PRESET_ORCHESTRATOR), []);
});

test('validateFlowGraph: rejects a missing entry node', () => {
  const g = { ...PRESET_SEQUENTIAL, entry: 'nope' };
  assert.ok(validateFlowGraph(g).some((e) => e.includes('entry')));
});

test('validateFlowGraph: rejects an edge to an unknown node', () => {
  const g = { ...PRESET_SEQUENTIAL, edges: [...PRESET_SEQUENTIAL.edges, { from: 'review', to: 'missing' }] };
  assert.ok(validateFlowGraph(g).some((e) => e.includes('unknown')));
});

test('executeFlowGraph: sequential runs one llm call and sets output', async () => {
  const calls: string[] = [];
  const exec: GraphExecutors = {
    llm: async (node) => {
      calls.push(node.id);
      return { content: 'PASS', toolCalls: [] };
    },
    tool: async () => '',
  };
  const ctx: GraphContext = { messages: [], output: '', toolCallCount: 0 };
  const out = await executeFlowGraph(PRESET_SEQUENTIAL, ctx, exec);
  assert.equal(out.output, 'PASS');
  assert.equal(calls.length, 1);
});

test('executeFlowGraph: orchestrator loops through tools then emits output', async () => {
  let llmCalls = 0;
  const exec: GraphExecutors = {
    llm: async () => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return { content: '', toolCalls: [{ id: 't1', name: 'search_guidelines', arguments: '{"query":"x"}' }] };
      }
      return { content: 'FINAL', toolCalls: [] };
    },
    tool: async (name) => 'hit:' + name,
  };
  const ctx: GraphContext = { messages: [], output: '', toolCallCount: 0 };
  const out = await executeFlowGraph(PRESET_ORCHESTRATOR, ctx, exec, { maxSteps: 10 });
  assert.equal(out.output, 'FINAL');
  assert.equal(out.toolCallCount, 1);
  assert.equal(llmCalls, 2);
});

test('executeFlowGraph: maxSteps caps an infinite tool loop', async () => {
  const exec: GraphExecutors = {
    llm: async () => ({ content: '', toolCalls: [{ id: 't', name: 'x', arguments: '{}' }] }),
    tool: async () => 'ok',
  };
  const ctx: GraphContext = { messages: [], output: '', toolCallCount: 0 };
  const out = await executeFlowGraph(PRESET_ORCHESTRATOR, ctx, exec, { maxSteps: 3 });
  assert.equal(out.output, '');
  assert.equal(out.toolCallCount, 2);
});

test('executeFlowGraph: abort signal stops execution', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const exec: GraphExecutors = { llm: async () => ({ content: 'X', toolCalls: [] }), tool: async () => '' };
  const ctx: GraphContext = { messages: [], output: '', toolCallCount: 0 };
  const out = await executeFlowGraph(PRESET_SEQUENTIAL, ctx, exec, { signal: ctrl.signal });
  assert.equal(out.output, '');
});
