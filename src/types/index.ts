import type { WebhookEvent, MessageEvent, TextEventMessage } from '@line/bot-sdk';

// Re-export LINE types for convenience
export type { WebhookEvent, MessageEvent, TextEventMessage };

// Chat message stored in DynamoDB
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

// Chat history record in DynamoDB
export interface ChatHistory {
  userId: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  ttl: number; // DynamoDB TTL for auto-expiration
}

// OpenAI message format
export interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// Lambda API Gateway event (simplified)
export interface APIGatewayEvent {
  body: string | null;
  headers: Record<string, string | undefined>;
  httpMethod: string;
  path: string;
  queryStringParameters: Record<string, string | undefined> | null;
}

// Lambda API Gateway response
export interface APIGatewayResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

// Raw message stored in DynamoDB for auditing/analytics
export interface RawMessage {
  messageId: string;          // Unique message ID (webhookEventId or generated)
  userId: string;             // LINE user ID
  eventType: string;          // message, postback, follow, unfollow, etc.
  sourceType: string;         // user, group, room
  rawEvent: WebhookEvent;     // Complete raw LINE webhook event
  timestamp: number;          // Event timestamp from LINE
  receivedAt: number;         // When we received the event
  ttl: number;                // DynamoDB TTL for auto-expiration
}
