import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { config } from '../../config';
import type { GraphStateType } from '../state';
import { getAvailableSlots } from '../../tools/expert-api';
import { createTimeSlotsFlexMessage } from '../../tools/line-flex';

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
  // If we have an expertId (from postback), fetch available slots
  if (state.expertId) {
    const slots = await getAvailableSlots(state.expertId);

    if (slots && slots.results.length > 0) {
      const flexMessage = createTimeSlotsFlexMessage(slots);
      return {
        response: `這是 ${slots.name} ${slots.title} 的可預約時段，點擊時段即可至官網預約喔！`,
        flexMessage,
        toolResults: { availableSlots: slots },
        messages: [
          new HumanMessage(state.userMessage),
          new AIMessage(`Showing available slots for expert ${state.expertId}`),
        ],
      };
    } else {
      return {
        response: '抱歉，目前這位專家沒有可預約的時段。請稍後再試或選擇其他專家。',
        messages: [
          new HumanMessage(state.userMessage),
          new AIMessage('No available slots found'),
        ],
      };
    }
  }

  // No expertId - use LLM to have a conversation about booking
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
