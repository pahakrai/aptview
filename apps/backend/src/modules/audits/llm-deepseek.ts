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
}

export interface DeepSeekChatResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
}

export async function callDeepSeekChat(
  params: DeepSeekChatParams,
): Promise<DeepSeekChatResult> {
  const { apiKey, model, temperature, maxTokens, systemPrompt, userPrompt } =
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
