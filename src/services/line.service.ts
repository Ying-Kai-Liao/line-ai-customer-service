import {
  Client,
  WebhookEvent,
  TextMessage,
  validateSignature,
} from '@line/bot-sdk';
import { config } from '../config';

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
 * Sends a text reply to a LINE user
 */
export async function replyMessage(
  replyToken: string,
  text: string
): Promise<void> {
  const message: TextMessage = {
    type: 'text',
    text,
  };

  try {
    await lineClient.replyMessage(replyToken, message);
  } catch (error) {
    console.error('Error sending reply:', error);
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
