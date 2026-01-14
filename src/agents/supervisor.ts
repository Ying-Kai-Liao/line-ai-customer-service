import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { config } from '../config';
import type { GraphStateType, AgentType } from './state';

const ROUTER_PROMPT = `You are a customer service router. Analyze the user's message and determine which specialized agent should handle it.

Available agents:
1. "main" - General customer service queries, FAQs, company information, mental health knowledge
2. "appointment" - Booking appointments, scheduling, checking available times with experts
3. "search_expert" - Finding experts, searching for professionals, getting expert recommendations
4. "notification" - ONLY for crisis situations (self-harm, suicide, severe distress) that require immediate human attention

IMPORTANT: Only route to "notification" if the user expresses:
- Suicidal thoughts or self-harm intentions
- Severe mental health crisis
- Immediate danger to self or others

Respond with ONLY the agent name: "main", "appointment", "search_expert", or "notification"`;

function getLLM() {
  if (config.llmProvider === 'anthropic') {
    return new ChatAnthropic({
      apiKey: config.anthropic.apiKey,
      model: config.anthropic.model,
      maxTokens: 50,
    });
  }
  return new ChatOpenAI({
    apiKey: config.openai.apiKey,
    model: config.openai.model,
    maxTokens: 50,
  });
}

export async function routerNode(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  // If expertId is present, this is a postback for booking - route directly to appointment
  if (state.expertId) {
    console.log(`Router: Direct routing to appointment for expertId: ${state.expertId}`);
    return {
      currentAgent: 'appointment' as AgentType,
      isCrisis: false,
    };
  }

  const llm = getLLM();

  const response = await llm.invoke([
    new SystemMessage(ROUTER_PROMPT),
    new HumanMessage(state.userMessage),
  ]);

  const content = typeof response.content === 'string'
    ? response.content.toLowerCase().trim()
    : '';

  // Parse the agent type from response
  let currentAgent: AgentType = 'main';
  let isCrisis = false;

  if (content.includes('appointment')) {
    currentAgent = 'appointment';
  } else if (content.includes('search_expert')) {
    currentAgent = 'search_expert';
  } else if (content.includes('notification')) {
    currentAgent = 'notification';
    isCrisis = true;
  }

  console.log(`Router decision: ${currentAgent} for message: "${state.userMessage.substring(0, 50)}..."`);

  return {
    currentAgent,
    isCrisis,
  };
}

// Conditional edge function for routing to the correct agent
export function routeToAgent(state: GraphStateType): string {
  return state.currentAgent;
}
