import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { config } from '../../config';
import type { GraphStateType } from '../state';
import { getPrompt } from '../../services/prompt.service';
import { logLLMCall } from '../../services/llm-observability.service';
import { createHandoffPromptFlexMessage } from '../../tools/line-flex';

// Marker that the LLM can include when it feels it cannot adequately help
const NEEDS_HUMAN_MARKER = '[NEEDS_HUMAN]';

// Phrases that indicate AI uncertainty or inability to help
const UNCERTAINTY_PHRASES = [
  '無法幫助', '無法協助', '建議聯繫客服', '建議您聯繫', '需要人工協助',
  '超出我的能力', '無法處理', '這個問題我無法', '抱歉我無法',
  "i can't help", "i cannot help", "i'm unable to", "beyond my capabilities",
  "contact customer service", "contact support", "speak to a human",
];

const DEFAULT_MAIN_AGENT_PROMPT = `You are a helpful, friendly, and professional customer service assistant for CircleWe (圈圈), a mental health and wellness platform.

Your role is to:
1. Answer customer questions clearly and concisely
2. Provide information about mental health topics with empathy
3. Help users understand the services and experts available
4. Be polite and supportive in all interactions
5. Keep responses concise and suitable for a chat interface

If someone asks about booking an appointment or finding an expert, let them know you can help with that.

Always maintain a warm, professional tone. If a user seems distressed, acknowledge their feelings with empathy.

IMPORTANT: If you feel you cannot adequately help the user with their request (e.g., account issues, complaints, refunds, technical problems, or complex situations that need human judgment), include the marker [NEEDS_HUMAN] at the END of your response. This will offer the user the option to speak with a human agent.

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

  // Check if AI indicates it needs human help
  const contentLower = content.toLowerCase();
  const hasMarker = content.includes(NEEDS_HUMAN_MARKER);
  const hasUncertaintyPhrase = UNCERTAINTY_PHRASES.some(phrase =>
    contentLower.includes(phrase.toLowerCase())
  );

  // Remove the marker from the response if present
  const cleanedContent = content.replace(NEEDS_HUMAN_MARKER, '').trim();

  // If AI indicates it can't help, add the handoff flex message
  if (hasMarker || hasUncertaintyPhrase) {
    console.log(`[MainAgent] AI indicated uncertainty, adding handoff prompt for user ${state.userId}`);
    const handoffFlex = createHandoffPromptFlexMessage(
      '看起來這個問題可能需要專人為您處理。需要我幫您轉接真人客服嗎？'
    );

    return {
      response: cleanedContent,
      flexMessage: handoffFlex,
      messages: [
        new HumanMessage(state.userMessage),
        new AIMessage(cleanedContent),
      ],
    };
  }

  return {
    response: cleanedContent,
    messages: [
      new HumanMessage(state.userMessage),
      new AIMessage(cleanedContent),
    ],
  };
}
