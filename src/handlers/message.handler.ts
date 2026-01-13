import type { WebhookEvent } from '@line/bot-sdk';
import {
  extractTextContent,
  getUserId,
  getReplyToken,
  replyMessage,
} from '../services/line.service';
import { getChatHistory, addMessageToHistory } from '../services/dynamo.service';
import { processMessage } from '../agents/graph';
import type { ChatMessage } from '../types';

const FALLBACK_MESSAGE =
  'Sorry, I encountered an issue processing your message. Please try again.';
const NON_TEXT_MESSAGE =
  'I can only respond to text messages at the moment. Please send me a text message.';

// Helper to create a chat message
function createChatMessage(
  role: 'user' | 'assistant',
  content: string
): ChatMessage {
  return {
    role,
    content,
    timestamp: Date.now(),
  };
}

/**
 * Handles a single LINE webhook event
 */
export async function handleEvent(event: WebhookEvent): Promise<void> {
  // Only handle message events
  if (event.type !== 'message') {
    console.log(`Skipping non-message event: ${event.type}`);
    return;
  }

  const replyToken = getReplyToken(event);
  if (!replyToken) {
    console.log('No reply token found');
    return;
  }

  const userId = getUserId(event);
  if (!userId) {
    console.log('No user ID found');
    await replyMessage(replyToken, FALLBACK_MESSAGE);
    return;
  }

  // Extract text content
  const textContent = extractTextContent(event);
  if (!textContent) {
    await replyMessage(replyToken, NON_TEXT_MESSAGE);
    return;
  }

  try {
    // Get chat history for context
    const chatHistory = await getChatHistory(userId);

    // Convert chat history to format expected by LangGraph
    const conversationHistory = chatHistory.map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    }));

    // Process message through LangGraph multi-agent system
    const aiResponse = await processMessage(
      textContent,
      userId,
      conversationHistory
    );

    // Save user message to history
    const userMessage = createChatMessage('user', textContent);
    await addMessageToHistory(userId, userMessage);

    // Save AI response to history
    const assistantMessage = createChatMessage('assistant', aiResponse);
    await addMessageToHistory(userId, assistantMessage);

    // Send reply to user
    await replyMessage(replyToken, aiResponse);

    console.log(`Processed message for user ${userId}`);
  } catch (error) {
    console.error('Error handling message:', error);
    await replyMessage(replyToken, FALLBACK_MESSAGE);
  }
}

/**
 * Handles multiple LINE webhook events
 */
export async function handleEvents(events: WebhookEvent[]): Promise<void> {
  // Process events concurrently
  await Promise.all(events.map(handleEvent));
}
