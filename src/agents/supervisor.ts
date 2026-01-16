import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { config } from '../config';
import type { GraphStateType, AgentType } from './state';
import { hasRAGKeywords, getRAGKeywords } from '../services/rag.service';
import { trackAgentRouting } from '../services/analytics.service';

const ROUTER_PROMPT = `You are a customer service router. Analyze the user's message and determine which specialized agent should handle it.

Available agents:
1. "main" - General customer service queries, FAQs, company information, mental health knowledge
2. "search_expert" - Use this when user wants to book, make appointment, find therapist, or needs expert recommendations. This shows available experts.
3. "notification" - ONLY for crisis situations (self-harm, suicide, severe distress) that require immediate human attention

IMPORTANT routing rules:
- "我想預約", "預約", "booking", "找心理師", "推薦專家" → route to "search_expert"
- Only route to "notification" if user expresses suicidal thoughts, self-harm, or severe crisis
- General questions about the service → route to "main"

Respond with ONLY the agent name: "main", "search_expert", or "notification"`;

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
  let currentAgent: AgentType = 'main';
  let isCrisis = false;
  let routingReason: 'keyword' | 'llm_decision' | 'postback' = 'llm_decision';
  let keywordsMatched: string[] = [];

  // If expertId is present, this is a postback for booking - route directly to appointment
  if (state.expertId) {
    console.log(`Router: Direct routing to appointment for expertId: ${state.expertId}`);
    currentAgent = 'appointment';
    routingReason = 'postback';

    // Track routing decision (non-blocking)
    trackAgentRouting({
      user_message: state.userMessage,
      routed_to: currentAgent,
      routing_reason: routingReason,
      keywords_matched: [`expertId:${state.expertId}`],
    }).catch(() => {});

    return {
      currentAgent,
      isCrisis: false,
      routingReason,
      keywordsMatched: [`expertId:${state.expertId}`],
    };
  }

  // Check for RAG keywords - route to knowledge agent for document retrieval
  const ragKeywords = getRAGKeywords(state.userMessage);
  if (ragKeywords.length > 0) {
    console.log(`Router: RAG keyword detected, routing to knowledge agent for: "${state.userMessage.substring(0, 50)}..."`);
    currentAgent = 'knowledge';
    routingReason = 'keyword';
    keywordsMatched = ragKeywords;

    // Track routing decision (non-blocking)
    trackAgentRouting({
      user_message: state.userMessage,
      routed_to: currentAgent,
      routing_reason: routingReason,
      keywords_matched: keywordsMatched,
    }).catch(() => {});

    return {
      currentAgent,
      isCrisis: false,
      routingReason,
      keywordsMatched,
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
  // Route to search_expert for booking/appointment queries (shows expert carousel)
  // Appointment agent is only used when user clicks on expert card (has expertId)
  if (content.includes('search_expert') || content.includes('appointment')) {
    currentAgent = 'search_expert';
  } else if (content.includes('notification')) {
    currentAgent = 'notification';
    isCrisis = true;
  }

  console.log(`Router decision: ${currentAgent} for message: "${state.userMessage.substring(0, 50)}..."`);

  // Track routing decision (non-blocking)
  trackAgentRouting({
    user_message: state.userMessage,
    routed_to: currentAgent,
    routing_reason: routingReason,
  }).catch(() => {});

  return {
    currentAgent,
    isCrisis,
    routingReason,
  };
}

// Conditional edge function for routing to the correct agent
export function routeToAgent(state: GraphStateType): string {
  return state.currentAgent;
}
