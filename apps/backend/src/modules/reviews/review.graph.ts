import { StateGraph, END, MemorySaver } from '@langchain/langgraph';
import { BaseMessage, AIMessage, ToolMessage, HumanMessage } from '@langchain/core/messages';
import { Annotation } from '@langchain/langgraph';

/**
 * ReviewState — the state object flowing through the LangGraph pipeline.
 *
 * Two-phase pipeline:
 *   Phase 1: Code Review (fetchDiff → generateReview → humanGate → postToGitHub)
 *   Phase 2: Test Generation (generateTests → reviewTests → testHumanGate → postTestComment)
 *   Phase 2 is optional — runs only when the human selects test generation on approve.
 */

export const ReviewState = Annotation.Root({
  prNumber: Annotation<number>({ default: () => 0 }),
  prTitle: Annotation<string>({ default: () => '' }),
  commitSha: Annotation<string>({ default: () => '' }),
  owner: Annotation<string>({ default: () => '' }),
  repo: Annotation<string>({ default: () => '' }),
  sourceBranch: Annotation<string>({ default: () => '' }),
  targetBranch: Annotation<string>({ default: () => '' }),
  author: Annotation<string>({ default: () => 'unknown' }),
  diffContent: Annotation<string>({ default: () => '' }),
  taskDescription: Annotation<string>({ default: () => '' }),
  guidelines: Annotation<string>({ default: () => '' }),
  changedFiles: Annotation<string>({ default: () => '' }),
  repoContext: Annotation<string>({ default: () => '' }),
  reviewText: Annotation<string>({ default: () => '' }),
  status: Annotation<
    'fetching' | 'reviewing' | 'awaiting_approval' | 'posting' | 'done' | 'cancelled'
  >({ default: () => 'fetching' }),
  error: Annotation<string>({ default: () => '' }),
  messages: Annotation<BaseMessage[]>({
    default: () => [],
    reducer: (a, b) => a.concat(b),
  }),
  /** Tool call counter — prevents infinite loops */
  toolCallCount: Annotation<number>({ default: () => 0 }),
  /** Human reviewer's personal notes — appended to the final GitHub post */
  humanNotes: Annotation<string>({ default: () => '' }),
  /** Human feedback for re-generation — consumed once, then cleared */
  humanFeedback: Annotation<string>({ default: () => '' }),
  /** How many times the human has requested a revision (max 3) */
  revisionCount: Annotation<number>({ default: () => 0 }),

  // ============================================================================
  // Phase 2: Test Generation (optional — set on approve via controller)
  // ============================================================================

  /** Whether the human requested test generation on approve */
  generateTests: Annotation<boolean>({ default: () => false }),
  /** Which test types to generate: ['unit', 'integration'] */
  testTypes: Annotation<string[]>({ default: () => [] }),
  /** Raw generated test code from the LLM */
  generatedTestsContent: Annotation<string>({ default: () => '' }),
  /** AI review of the generated tests */
  testReviewText: Annotation<string>({ default: () => '' }),
  /** Test phase status — drives Phase 2 routing */
  testStatus: Annotation<
    'idle' | 'generating' | 'reviewing_tests' | 'awaiting_approval' | 'posting' | 'done'
  >({ default: () => 'idle' }),
  /** Test conversation history (separate from code review messages) */
  testMessages: Annotation<BaseMessage[]>({
    default: () => [],
    reducer: (a, b) => a.concat(b),
  }),
  /** Tool call counter for test generation phase */
  testToolCallCount: Annotation<number>({ default: () => 0 }),
});

export type ReviewStateType = typeof ReviewState.State;

// ============================================================================
// Module-level injectable dependencies (set by review.processor.ts before invoke)
// ============================================================================

/** DeepSeek API key — set before graph.invoke() */
let deepseekApiKey: string | null = null;

/** GitHub token for file fetching — set before graph.invoke() */
let githubToken: string | null = null;

/** Set the API keys before running the graph */
export function setGraphDependencies(params: { deepseekApiKey?: string; githubToken?: string }) {
  if (params.deepseekApiKey) deepseekApiKey = params.deepseekApiKey;
  if (params.githubToken) githubToken = params.githubToken;
}

// ============================================================================
// Shared helpers
// ============================================================================

/**
 * Call the DeepSeek API with messages and optional tool definitions.
 * Returns the complete LLM response message.
 */
async function callDeepSeek(
  apiMessages: Array<Record<string, unknown>>,
  tools?: Array<Record<string, unknown>>,
): Promise<{ content: string; tool_calls?: Array<Record<string, unknown>> }> {
  const apiKey = deepseekApiKey || process.env.DEEPSEEK_API_KEY || '';
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: apiMessages,
      tools: tools || [],
      temperature: 0.3,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`DeepSeek API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0]?.message;
  if (!choice) throw new Error('No response from DeepSeek');
  return choice;
}

/**
 * Fetch a single file's content from GitHub.
 */
async function fetchFileContent(
  owner: string, repo: string, ref: string, path: string,
): Promise<string | null> {
  const token = githubToken || process.env.GITHUB_TOKEN;
  if (!token || !owner || !repo) return null;

  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' },
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (body.encoding === 'base64' && body.content) {
      return Buffer.from(body.content, 'base64').toString('utf-8');
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Phase 1 Nodes: Code Review
// ============================================================================

async function fetchDiffNode(state: ReviewStateType): Promise<Partial<ReviewStateType>> {
  console.log(`[LangGraph] fetchDiff: PR #${state.prNumber} — ${state.prTitle}`);
  return { status: 'reviewing' };
}

/**
 * Node 2: generateReview — calls DeepSeek API with tool loop support.
 */
async function generateReviewNode(state: ReviewStateType): Promise<Partial<ReviewStateType>> {
  console.log(`[LangGraph] generateReview: PR #${state.prNumber}, turn ${state.toolCallCount}, revision ${state.revisionCount}`);

  const repoContextBlock = state.repoContext
    ? `\n## Repository Context\n${state.repoContext.slice(0, 4000)}\n`
    : '';

  const systemPrompt = [
    'You are a code reviewer for an automated governance platform.',
    'You have access to a ReadFile tool to fetch file contents on demand.',
    'Use ReadFile when you need full file content not visible in the diff.',
    'After reading files, produce a final review in markdown.',
  ].join('\n');

  const feedbackBlock = state.humanFeedback
    ? [
        '',
        '## Reviewer Feedback',
        'The human reviewer has requested the following changes or additional analysis:',
        '',
        state.humanFeedback,
        '',
        'Please address this feedback in your revised review. Focus on the areas mentioned.',
        '',
      ].join('\n')
    : '';

  const userPrompt = [
    '## Task Description',
    state.taskDescription || '(No task description)',
    '',
    '## Coding Standards',
    state.guidelines || '(None configured)',
    '',
    '## Diff',
    '```diff',
    state.diffContent?.slice(0, 8000) || '(No diff)',
    '```',
    repoContextBlock,
    feedbackBlock,
    '',
    '## Instructions',
    '1. If you need to see a file, use the ReadFile tool with the file path.',
    '2. When you have enough context, produce the final review.',
    '',
    'Final review format:',
    `## Code Review for PR #${state.prNumber}\n`,
    '### Summary\n...\n',
    '### Findings\n- **finding**: explanation\n',
    '### Verdict\nPASS | WARNING | FAIL',
  ].join('\n');

  const apiMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  for (const m of state.messages) {
    const type = m._getType();
    if (type === 'ai') {
      const aiMsg = m as AIMessage;
      const entry: Record<string, unknown> = {
        role: 'assistant',
        content: typeof aiMsg.content === 'string' ? aiMsg.content : JSON.stringify(aiMsg.content),
      };
      if ((aiMsg as Record<string, unknown>).tool_calls) {
        entry.tool_calls = (aiMsg as Record<string, unknown>).tool_calls;
      }
      apiMessages.push(entry);
    } else if (type === 'tool') {
      const toolMsg = m as ToolMessage;
      apiMessages.push({
        role: 'tool',
        tool_call_id: toolMsg.tool_call_id,
        content: typeof toolMsg.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg.content),
      });
    }
  }

  const tools = [{
    type: 'function',
    function: {
      name: 'ReadFile',
      description: 'Read the full content of a file from the repository',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to repo root' },
        },
        required: ['path'],
      },
    },
  }];

  try {
    const choice = await callDeepSeek(apiMessages, tools);

    if (choice.tool_calls && choice.tool_calls.length > 0 && state.toolCallCount < 10) {
      console.log(`[LangGraph] Tool calls: ${choice.tool_calls.map((t: Record<string, unknown>) => (t.function as Record<string, string>).name).join(', ')}`);

      const assistantMsg = new AIMessage({ content: choice.content || '' });
      (assistantMsg as Record<string, unknown>).tool_calls = choice.tool_calls;

      const newMessages: BaseMessage[] = [assistantMsg];
      for (const tc of choice.tool_calls) {
        if (tc.function.name === 'ReadFile') {
          const args = JSON.parse(tc.function.arguments);
          const content = await fetchFileContent(state.owner, state.repo, state.commitSha, args.path);
          newMessages.push(new ToolMessage({
            content: content || '[File not found]',
            tool_call_id: tc.id,
            name: 'ReadFile',
          }));
        }
      }

      return {
        messages: newMessages,
        toolCallCount: state.toolCallCount + 1,
        status: 'reviewing',
        humanFeedback: '',
      };
    }

    const reviewText = choice.content || 'No review generated';
    console.log(`[LangGraph] Review complete: ${reviewText.length} chars`);

    return {
      reviewText,
      status: 'awaiting_approval',
      messages: [new AIMessage(reviewText)],
      humanFeedback: '',
    };
  } catch (err) {
    console.error('[LangGraph] generateReview error:', err);
    return {
      reviewText: `## Review Error\n\nFailed to generate review: ${(err as Error).message}`,
      status: 'awaiting_approval',
      error: (err as Error).message,
      humanFeedback: '',
    };
  }
}

/** Pass-through node for HITL pause. */
async function humanGateNode(state: ReviewStateType): Promise<Partial<ReviewStateType>> {
  console.log(`[LangGraph] humanGate: PR #${state.prNumber}, status=${state.status}, revision ${state.revisionCount}`);
  return {};
}

/** Stub — real posting in processor. */
async function postToGitHubNode(state: ReviewStateType): Promise<Partial<ReviewStateType>> {
  console.log(`[LangGraph] postToGitHub: posting review for PR #${state.prNumber}${state.generateTests ? ' (tests requested)' : ''}`);
  return { status: 'done' };
}

// ============================================================================
// Phase 2 Nodes: Test Generation
// ============================================================================

/**
 * Node: generateTests — LLM writes unit/integration tests for the diff.
 *
 * Uses the changed files and diff to generate test code. The test type
 * selection (unit, integration, or both) comes from state.testTypes.
 */
async function generateTestsNode(state: ReviewStateType): Promise<Partial<ReviewStateType>> {
  const types = state.testTypes.join(' and ');
  console.log(`[LangGraph] generateTests: PR #${state.prNumber}, types=[${state.testTypes.join(', ')}]`);

  // Build repo context: project structure, test framework, existing test patterns
  const repoContextBlock = state.repoContext
    ? `\n## Repository Structure\n${state.repoContext.slice(0, 4000)}\n`
    : '';

  const systemPrompt = [
    'You are a test engineer. Write tests for the provided code changes.',
    `Generate ${types} tests.`,
    '',
    'FIRST: read any files you need using the ReadFile tool — do not guess',
    'imports, mock setups, or existing test patterns. Read actual source files',
    'and existing test files in the repository for accurate context.',
    '',
    'UNIT TESTS:',
    '- Match the project\'s existing test framework and patterns.',
    '- Mock external dependencies (APIs, databases, file system) using the',
    '  same mocking library the project already uses.',
    '- Test both happy path and edge cases.',
    '- Use real imports from actual source files.',
    '',
    'INTEGRATION TESTS:',
    '- Test API endpoints, database interactions, or service boundaries.',
    '- Use the same test setup (supertest, test containers, etc.) as the project.',
    '- Verify request/response contracts against actual types/interfaces.',
    '',
    'Output: raw TypeScript/JavaScript test code in code blocks.',
    'Include a comment at the top listing which files you read for context.',
  ].join('\n');

  const userPrompt = [
    '## Task Description',
    state.taskDescription || '(No task description)',
    '',
    '## Changed Files',
    state.changedFiles || '(Unknown)',
    '',
    '## Diff',
    '```diff',
    state.diffContent?.slice(0, 6000) || '(No diff)',
    '```',
    repoContextBlock,
    '',
    '## Instructions',
    `1. Read the actual source files that changed to understand full context.`,
    `2. Read existing test files in the project to match patterns and setup.`,
    `3. Generate ${types} tests that integrate with the existing codebase.`,
    'Output valid code with correct imports. Do not guess paths or mock setups.',
  ].join('\n');

  const apiMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  // Tool definitions — same ReadFile tool the code reviewer uses
  const tools = [{
    type: 'function',
    function: {
      name: 'ReadFile',
      description: 'Read the full content of a file from the repository to understand imports, types, and existing patterns.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to repo root' },
        },
        required: ['path'],
      },
    },
  }];

  try {
    const choice = await callDeepSeek(apiMessages, tools);

    // Tool call loop — same pattern as code reviewer
    if (choice.tool_calls && choice.tool_calls.length > 0 && state.testToolCallCount < 8) {
      console.log(`[LangGraph] Test tool calls: ${choice.tool_calls.map((t: Record<string, unknown>) => (t.function as Record<string, string>).name).join(', ')}`);

      const assistantMsg = new AIMessage({ content: choice.content || '' });
      (assistantMsg as Record<string, unknown>).tool_calls = choice.tool_calls;

      const newMessages: BaseMessage[] = [assistantMsg];
      for (const tc of choice.tool_calls) {
        if (tc.function.name === 'ReadFile') {
          const args = JSON.parse(tc.function.arguments);
          const content = await fetchFileContent(state.owner, state.repo, state.commitSha, args.path);
          newMessages.push(new ToolMessage({
            content: content || '[File not found]',
            tool_call_id: tc.id,
            name: 'ReadFile',
          }));
        }
      }

      return {
        testMessages: newMessages,
        testToolCallCount: state.testToolCallCount + 1,
        testStatus: 'generating',
      };
    }

    const testContent = choice.content || '// No tests generated';
    console.log(`[LangGraph] Tests generated: ${testContent.length} chars`);

    return {
      generatedTestsContent: testContent,
      testStatus: 'reviewing_tests',
      testMessages: [new AIMessage(testContent)],
    };
  } catch (err) {
    console.error('[LangGraph] generateTests error:', err);
    return {
      generatedTestsContent: `// Test generation failed: ${(err as Error).message}`,
      testStatus: 'awaiting_approval',
    };
  }
}

/**
 * Node: reviewTests — LLM reviews the generated tests for correctness and coverage.
 */
async function reviewTestsNode(state: ReviewStateType): Promise<Partial<ReviewStateType>> {
  console.log(`[LangGraph] reviewTests: PR #${state.prNumber}, test content ${state.generatedTestsContent.length} chars`);

  const systemPrompt = [
    'You are a test reviewer for an automated governance platform.',
    'Review the generated tests for:',
    '1. Correctness — do the tests actually test the code changes?',
    '2. Coverage — are edge cases, error paths, and happy paths covered?',
    '3. Structure — are mocks appropriate, assertions meaningful?',
    '4. Maintainability — clear test names, no hardcoded magic values?',
    '',
    'Output: a markdown review with Summary, Findings, and Verdict (PASS | NEEDS_WORK | FAIL).',
    'If tests need changes, specify exactly what to fix.',
  ].join('\n');

  const userPrompt = [
    '## Original Code Changes',
    '```diff',
    state.diffContent?.slice(0, 6000) || '(No diff)',
    '```',
    '',
    '## Generated Tests',
    '```',
    state.generatedTestsContent?.slice(0, 12000) || '(No tests)',
    '```',
    '',
    '## Task Description',
    state.taskDescription || '(No description)',
    '',
    'Review these tests against the original code changes.',
    'Verdict: PASS | NEEDS_WORK | FAIL',
  ].join('\n');

  const apiMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  try {
    const choice = await callDeepSeek(apiMessages);
    const reviewText = choice.content || 'No test review generated';

    console.log(`[LangGraph] Test review complete: ${reviewText.length} chars`);

    return {
      testReviewText: reviewText,
      testStatus: 'awaiting_approval',
      testMessages: [...(state.testMessages || []), new AIMessage(reviewText)],
    };
  } catch (err) {
    console.error('[LangGraph] reviewTests error:', err);
    return {
      testReviewText: `## Test Review Error\n\nFailed to review tests: ${(err as Error).message}`,
      testStatus: 'awaiting_approval',
    };
  }
}

/** Pass-through node for Phase 2 HITL pause. */
async function testHumanGateNode(state: ReviewStateType): Promise<Partial<ReviewStateType>> {
  console.log(`[LangGraph] testHumanGate: PR #${state.prNumber}, testStatus=${state.testStatus}`);
  return {};
}

/** Stub — real posting in processor. */
async function postTestCommentNode(state: ReviewStateType): Promise<Partial<ReviewStateType>> {
  console.log(`[LangGraph] postTestComment: posting test review for PR #${state.prNumber}`);
  return { testStatus: 'done' };
}

// ============================================================================
// Conditional routing
// ============================================================================

function afterHumanGate(state: ReviewStateType): string {
  switch (state.status) {
    case 'reviewing': return 'generateReview';
    case 'awaiting_approval': return 'postToGitHub';
    case 'cancelled': return 'END';
    default: return 'postToGitHub';
  }
}

function afterGenerateReview(state: ReviewStateType): string {
  if (state.status === 'reviewing') return 'generateReview';
  return 'humanGate';
}

/** After code review posted: check if Phase 2 is needed */
function afterPostToGitHub(state: ReviewStateType): string {
  if (state.generateTests && state.testTypes.length > 0) {
    return 'generateTests';
  }
  return 'END';
}

/** After test generation: loop if still fetching files, review if done */
function afterGenerateTests(state: ReviewStateType): string {
  if (state.testStatus === 'generating') return 'generateTests';
  if (state.testStatus === 'reviewing_tests') return 'reviewTests';
  return 'testHumanGate';
}

/** Phase 2 HITL routing */
function afterTestHumanGate(state: ReviewStateType): string {
  switch (state.testStatus) {
    case 'awaiting_approval': return 'postTestComment';
    case 'done': return 'END';
    default: return 'postTestComment';
  }
}

// ============================================================================
// Graph builder
// ============================================================================

const checkpointer = new MemorySaver();

export function buildReviewGraph() {
  const graph = new StateGraph(ReviewState)
    // Phase 1
    .addNode('fetchDiff', fetchDiffNode)
    .addNode('generateReview', generateReviewNode)
    .addNode('humanGate', humanGateNode)
    .addNode('postToGitHub', postToGitHubNode)
    // Phase 2
    .addNode('generateTests', generateTestsNode)
    .addNode('reviewTests', reviewTestsNode)
    .addNode('testHumanGate', testHumanGateNode)
    .addNode('postTestComment', postTestCommentNode)

    // Phase 1 edges
    .addEdge('__start__', 'fetchDiff')
    .addEdge('fetchDiff', 'generateReview')
    .addConditionalEdges('generateReview', afterGenerateReview, {
      generateReview: 'generateReview',
      humanGate: 'humanGate',
    })
    .addConditionalEdges('humanGate', afterHumanGate, {
      generateReview: 'generateReview',
      postToGitHub: 'postToGitHub',
      END: END,
    })
    .addConditionalEdges('postToGitHub', afterPostToGitHub, {
      generateTests: 'generateTests',
      END: END,
    })

    // Phase 2 edges
    .addConditionalEdges('generateTests', afterGenerateTests, {
      generateTests: 'generateTests',
      reviewTests: 'reviewTests',
      testHumanGate: 'testHumanGate',
    })
    .addEdge('reviewTests', 'testHumanGate')
    .addConditionalEdges('testHumanGate', afterTestHumanGate, {
      postTestComment: 'postTestComment',
      END: END,
    })
    .addEdge('postTestComment', END);

  return graph.compile({
    interruptBefore: ['humanGate', 'testHumanGate'],
    checkpointer,
  });
}

export type ReviewGraph = ReturnType<typeof buildReviewGraph>;
