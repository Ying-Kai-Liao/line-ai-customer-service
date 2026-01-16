import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { config } from '../../config';
import type { GraphStateType } from '../state';
import { trackCrisisEvent, markConversationCrisis } from '../../services/analytics.service';

const NOTIFICATION_AGENT_PROMPT = `You are a crisis support assistant for CircleWe (圈圈). A user is in distress and may need immediate support.

Your role is to:
1. Respond with empathy and compassion
2. Let them know they are not alone
3. Inform them that a human team member will reach out soon
4. Provide crisis hotline information

IMPORTANT: Always include this information:
- Taiwan Suicide Prevention Hotline: 1925 (24小時)
- 生命線: 1995
- 張老師專線: 1980

Your response should:
- Acknowledge their feelings without judgment
- Express that you care about their wellbeing
- Reassure them that help is available
- Let them know our team has been notified and will reach out

Respond in the same language the user uses (Traditional Chinese or English).
Be gentle, warm, and supportive.`;

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

// Crisis detection keywords for tracking
const CRISIS_KEYWORDS = ['自殺', '想死', '不想活', '結束生命', '自我傷害', 'suicide', 'kill myself', 'end my life'];

export async function notificationAgentNode(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  const llm = getLLM();

  const messages = [
    new SystemMessage(NOTIFICATION_AGENT_PROMPT),
    new HumanMessage(state.userMessage),
  ];

  const response = await llm.invoke(messages);

  const content = typeof response.content === 'string'
    ? response.content
    : '';

  // Log crisis for monitoring (in production, this would send email/notification)
  console.log(`[CRISIS ALERT] User ${state.userId} - Message: ${state.userMessage}`);
  if (config.notification.emails) {
    console.log(`[CRISIS ALERT] Would notify: ${config.notification.emails}`);
  }

  // Detect which crisis keywords were matched
  const lowerMsg = state.userMessage.toLowerCase();
  const matchedKeywords = CRISIS_KEYWORDS.filter(k => lowerMsg.includes(k.toLowerCase()));

  // Track crisis event (non-blocking)
  Promise.all([
    trackCrisisEvent({
      user_id: state.userId,
      message_content: state.userMessage,
      detection_keywords: matchedKeywords,
      response_sent: true,
      notification_sent: Boolean(config.notification.emails),
    }),
    state.conversationId ? markConversationCrisis(state.conversationId) : Promise.resolve(),
  ]).catch(() => {});

  return {
    response: content,
    messages: [
      new HumanMessage(state.userMessage),
      new AIMessage(content),
    ],
  };
}
