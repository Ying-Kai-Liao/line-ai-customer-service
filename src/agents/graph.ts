import { StateGraph, END } from '@langchain/langgraph';
import { GraphState, type GraphStateType } from './state';
import { routerNode, routeToAgent } from './supervisor';
import {
  mainAgentNode,
  appointmentAgentNode,
  searchExpertAgentNode,
  notificationAgentNode,
  knowledgeAgentNode,
} from './nodes';
import {
  getOrCreateConversation,
  trackMessage,
  updateConversationAgent,
} from '../services/analytics.service';

// Build the customer service agent graph
function buildGraph() {
  const workflow = new StateGraph(GraphState)
    // Add the router node
    .addNode('router', routerNode)
    // Add agent nodes
    .addNode('main', mainAgentNode)
    .addNode('appointment', appointmentAgentNode)
    .addNode('search_expert', searchExpertAgentNode)
    .addNode('notification', notificationAgentNode)
    .addNode('knowledge', knowledgeAgentNode)
    // Set entry point
    .addEdge('__start__', 'router')
    // Add conditional routing from router to agents
    .addConditionalEdges('router', routeToAgent, {
      main: 'main',
      appointment: 'appointment',
      search_expert: 'search_expert',
      notification: 'notification',
      knowledge: 'knowledge',
    })
    // All agents end after responding
    .addEdge('main', END)
    .addEdge('appointment', END)
    .addEdge('search_expert', END)
    .addEdge('notification', END)
    .addEdge('knowledge', END);

  return workflow.compile();
}

// Compiled graph instance
let compiledGraph: ReturnType<typeof buildGraph> | null = null;

// Get or create the compiled graph (singleton)
export function getGraph() {
  if (!compiledGraph) {
    compiledGraph = buildGraph();
  }
  return compiledGraph;
}

import type { FlexMessage } from '@line/bot-sdk';
import type { AgentType } from './state';

// Response type from processMessage
export interface ProcessMessageResult {
  response: string;
  flexMessage?: FlexMessage;
  currentAgent?: AgentType;
}

// Main function to process a message through the graph
export async function processMessage(
  userMessage: string,
  userId: string,
  conversationHistory: { role: 'user' | 'assistant'; content: string }[] = [],
  expertId?: number
): Promise<ProcessMessageResult> {
  const startTime = Date.now();
  const graph = getGraph();

  // Convert conversation history to LangChain messages
  const { HumanMessage, AIMessage } = await import('@langchain/core/messages');
  const messages = conversationHistory.map((msg) =>
    msg.role === 'user'
      ? new HumanMessage(msg.content)
      : new AIMessage(msg.content)
  );

  // Initial state
  const initialState: Partial<GraphStateType> = {
    userMessage,
    userId,
    messages,
    expertId,
    startTime,
  };

  // Run the graph
  const result = await graph.invoke(initialState);

  const responseTime = Date.now() - startTime;

  // Track analytics completely in background (fire-and-forget)
  // Don't let analytics affect the main response flow
  setImmediate(async () => {
    try {
      const conversationId = await getOrCreateConversation(userId).catch(() => null);

      await Promise.all([
        trackMessage({
          conversation_id: conversationId || undefined,
          user_id: userId,
          role: 'user',
          content: userMessage,
          message_type: 'text',
          timestamp: startTime,
        }),
        trackMessage({
          conversation_id: conversationId || undefined,
          user_id: userId,
          role: 'assistant',
          content: result.response || '',
          message_type: result.flexMessage ? 'flex' : 'text',
          agent_type: result.currentAgent,
          response_time_ms: responseTime,
          timestamp: Date.now(),
        }),
        conversationId && result.currentAgent
          ? updateConversationAgent(conversationId, result.currentAgent)
          : Promise.resolve(),
      ]);
    } catch (error) {
      console.error('[Analytics] Error tracking message:', error);
    }
  });

  return {
    response: result.response || 'I apologize, but I was unable to process your request. Please try again.',
    flexMessage: result.flexMessage,
    currentAgent: result.currentAgent as AgentType,
  };
}
