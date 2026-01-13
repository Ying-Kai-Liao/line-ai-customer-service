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
