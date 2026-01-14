import { Annotation } from '@langchain/langgraph';
import { BaseMessage } from '@langchain/core/messages';
import type { FlexMessage } from '@line/bot-sdk';

// Agent types for routing
export type AgentType = 'main' | 'appointment' | 'search_expert' | 'notification' | 'knowledge';

// Graph state annotation for LangGraph
export const GraphState = Annotation.Root({
  // The user's original message
  userMessage: Annotation<string>,

  // LINE user ID for context
  userId: Annotation<string>,

  // Expert ID if this is a postback action
  expertId: Annotation<number>,

  // Conversation history as LangChain messages
  messages: Annotation<BaseMessage[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),

  // Which agent should handle this request
  currentAgent: Annotation<string>,

  // The final response to send back to the user
  response: Annotation<string>,

  // Optional flex message to send instead of text
  flexMessage: Annotation<FlexMessage>,

  // Whether we detected a crisis/urgent situation
  isCrisis: Annotation<boolean>,

  // Tool results from agent execution
  toolResults: Annotation<Record<string, unknown>>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),
});

// Type for the graph state
export type GraphStateType = typeof GraphState.State;
