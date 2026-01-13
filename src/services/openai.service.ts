import OpenAI from 'openai';
import { config } from '../config';
import type { ChatMessage, OpenAIMessage } from '../types';

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

// System prompt for customer service persona
const SYSTEM_PROMPT = `You are a helpful, friendly, and professional customer service assistant. Your role is to:

1. Answer customer questions clearly and concisely
2. Help resolve issues and provide solutions
3. Be polite and empathetic in all interactions
4. If you don't know something, be honest and offer to help find the answer
5. Keep responses concise and suitable for a chat interface (avoid very long responses)

Always maintain a professional yet friendly tone. If a customer seems frustrated, acknowledge their feelings before addressing their issue.`;

/**
 * Converts chat history to OpenAI message format
 */
function formatMessagesForOpenAI(messages: ChatMessage[]): OpenAIMessage[] {
  return messages.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));
}

/**
 * Generates a response using OpenAI GPT
 */
export async function generateResponse(
  userMessage: string,
  chatHistory: ChatMessage[]
): Promise<string> {
  // Build messages array with system prompt, history, and new message
  const messages: OpenAIMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...formatMessagesForOpenAI(chatHistory),
    { role: 'user', content: userMessage },
  ];

  try {
    const completion = await openai.chat.completions.create({
      model: config.openai.model,
      messages,
      max_tokens: 500,
      temperature: 0.7,
    });

    const response = completion.choices[0]?.message?.content;

    if (!response) {
      throw new Error('No response from OpenAI');
    }

    return response.trim();
  } catch (error) {
    console.error('Error generating OpenAI response:', error);
    throw error;
  }
}

/**
 * Creates a ChatMessage object
 */
export function createChatMessage(
  role: 'user' | 'assistant',
  content: string
): ChatMessage {
  return {
    role,
    content,
    timestamp: Date.now(),
  };
}
