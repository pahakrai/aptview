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

export function setLogAnalyzerDependencies(params: {
  deepseekApiKey?: string;
  toolbox?: UnifiedToolbox;
}) {
  if (params.deepseekApiKey) deepseekApiKey = params.deepseekApiKey;
  if (params.toolbox) toolboxInstance = params.toolbox;
}

// ============================================================================
// System prompt — instructs DeepSeek how to use the available tools
// ============================================================================

const SYSTEM_PROMPT = [
  'You are a senior Site Reliability Engineer analyzing log files.',
  'You have access to multiple tool categories:',
  '',
  '**Core log tools**: ParseLogFormat, ExtractErrors, SearchLogs, CountByLevel',
  '  — Use these FIRST to understand the log structure and find errors.',
  '',
  '**Business context skills**: prioritize_by_sla, correlate_cross_cloud_trace, route_diagnostic_to_owner',
  '  — Use these to add business priority, trace correlation, and team routing.',
  '',
  '**Cloud MCP tools** (if connected): k8s_*, aws_*, gcp_*',
  '  — Use these to pull logs directly from cloud infrastructure.',
  '',
  '## Analysis protocol',
  '1. Call ParseLogFormat to understand the log structure.',
  '2. Call CountByLevel to see severity distribution.',
  '3. Call ExtractErrors to get error details with context.',
  '4. Use SearchLogs to find specific patterns, trace IDs, or exception names.',
  '5. For each critical error found: call prioritize_by_sla to assess business impact.',
  '6. If you find a trace/correlation ID: call correlate_cross_cloud_trace.',
  '7. As a final step: call route_diagnostic_to_owner with a summary.',
  '',
  '## Output format',
  'Produce a final report in markdown:',
  '',
  '### Log Summary',
  '- Format, time range, total entries, severity distribution',
  '',
  '### Critical Issues (prioritized by SLA)',
  '- Each error with: timestamp, message, likely cause, SLA priority, suggested fix',
  '- Order by priority: P1-CRITICAL first, P4-LOW last',
  '',
  '### Cross-Cloud Trace Correlation',
  '- Chronological timeline if trace IDs were found',
  '',
  '### Debugging Priority',
  '- Ranked list of what to investigate first',
  '',
  '### Team Routing',
  '- Which team owns each failing service, Slack channel, repository',
  '',
  '### Recommended Next Steps',
  '- What to check, what to monitor, configuration changes',
].join('\n');

// ============================================================================
// Node: analyzeLogs
// ============================================================================

async function analyzeLogsNode(
  state: LogAnalysisStateType,
): Promise<Partial<LogAnalysisStateType>> {
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
    // Tool call? → dispatch to toolbox router, accumulate, loop back
    // -----------------------------------------------------------------------
    if (
      choice.tool_calls &&
      choice.tool_calls.length > 0 &&
      state.toolCallCount < 15
    ) {
      const toolNames = choice.tool_calls.map(
        (t: Record<string, unknown>) => (t.function as Record<string, string>).name,
      );
      console.log(
        `[LogAnalyzer] Tool calls (turn ${state.toolCallCount + 1}): ${toolNames.join(', ')}`,
      );

      const assistantMsg = new AIMessage({ content: choice.content || '' });
      (assistantMsg as Record<string, unknown>).tool_calls = choice.tool_calls;

      const newMessages: BaseMessage[] = [assistantMsg];

      for (const tc of choice.tool_calls) {
        const args = JSON.parse(tc.function.arguments || '{}');

        // Route to the correct handler via the unified toolbox
        let result: string;
        if (toolboxInstance) {
          result = await toolboxInstance.executeTool(tc.function.name, args, state.logContent);
        } else {
          result = `Toolbox not initialized. Cannot execute tool: ${tc.function.name}`;
        }

        newMessages.push(
          new ToolMessage({
            content: result,
            tool_call_id: tc.id,
            name: tc.function.name,
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
    const analysisText = choice.content || 'No analysis generated';
    console.log(`[LogAnalyzer] Analysis complete: ${analysisText.length} chars`);

    return {
      analysisText,
      status: 'complete',
      messages: [new AIMessage(analysisText)],
    };
  } catch (err) {
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
