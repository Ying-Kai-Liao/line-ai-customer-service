import {
  Client,
  WebhookEvent,
  TextMessage,
  FlexMessage,
  Message,
  validateSignature,
} from '@line/bot-sdk';
import { config } from '../config';
import { AI_SENDER, DEFAULT_QUICK_REPLY } from '../tools/line-flex';

// LINE client for sending messages
const lineClient = new Client({
  channelAccessToken: config.line.channelAccessToken,
  channelSecret: config.line.channelSecret,
});

/**
 * Validates the LINE webhook signature
 */
export function validateWebhookSignature(
  body: string,
  signature: string | undefined
): boolean {
  if (!signature) {
    return false;
  }

  return validateSignature(body, config.line.channelSecret, signature);
}

/**
 * Parses webhook body into LINE events
 */
export function parseWebhookEvents(body: string): WebhookEvent[] {
  try {
    const parsed = JSON.parse(body);
    return parsed.events || [];
  } catch (error) {
    console.error('Error parsing webhook body:', error);
    return [];
  }
}

/**
 * Show loading indicator while processing
 */
export async function showLoadingIndicator(userId: string): Promise<void> {
  console.log(`[LINE] Showing loading indicator for user: ${userId}`);
  try {
    const response = await fetch('https://api.line.me/v2/bot/chat/loading/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.line.channelAccessToken}`,
      },
      body: JSON.stringify({
        chatId: userId,
        loadingSeconds: 30,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[LINE] Loading indicator failed: ${response.status} - ${errorText}`);
    } else {
      console.log('[LINE] Loading indicator started successfully');
    }
  } catch (error) {
    console.error('[LINE] Error showing loading indicator:', error);
    // Non-critical, don't throw
  }
}

/**
 * Sends a text reply with AI sender styling
 */
export async function replyMessage(
  replyToken: string,
  text: string
): Promise<void> {
  const message: TextMessage = {
    type: 'text',
    text,
    sender: AI_SENDER,
    quickReply: DEFAULT_QUICK_REPLY,
  };

  try {
    await lineClient.replyMessage(replyToken, message);
  } catch (error) {
    console.error('Error sending reply:', error);
    throw error;
  }
}

/**
 * Sends a flex message reply
 */
export async function replyFlexMessage(
  replyToken: string,
  flexMessage: FlexMessage
): Promise<void> {
  try {
    await lineClient.replyMessage(replyToken, flexMessage);
  } catch (error) {
    console.error('Error sending flex reply:', error);
    throw error;
  }
}

/**
 * Sends multiple messages in one reply
 */
export async function replyMessages(
  replyToken: string,
  messages: Message[]
): Promise<void> {
  try {
    await lineClient.replyMessage(replyToken, messages);
  } catch (error) {
    console.error('Error sending messages:', error);
    throw error;
  }
}

/**
 * Extracts text content from a message event
 * Returns null if not a text message
 */
export function extractTextContent(event: WebhookEvent): string | null {
  if (event.type !== 'message') {
    return null;
  }

  if (event.message.type !== 'text') {
    return null;
  }

  return event.message.text;
}

/**
 * Extracts postback data from an event
 * Returns null if not a postback event
 */
export function extractPostbackData(event: WebhookEvent): string | null {
  if (event.type !== 'postback') {
    return null;
  }

  return event.postback.data;
}

/**
 * Parse postback data into key-value pairs
 * e.g., "expertId=123&action=book" => { expertId: "123", action: "book" }
 */
export function parsePostbackData(data: string): Record<string, string> {
  const params: Record<string, string> = {};
  const pairs = data.split('&');
  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    if (key && value !== undefined) {
      params[key] = value;
    }
  }
  return params;
}

/**
 * Gets the user ID from an event
 */
export function getUserId(event: WebhookEvent): string | null {
  if (event.source.type === 'user') {
    return event.source.userId;
  }
  return null;
}

/**
 * Gets the reply token from an event
 */
export function getReplyToken(event: WebhookEvent): string | null {
  if ('replyToken' in event) {
    return event.replyToken;
  }
  return null;
}

/**
 * Check if event is a postback event
 */
export function isPostbackEvent(event: WebhookEvent): boolean {
  return event.type === 'postback';
}

/**
 * Check if event is a message event
 */
export function isMessageEvent(event: WebhookEvent): boolean {
  return event.type === 'message';
}
