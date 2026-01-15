import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { WebhookEvent } from '@line/bot-sdk';
import { config } from '../config';
import type { RawMessage } from '../types';

// In-memory store for local development
const localStore: RawMessage[] = [];
const isLocalMode = process.env.USE_LOCAL_STORAGE === 'true';

const client = new DynamoDBClient({ region: config.dynamodb.region });
const docClient = DynamoDBDocumentClient.from(client);

// TTL: 30 days in seconds (raw messages kept longer for audit/analytics)
const TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Generate a unique message ID from the webhook event
 */
function getMessageId(event: WebhookEvent): string {
  // Use webhookEventId if available (LINE SDK v3+)
  const webhookEventId = (event as { webhookEventId?: string }).webhookEventId;
  if (webhookEventId) {
    return webhookEventId;
  }

  // Fallback: generate from timestamp and replyToken
  const replyToken = (event as { replyToken?: string }).replyToken || 'no-token';
  return `${event.timestamp}-${replyToken.substring(0, 8)}`;
}

/**
 * Get user ID from webhook event source
 */
function getUserIdFromEvent(event: WebhookEvent): string {
  if (event.source.type === 'user') {
    return event.source.userId || 'unknown';
  }
  if (event.source.type === 'group') {
    return (event.source as { userId?: string }).userId || event.source.groupId || 'unknown';
  }
  if (event.source.type === 'room') {
    return (event.source as { userId?: string }).userId || event.source.roomId || 'unknown';
  }
  return 'unknown';
}

/**
 * Store a raw LINE webhook event
 */
export async function storeRawMessage(event: WebhookEvent): Promise<void> {
  const messageId = getMessageId(event);
  const userId = getUserIdFromEvent(event);
  const now = Date.now();

  const rawMessage: RawMessage = {
    messageId,
    userId,
    eventType: event.type,
    sourceType: event.source.type,
    rawEvent: event,
    timestamp: event.timestamp,
    receivedAt: now,
    ttl: Math.floor(now / 1000) + TTL_SECONDS,
  };

  if (isLocalMode) {
    localStore.push(rawMessage);
    console.log(`[RawMessage] Stored locally: ${messageId} for user ${userId}`);
    return;
  }

  try {
    await docClient.send(
      new PutCommand({
        TableName: config.dynamodb.rawMessagesTableName,
        Item: rawMessage,
      })
    );
    console.log(`[RawMessage] Stored: ${messageId} for user ${userId}`);
  } catch (error) {
    console.error('[RawMessage] Error storing raw message:', error);
    // Don't throw - raw message storage should not block message processing
  }
}

/**
 * Query raw messages for a user (by timestamp range)
 */
export async function getRawMessagesByUser(
  userId: string,
  startTime?: number,
  endTime?: number,
  limit: number = 100
): Promise<RawMessage[]> {
  if (isLocalMode) {
    let messages = localStore.filter((msg) => msg.userId === userId);
    if (startTime) {
      messages = messages.filter((msg) => msg.timestamp >= startTime);
    }
    if (endTime) {
      messages = messages.filter((msg) => msg.timestamp <= endTime);
    }
    return messages.slice(0, limit);
  }

  try {
    const params: {
      TableName: string;
      IndexName: string;
      KeyConditionExpression: string;
      ExpressionAttributeValues: Record<string, string | number>;
      Limit: number;
      ScanIndexForward: boolean;
    } = {
      TableName: config.dynamodb.rawMessagesTableName,
      IndexName: 'timestamp-index',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId,
      },
      Limit: limit,
      ScanIndexForward: false, // Most recent first
    };

    // Add time range conditions if provided
    if (startTime && endTime) {
      params.KeyConditionExpression += ' AND #ts BETWEEN :startTime AND :endTime';
      params.ExpressionAttributeValues[':startTime'] = startTime;
      params.ExpressionAttributeValues[':endTime'] = endTime;
    } else if (startTime) {
      params.KeyConditionExpression += ' AND #ts >= :startTime';
      params.ExpressionAttributeValues[':startTime'] = startTime;
    } else if (endTime) {
      params.KeyConditionExpression += ' AND #ts <= :endTime';
      params.ExpressionAttributeValues[':endTime'] = endTime;
    }

    const result = await docClient.send(
      new QueryCommand({
        ...params,
        ExpressionAttributeNames: startTime || endTime ? { '#ts': 'timestamp' } : undefined,
      })
    );

    return (result.Items || []) as RawMessage[];
  } catch (error) {
    console.error('[RawMessage] Error querying raw messages:', error);
    return [];
  }
}
