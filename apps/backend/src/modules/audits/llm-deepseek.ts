/**
 * llm-deepseek.ts — direct DeepSeek chat API client for the audits pipeline.
 *
 * This powers the additive `deepseek` audit engine (as opposed to `inline`
 * regex, `sdk` (Claude Agent SDK), and `sandbox` (CodeWhale). It calls
 * api.deepseek.com directly with a parameterized model/temperature/max_tokens,
 * and returns token usage so experiments can track cost.
 */

export interface DeepSeekChatParams {
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
}

export interface DeepSeekChatResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
}

export async function callDeepSeekChat(
  params: DeepSeekChatParams,
): Promise<DeepSeekChatResult> {
  const { apiKey, model, temperature, maxTokens, systemPrompt, userPrompt, signal } =
    params;

  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature,
      max_tokens: maxTokens,
    }),
    signal,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`DeepSeek API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0]?.message;
  if (!choice) throw new Error('No response from DeepSeek');

  return {
    content: choice.content ?? '',
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}

/** A single message in a tool-calling conversation. */
export interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: Array<Record<string, unknown>>;
  tool_call_id?: string;
}

export interface DeepSeekToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface DeepSeekWithToolsResult {
  content: string;
  toolCalls: DeepSeekToolCall[];
  promptTokens: number;
  completionTokens: number;
}

/**
 * Call DeepSeek with a full message array and a tool schema (function calling).
 * Non-streaming. Returns content + tool calls + token usage so the orchestrator
 * loop can account for every LLM call.
 */
export async function callDeepSeekWithTools(params: {
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  messages: DeepSeekMessage[];
  tools: Array<Record<string, unknown>>;
  signal?: AbortSignal;
}): Promise<DeepSeekWithToolsResult> {
  const { apiKey, model, temperature, maxTokens, messages, tools, signal } = params;

  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      temperature,
      max_tokens: maxTokens,
    }),
    signal,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('DeepSeek API error ' + response.status + ': ' + err);
  }

  const data = await response.json();
  const choice = data.choices?.[0]?.message;
  if (!choice) throw new Error('No response from DeepSeek');

  const raw = (choice.tool_calls ?? []) as Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
  const toolCalls: DeepSeekToolCall[] = raw.map((tc) => ({
    id: tc.id ?? '',
    name: tc.function?.name ?? '',
    arguments: tc.function?.arguments ?? '',
  }));

  return {
    content: choice.content ?? '',
    toolCalls,
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}
