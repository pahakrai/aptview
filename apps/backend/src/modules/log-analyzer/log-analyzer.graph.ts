import { StateGraph, END, MemorySaver } from '@langchain/langgraph';
import { BaseMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { Annotation } from '@langchain/langgraph';
import type { UnifiedToolbox } from './toolbox';

/**
 * LogAnalysisState — state flowing through the LangGraph pipeline.
 *
 * Single-node graph: analyzeLogs ⇄ (tool loop) → END.
 * Tools come from the UnifiedToolbox (core + local skills + optional MCP).
 */

export const LogAnalysisState = Annotation.Root({
  logContent: Annotation<string>({ default: () => '' }),
  fileName: Annotation<string>({ default: () => '' }),
  analysisText: Annotation<string>({ default: () => '' }),
  status: Annotation<'analyzing' | 'complete' | 'error'>({ default: () => 'analyzing' }),
  error: Annotation<string>({ default: () => '' }),
  messages: Annotation<BaseMessage[]>({
    default: () => [],
    reducer: (a, b) => a.concat(b),
  }),
  toolCallCount: Annotation<number>({ default: () => 0 }),
});

export type LogAnalysisStateType = typeof LogAnalysisState.State;

// ============================================================================
// Module-level injectable dependencies
// ============================================================================

let deepseekApiKey: string | null = null;
let toolboxInstance: UnifiedToolbox | null = null;
let onTokenCallback: ((token: string) => void) | null = null;
let abortSignal: AbortSignal | null = null;

export function setLogAnalyzerDependencies(params: {
  deepseekApiKey?: string;
  toolbox?: UnifiedToolbox;
  onToken?: (token: string) => void;
  abortSignal?: AbortSignal | null;
}) {
  if (params.deepseekApiKey) deepseekApiKey = params.deepseekApiKey;
  if (params.toolbox) toolboxInstance = params.toolbox;
  if (params.onToken) onTokenCallback = params.onToken;
  if (params.abortSignal !== undefined) abortSignal = params.abortSignal;
}

// ============================================================================
// System prompt — instructs DeepSeek how to use the available tools
// ============================================================================

const SYSTEM_PROMPT = [
  'You are a senior Site Reliability Engineer troubleshooting a Kubernetes cluster.',
  'The user will ask a question about their cluster. Your job is to answer it.',
  '',
  'You have access to these tool categories:',
  '',
  '**Kubetail MCP tools** (primary): kubetail_list_pods, kubetail_get_logs, kubetail_scan_errors, kubetail_describe_pod, kubetail_get_config',
  '  — Use these to fetch live data from the Kubernetes cluster. This is how you answer the user\'s question.',
  '',
  '**Core log tools** (fallback): ParseLogFormat, ExtractErrors, SearchLogs, CountByLevel',
  '  — Use these if the user provides raw log text to analyze.',
  '',
  '**Business context skills**: prioritize_by_sla, correlate_cross_cloud_trace, route_diagnostic_to_owner',
  '  — Use these to add business priority, trace correlation, and team routing.',
  '',
  '**Other cloud MCP tools** (if connected): k8s_*, aws_*, gcp_*',
  '  — Use these for additional cloud log sources.',
  '',
  '## Protocol',
  '1. Read the user\'s question carefully. Identify: what namespace? what deployment? what time range? what kind of issue?',
  '2. Call kubetail_list_pods to get cluster health overview — spot crashing/restarting pods.',
  '3. Call kubetail_scan_errors or kubetail_get_logs to fetch and aggregate logs.',
  '4. Call kubetail_describe_pod on unhealthy pods for events and conditions.',
  '5. Call kubetail_get_config if the issue seems config-related (wrong endpoints, missing env vars).',
  '6. For each error found: call prioritize_by_sla to assess business impact.',
  '7. As a final step: call route_diagnostic_to_owner with a summary.',
  '',
  '## Output format',
  'Produce a diagnostic report in markdown:',
  '',
  '### Cluster Health Overview',
  '- Pod status summary, restarts, unhealthy pods identified',
  '',
  '### Error Analysis',
  '- Recurring error patterns grouped by frequency',
  '- Each error with: timestamp, message, likely root cause, SLA priority',
  '- Order by severity: Critical first, warnings last',
  '',
  '### Root Cause',
  '- Most likely cause of the issue based on log + config analysis',
  '',
  '### Debugging Priority',
  '- Ranked list of what to investigate first, with specific pod names and commands',
  '',
  '### Team Routing & Next Steps',
  '- Who owns the failing service, Slack channel, repo',
  '- Specific kubectl commands or config changes to apply',
].join('\n');

// ============================================================================
// DeepSeek API call with SSE streaming
// ============================================================================

/**
 * Call DeepSeek API with streaming enabled.
 * Emits each content delta via onTokenCallback for live UI updates.
 *
 * Returns the complete message object (content + optional tool_calls).
 * During streaming, tool_calls are only available at the end of the stream.
 */
async function callDeepSeekStreaming(
  apiMessages: Array<Record<string, unknown>>,
  tools: Array<Record<string, unknown>>,
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
      tools,
      temperature: 0.3,
      max_tokens: 4096,
      stream: true,
    }),
    signal: abortSignal,   // fetch natively aborts the TCP connection on cancel
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`DeepSeek API error ${response.status}: ${err}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let fullContent = '';
  let toolCalls: Array<Record<string, unknown>> = [];
  const toolCallAccumulator = new Map<number, { id: string; name: string; arguments: string }>();

  while (true) {
    // Check for cancellation before each chunk read
    if (abortSignal?.aborted) {
      reader.cancel();
      throw new DOMException('Analysis cancelled by user', 'AbortError');
    }

    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n');

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        // Content delta — emit via callback for live streaming
        if (delta.content) {
          fullContent += delta.content;
          if (onTokenCallback) onTokenCallback(delta.content);
        }

        // Tool call deltas — accumulate across chunks
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallAccumulator.has(idx)) {
              toolCallAccumulator.set(idx, {
                id: tc.id || '',
                name: '',
                arguments: '',
              });
            }
            const entry = toolCallAccumulator.get(idx)!;
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name += tc.function.name;
            if (tc.function?.arguments) entry.arguments += tc.function.arguments;
          }
        }
      } catch {
        // Skip unparseable SSE lines
      }
    }
  }

  // Convert accumulated tool calls to the API response format
  if (toolCallAccumulator.size > 0) {
    toolCalls = [...toolCallAccumulator.values()].map((tc) => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: tc.arguments,
      },
    }));
  }

  return {
    content: fullContent,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

// ============================================================================
// Node: analyzeLogs
// ============================================================================

async function analyzeLogsNode(
  state: LogAnalysisStateType,
): Promise<Partial<LogAnalysisStateType>> {
  // Check for cancellation at node entry (covers between-graph-step gaps)
  if (abortSignal?.aborted) {
    console.log('[LogAnalyzer] Cancelled before node execution');
    return {
      analysisText: 'Analysis cancelled by user.',
      status: 'error',
      error: 'cancelled',
    };
  }

  const logChars = state.logContent.length;
  console.log(
    `[LogAnalyzer] analyzeLogs: turn ${state.toolCallCount + 1}, ${logChars} chars, ` +
    `${toolboxInstance?.toolLayers.size || 0} tools available`,
  );

  const userPrompt = [
    '## Log File' + (state.fileName ? `: ${state.fileName}` : ''),
    '',
    '```',
    state.logContent.slice(0, 32000),
    '```',
    '',
    logChars > 32000
      ? `(Truncated — ${logChars} total chars, showing first 32000)`
      : '',
  ].join('\n');

  // Build messages with accumulated conversation history
  const apiMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  for (const m of state.messages) {
    const type = m._getType();
    if (type === 'ai') {
      const aiMsg = m as AIMessage;
      const entry: Record<string, unknown> = {
        role: 'assistant',
        content:
          typeof aiMsg.content === 'string'
            ? aiMsg.content
            : JSON.stringify(aiMsg.content),
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
        content:
          typeof toolMsg.content === 'string'
            ? toolMsg.content
            : JSON.stringify(toolMsg.content),
      });
    }
  }

  const tools = toolboxInstance?.toolDefinitions || [];

  try {
    const { content, tool_calls } = await callDeepSeekStreaming(apiMessages, tools);

    // -----------------------------------------------------------------------
    // Tool call? → dispatch to toolbox router, accumulate, loop back
    // -----------------------------------------------------------------------
    if (tool_calls && tool_calls.length > 0 && state.toolCallCount < 15) {
      const toolNames = tool_calls.map(
        (t: Record<string, unknown>) => (t.function as Record<string, string>).name,
      );
      console.log(
        `[LogAnalyzer] Tool calls (turn ${state.toolCallCount + 1}): ${toolNames.join(', ')}`,
      );

      const assistantMsg = new AIMessage({ content: content || '' });
      (assistantMsg as Record<string, unknown>).tool_calls = tool_calls;

      const newMessages: BaseMessage[] = [assistantMsg];

      for (const tc of tool_calls) {
        // Check for cancellation before each tool execution
        if (abortSignal?.aborted) {
          console.log('[LogAnalyzer] Cancelled during tool execution');
          return {
            analysisText: 'Analysis cancelled by user.',
            status: 'error',
            error: 'cancelled',
          };
        }

        const args = JSON.parse((tc.function as Record<string, string>).arguments || '{}');

        let result: string;
        if (toolboxInstance) {
          result = await toolboxInstance.executeTool(
            (tc.function as Record<string, string>).name,
            args,
            state.logContent,
          );
        } else {
          result = `Toolbox not initialized. Cannot execute tool: ${(tc.function as Record<string, string>).name}`;
        }

        newMessages.push(
          new ToolMessage({
            content: result,
            tool_call_id: tc.id as string,
            name: (tc.function as Record<string, string>).name,
          }),
        );
      }

      return {
        messages: newMessages,
        toolCallCount: state.toolCallCount + 1,
        status: 'analyzing',
      };
    }

    // -----------------------------------------------------------------------
    // Final response → analysis complete
    // -----------------------------------------------------------------------
    const analysisText = content || 'No analysis generated';
    console.log(`[LogAnalyzer] Analysis complete: ${analysisText.length} chars`);

    return {
      analysisText,
      status: 'complete',
      messages: [new AIMessage(analysisText)],
    };
  } catch (err) {
    // Check for user cancellation
    if (err instanceof DOMException && err.name === 'AbortError') {
      console.log('[LogAnalyzer] Analysis cancelled by user');
      return {
        analysisText: 'Analysis cancelled by user.',
        status: 'error',
        error: 'cancelled',
      };
    }

    console.error('[LogAnalyzer] error:', err);
    return {
      analysisText: `## Analysis Error\n\n${(err as Error).message}`,
      status: 'error',
      error: (err as Error).message,
    };
  }
}

// ============================================================================
// Routing
// ============================================================================

function afterAnalyzeLogs(state: LogAnalysisStateType): string {
  if (state.status === 'analyzing') return 'analyzeLogs';
  return END;
}

// ============================================================================
// Graph builder
// ============================================================================

const checkpointer = new MemorySaver();

export function buildLogAnalyzerGraph() {
  const graph = new StateGraph(LogAnalysisState)
    .addNode('analyzeLogs', analyzeLogsNode)
    .addEdge('__start__', 'analyzeLogs')
    .addConditionalEdges('analyzeLogs', afterAnalyzeLogs, {
      analyzeLogs: 'analyzeLogs',
      [END]: END,
    });

  return graph.compile({ checkpointer });
}

export type LogAnalyzerGraph = ReturnType<typeof buildLogAnalyzerGraph>;
