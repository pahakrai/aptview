import { StateGraph, END, MemorySaver } from '@langchain/langgraph';
import { BaseMessage, AIMessage, ToolMessage, HumanMessage } from '@langchain/core/messages';
import { Annotation } from '@langchain/langgraph';

/**
 * ReviewState — the state object flowing through the LangGraph pipeline.
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
// Nodes
// ============================================================================

async function fetchDiffNode(state: ReviewStateType): Promise<Partial<ReviewStateType>> {
  console.log(`[LangGraph] fetchDiff: PR #${state.prNumber} — ${state.prTitle}`);
  return { status: 'reviewing' };
}

/**
 * Node 2: generateReview — calls DeepSeek API with tool loop support.
 *
 * Flow:
 *   1. Assembles the prompt from task + standards + diff + repo context
 *   2. If humanFeedback is present, injects it as a user message (consumed once)
 *   3. Calls DeepSeek API with tool definitions (ReadFile)
 *   4. If the LLM requests a file → fetches it via GitHub API → loops back
 *   5. If the LLM produces final text → saves reviewText → sets awaiting_approval
 */
async function generateReviewNode(state: ReviewStateType): Promise<Partial<ReviewStateType>> {
  console.log(`[LangGraph] generateReview: PR #${state.prNumber}, turn ${state.toolCallCount}, revision ${state.revisionCount}`);

  // Build the system prompt (same every turn)
  const repoContextBlock = state.repoContext
    ? `\n## Repository Context\n${state.repoContext.slice(0, 4000)}\n`
    : '';

  const systemPrompt = [
    'You are a code reviewer for an automated governance platform.',
    'You have access to a ReadFile tool to fetch file contents on demand.',
    'Use ReadFile when you need full file content not visible in the diff.',
    'After reading files, produce a final review in markdown.',
  ].join('\n');

  // -----------------------------------------------------------------------
  // If human feedback is present, add a direction block before the diff
  // -----------------------------------------------------------------------
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

  // Build messages for DeepSeek API.
  // Always start with system + user prompt, then append all assistant/tool messages
  // from previous turns (stored in state.messages).
  const apiMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  // Append conversation history from state (assistant responses and tool results)
  for (const m of state.messages) {
    const type = m._getType();
    if (type === 'ai') {
      const aiMsg = m as AIMessage;
      const entry: Record<string, unknown> = {
        role: 'assistant',
        content: typeof aiMsg.content === 'string' ? aiMsg.content : JSON.stringify(aiMsg.content),
      };
      // Include tool_calls if present (DeepSeek expects them)
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

  // Tool definitions
  const tools = [
    {
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
    },
  ];

  // -----------------------------------------------------------------------
  // Call DeepSeek API
  // -----------------------------------------------------------------------
  try {
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
        tools,
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

    // -----------------------------------------------------------------------
    // Tool call? → execute and loop back
    // -----------------------------------------------------------------------
    if (choice.tool_calls && choice.tool_calls.length > 0 && state.toolCallCount < 10) {
      console.log(`[LangGraph] Tool calls: ${choice.tool_calls.map((t: Record<string, unknown>) => (t.function as Record<string, string>).name).join(', ')}`);

      // Store assistant message with tool_calls
      const assistantMsg = new AIMessage({
        content: choice.content || '',
      });
      (assistantMsg as Record<string, unknown>).tool_calls = choice.tool_calls;

      // Execute each tool and create ToolMessage with proper tool_call_id
      const newMessages: BaseMessage[] = [assistantMsg];
      for (const tc of choice.tool_calls) {
        if (tc.function.name === 'ReadFile') {
          const args = JSON.parse(tc.function.arguments);
          const content = await fetchFileContent(state.owner, state.repo, state.commitSha, args.path);
          newMessages.push(new ToolMessage({
            content: content || '[File not found]',
            tool_call_id: tc.id,  // ← CRITICAL: matches the call to the result
            name: 'ReadFile',
          }));
        }
      }

      return {
        messages: newMessages,
        toolCallCount: state.toolCallCount + 1,
        status: 'reviewing',
        // Consume humanFeedback so it's only used once (on the first call of this revision)
        humanFeedback: '',
      };
    }

    // -----------------------------------------------------------------------
    // Final response → review complete
    // -----------------------------------------------------------------------
    const reviewText = choice.content || 'No review generated';
    console.log(`[LangGraph] Review complete: ${reviewText.length} chars`);

    return {
      reviewText,
      status: 'awaiting_approval',
      messages: [new AIMessage(reviewText)],
      // Consume humanFeedback on final response too (should already be empty if tool calls happened)
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

/**
 * Node 3: humanGate — interrupt point for HITL decision.
 *
 * This is a pass-through node. The graph pauses BEFORE this node runs.
 * While paused, the human can modify checkpoint state (humanFeedback, humanNotes,
 * status) via the controller. When resumed, this node returns {} and the
 * conditional edge routes based on the (potentially modified) status.
 */
async function humanGateNode(state: ReviewStateType): Promise<Partial<ReviewStateType>> {
  console.log(`[LangGraph] humanGate: PR #${state.prNumber}, status=${state.status}, revision ${state.revisionCount}`);
  return {};
}

/**
 * Node 4: postToGitHub — stub that marks the review as done.
 * The actual GitHub post happens in ReviewProcessor.processPostJob.
 */
async function postToGitHubNode(state: ReviewStateType): Promise<Partial<ReviewStateType>> {
  console.log(`[LangGraph] postToGitHub: posting review for PR #${state.prNumber}`);
  return { status: 'done' };
}

// ============================================================================
// Conditional routing
// ============================================================================

/** Determine next node after humanGate: based on the current status */
function afterHumanGate(state: ReviewStateType): string {
  switch (state.status) {
    case 'reviewing':
      // Human requested revision — loop back to generateReview
      return 'generateReview';
    case 'awaiting_approval':
      // First-time generation complete, or revision complete — proceed
      return 'postToGitHub';
    case 'cancelled':
      return 'END';
    default:
      return 'postToGitHub';
  }
}

/** Determine next node after generateReview: loop back if still in tool-calling phase */
function afterGenerateReview(state: ReviewStateType): string {
  if (state.status === 'reviewing') return 'generateReview';
  return 'humanGate';
}

// ============================================================================
// Graph builder
// ============================================================================

const checkpointer = new MemorySaver();

export function buildReviewGraph() {
  const graph = new StateGraph(ReviewState)
    .addNode('fetchDiff', fetchDiffNode)
    .addNode('generateReview', generateReviewNode)
    .addNode('humanGate', humanGateNode)
    .addNode('postToGitHub', postToGitHubNode)
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
    .addEdge('postToGitHub', END);

  return graph.compile({
    interruptBefore: ['humanGate'],
    checkpointer,
  });
}

export type ReviewGraph = ReturnType<typeof buildReviewGraph>;
