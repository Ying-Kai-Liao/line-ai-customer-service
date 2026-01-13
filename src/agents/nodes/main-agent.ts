import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { config } from '../../config';
import type { GraphStateType } from '../state';

const MAIN_AGENT_PROMPT = `You are a helpful, friendly, and professional customer service assistant for CircleWe (圈圈), a mental health and wellness platform.

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

  // Build messages with conversation history
  const messages = [
    new SystemMessage(MAIN_AGENT_PROMPT),
    ...state.messages,
    new HumanMessage(state.userMessage),
  ];

  const response = await llm.invoke(messages);

  const content = typeof response.content === 'string'
    ? response.content
    : '';

  return {
    response: content,
    messages: [
      new HumanMessage(state.userMessage),
      new AIMessage(content),
    ],
  };
}
