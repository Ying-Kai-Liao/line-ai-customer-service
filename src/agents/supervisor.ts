import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { config } from '../config';
import type { GraphStateType, AgentType } from './state';
import { getRAGKeywords } from '../services/rag.service';
import { trackAgentRouting } from '../services/analytics.service';
import { getPrompt } from '../services/prompt.service';
import { logLLMCall } from '../services/llm-observability.service';

const ROUTER_PROMPT = `You are a customer service router for CircleWe (圈圈), a mental health platform. Analyze the conversation and determine which agent should handle the user's latest message.

Available agents:
1. "main" - General customer service queries, FAQs, company information, mental health knowledge
2. "search_expert" - Finding therapists, booking appointments, expert recommendations. Use this when:
   - User wants to book/make appointment (預約, booking)
   - User is looking for a therapist (找心理師, 找專家)
   - User mentions a topic they need help with (人際關係, 焦慮, 憂鬱, etc.) in context of seeking professional help
   - User is responding to questions about their needs/preferences for expert matching
3. "notification" - ONLY for crisis situations (self-harm, suicide, severe distress)

IMPORTANT: Consider the conversation context!
- If previous messages indicate user is in a booking/expert-finding flow, continue routing to "search_expert"
- Short responses like "好", "可以", "都可以", topic names like "人際關係" are likely follow-ups to the previous flow
- Only route to "main" if the user is clearly asking a new, unrelated question

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

  // Build conversation context for better routing decisions
  const recentMessages = state.messages.slice(-6); // Last 3 exchanges
  let conversationContext = '';
  if (recentMessages.length > 0) {
    conversationContext = '\n\nRecent conversation:\n' + recentMessages.map(msg => {
      const role = msg._getType() === 'human' ? 'User' : 'Assistant';
      const content = typeof msg.content === 'string' ? msg.content : '';
      return `${role}: ${content.substring(0, 200)}`;
    }).join('\n');
  }

  // Get router prompt from DB (with fallback to hardcoded)
  const routerPrompt = await getPrompt('router').catch(() => ROUTER_PROMPT);
  const fullPrompt = routerPrompt + conversationContext;

  const startTime = Date.now();
  const inputMessages = [
    { role: 'system', content: fullPrompt },
    { role: 'user', content: `Current user message: ${state.userMessage}` },
  ];

  const response = await llm.invoke([
    new SystemMessage(fullPrompt),
    new HumanMessage(`Current user message: ${state.userMessage}`),
  ]);

  const content = typeof response.content === 'string'
    ? response.content.toLowerCase().trim()
    : '';

  // Log LLM call (non-blocking)
  const durationMs = Date.now() - startTime;
  setImmediate(() => {
    logLLMCall({
      user_id: state.userId,
      agent_type: 'router',
      model: config.llmProvider === 'anthropic' ? config.anthropic.model : config.openai.model,
      provider: config.llmProvider,
      system_prompt: fullPrompt,
      input_messages: inputMessages,
      output_content: content,
      prompt_tokens: (response as { usage_metadata?: { input_tokens?: number } }).usage_metadata?.input_tokens,
      completion_tokens: (response as { usage_metadata?: { output_tokens?: number } }).usage_metadata?.output_tokens,
      duration_ms: durationMs,
      status: 'success',
    }).catch(() => {});
  });

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
