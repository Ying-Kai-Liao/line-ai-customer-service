import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { config } from '../../config';
import type { GraphStateType } from '../state';
import { getPrompt } from '../../services/prompt.service';
import { logLLMCall } from '../../services/llm-observability.service';

const DEFAULT_MAIN_AGENT_PROMPT = `You are a helpful, friendly, and professional customer service assistant for CircleWe (圈圈), a mental health and wellness platform.

Your role is to:
1. Answer customer questions clearly and concisely
2. Provide information about mental health topics with empathy
3. Help users understand the services and experts available
4. Be polite and supportive in all interactions
5. Keep responses concise and suitable for a chat interface

If someone asks about booking an appointment or finding an expert, let them know you can help with that.

Always maintain a warm, professional tone. If a user seems distressed, acknowledge their feelings with empathy.

Respond in the same language the user uses (Traditional Chinese or English).`;

function getLLM() {
  if (config.llmProvider === 'anthropic') {
    return new ChatAnthropic({
      apiKey: config.anthropic.apiKey,
      model: config.anthropic.model,
      maxTokens: 500,
    });
  }
  // gpt-5 models require max_completion_tokens - omit token limit and let API use defaults
  const isGpt5 = config.openai.model.startsWith('gpt-5');
  if (isGpt5) {
    return new ChatOpenAI({
      apiKey: config.openai.apiKey,
      model: config.openai.model,
    });
  }
  return new ChatOpenAI({
    apiKey: config.openai.apiKey,
    model: config.openai.model,
    maxTokens: 500,
  });
}

export async function mainAgentNode(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  const llm = getLLM();

  // Get prompt from DB (with fallback to default)
  const systemPrompt = await getPrompt('main_agent').catch(() => DEFAULT_MAIN_AGENT_PROMPT);

  // Build messages with conversation history
  const messages = [
    new SystemMessage(systemPrompt),
    ...state.messages,
    new HumanMessage(state.userMessage),
  ];

  // Track input messages for logging
  const inputMessages = [
    { role: 'system', content: systemPrompt },
    ...state.messages.map(m => ({
      role: m._getType() === 'human' ? 'user' : 'assistant',
      content: typeof m.content === 'string' ? m.content : '',
    })),
    { role: 'user', content: state.userMessage },
  ];

  const startTime = Date.now();
  const response = await llm.invoke(messages);
  const durationMs = Date.now() - startTime;

  // Handle both string and array content formats (gpt-5 models may return array)
  let content = '';
  if (typeof response.content === 'string') {
    content = response.content;
  } else if (Array.isArray(response.content)) {
    content = response.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map(part => part.text)
      .join('');
  }
  console.log(`[MainAgent] Response content type: ${typeof response.content}, isArray: ${Array.isArray(response.content)}, content length: ${content.length}`);

  // Log LLM call (non-blocking)
  setImmediate(() => {
    logLLMCall({
      user_id: state.userId,
      agent_type: 'main',
      model: config.llmProvider === 'anthropic' ? config.anthropic.model : config.openai.model,
      provider: config.llmProvider,
      system_prompt: systemPrompt,
      input_messages: inputMessages,
      output_content: content,
      prompt_tokens: (response as { usage_metadata?: { input_tokens?: number } }).usage_metadata?.input_tokens,
      completion_tokens: (response as { usage_metadata?: { output_tokens?: number } }).usage_metadata?.output_tokens,
      duration_ms: durationMs,
      status: 'success',
    }).catch(() => {});
  });

  return {
    response: content,
    messages: [
      new HumanMessage(state.userMessage),
      new AIMessage(content),
    ],
  };
}
