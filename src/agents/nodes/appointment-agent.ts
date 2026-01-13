import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { config } from '../../config';
import type { GraphStateType } from '../state';

const APPOINTMENT_AGENT_PROMPT = `You are a helpful appointment booking assistant for CircleWe (圈圈), a mental health and wellness platform.

Your role is to:
1. Help users book appointments with mental health professionals
2. Check available time slots when asked
3. Guide users through the booking process
4. Answer questions about appointment policies (cancellation, rescheduling, etc.)

When helping with bookings:
- Ask which expert they'd like to book with (if not specified)
- Ask for their preferred date and time
- Confirm the booking details before finalizing

If you don't have access to real booking data, let the user know that a human agent will follow up to complete the booking.

Respond in the same language the user uses (Traditional Chinese or English).
Be warm, patient, and helpful throughout the process.`;

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

export async function appointmentAgentNode(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  const llm = getLLM();

  const messages = [
    new SystemMessage(APPOINTMENT_AGENT_PROMPT),
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
