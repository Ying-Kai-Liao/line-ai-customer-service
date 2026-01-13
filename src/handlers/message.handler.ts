import type { WebhookEvent } from '@line/bot-sdk';
import {
  extractTextContent,
  getUserId,
  getReplyToken,
  replyMessage,
} from '../services/line.service';
import { getChatHistory, addMessageToHistory } from '../services/dynamo.service';
import { generateResponse, createChatMessage } from '../services/openai.service';

const FALLBACK_MESSAGE =
  'Sorry, I encountered an issue processing your message. Please try again.';
const NON_TEXT_MESSAGE =
  'I can only respond to text messages at the moment. Please send me a text message.';

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

    // Generate AI response
    const aiResponse = await generateResponse(textContent, chatHistory);

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
