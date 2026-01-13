import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { config } from '../../config';
import type { GraphStateType } from '../state';

const SEARCH_EXPERT_PROMPT = `You are a helpful expert search assistant for CircleWe (圈圈), a mental health and wellness platform.

Your role is to:
1. Help users find the right mental health professional for their needs
2. Ask clarifying questions about what kind of support they're looking for
3. Explain the different types of professionals available (therapists, counselors, coaches, etc.)
4. Provide guidance on choosing the right expert based on their concerns

Types of concerns you can help match:
- Anxiety and stress management
- Depression and mood disorders
- Relationship issues
- Career and life transitions
- Self-esteem and personal growth
- Trauma and PTSD
- Family dynamics
- And more...

Ask about:
- What specific concerns they'd like help with
- Their preferences (language, gender of therapist, etc.)
- Whether they've seen a professional before

Respond in the same language the user uses (Traditional Chinese or English).
Be empathetic and non-judgmental when discussing their needs.`;

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

export async function searchExpertAgentNode(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  const llm = getLLM();

  const messages = [
    new SystemMessage(SEARCH_EXPERT_PROMPT),
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
