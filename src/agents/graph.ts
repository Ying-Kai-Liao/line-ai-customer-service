import { StateGraph, END } from '@langchain/langgraph';
import { GraphState, type GraphStateType } from './state';
import { routerNode, routeToAgent } from './supervisor';
import {
  mainAgentNode,
  appointmentAgentNode,
  searchExpertAgentNode,
  notificationAgentNode,
} from './nodes';

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
    // Set entry point
    .addEdge('__start__', 'router')
    // Add conditional routing from router to agents
    .addConditionalEdges('router', routeToAgent, {
      main: 'main',
      appointment: 'appointment',
      search_expert: 'search_expert',
      notification: 'notification',
    })
    // All agents end after responding
    .addEdge('main', END)
    .addEdge('appointment', END)
    .addEdge('search_expert', END)
    .addEdge('notification', END);

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

// Main function to process a message through the graph
export async function processMessage(
  userMessage: string,
  userId: string,
  conversationHistory: { role: 'user' | 'assistant'; content: string }[] = []
): Promise<string> {
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
  };

  // Run the graph
  const result = await graph.invoke(initialState);

  return result.response || 'I apologize, but I was unable to process your request. Please try again.';
}
