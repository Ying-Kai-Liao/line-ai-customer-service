import { neon } from '@neondatabase/serverless';
import type { WebhookEvent } from '@line/bot-sdk';
import { config } from '../config';
import type { RawMessage } from '../types';

// In-memory store for local development
const localStore: RawMessage[] = [];
const isLocalMode = process.env.USE_LOCAL_STORAGE === 'true';

/**
 * Get Neon SQL client
 */
function getSql() {
  if (!config.neon.connectionString) {
    throw new Error('NEON_DATABASE_URL is required');
  }
  return neon(config.neon.connectionString);
}

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
 * Store a raw LINE webhook event in Neon
 */
export async function storeRawMessage(event: WebhookEvent): Promise<void> {
  const messageId = getMessageId(event);
  const userId = getUserIdFromEvent(event);

  const rawMessage: Omit<RawMessage, 'id' | 'created_at'> = {
    message_id: messageId,
    user_id: userId,
    event_type: event.type,
    source_type: event.source.type,
    raw_event: event,
    timestamp: event.timestamp,
    received_at: new Date().toISOString(),
  };

  if (isLocalMode) {
    localStore.push(rawMessage as RawMessage);
    console.log(`[RawMessage] Stored locally: ${messageId} for user ${userId}`);
    return;
  }

  try {
    const sql = getSql();
    await sql`
      INSERT INTO raw_messages (message_id, user_id, event_type, source_type, raw_event, timestamp, received_at)
      VALUES (${rawMessage.message_id}, ${rawMessage.user_id}, ${rawMessage.event_type}, ${rawMessage.source_type}, ${JSON.stringify(rawMessage.raw_event)}, ${rawMessage.timestamp}, ${rawMessage.received_at})
      ON CONFLICT (message_id) DO NOTHING
    `;

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
    let messages = localStore.filter((msg) => msg.user_id === userId);
    if (startTime) {
      messages = messages.filter((msg) => msg.timestamp >= startTime);
    }
    if (endTime) {
      messages = messages.filter((msg) => msg.timestamp <= endTime);
    }
    return messages.slice(0, limit);
  }

  try {
    const sql = getSql();
    let rows;

    if (startTime && endTime) {
      rows = await sql`
        SELECT * FROM raw_messages
        WHERE user_id = ${userId} AND timestamp >= ${startTime} AND timestamp <= ${endTime}
        ORDER BY timestamp DESC
        LIMIT ${limit}
      `;
    } else if (startTime) {
      rows = await sql`
        SELECT * FROM raw_messages
        WHERE user_id = ${userId} AND timestamp >= ${startTime}
        ORDER BY timestamp DESC
        LIMIT ${limit}
      `;
    } else if (endTime) {
      rows = await sql`
        SELECT * FROM raw_messages
        WHERE user_id = ${userId} AND timestamp <= ${endTime}
        ORDER BY timestamp DESC
        LIMIT ${limit}
      `;
    } else {
      rows = await sql`
        SELECT * FROM raw_messages
        WHERE user_id = ${userId}
        ORDER BY timestamp DESC
        LIMIT ${limit}
      `;
    }

    return rows as RawMessage[];
  } catch (error) {
    console.error('[RawMessage] Error querying raw messages:', error);
    return [];
  }
}

/**
 * Get all raw messages (for analytics/export)
 */
export async function getAllRawMessages(
  limit: number = 1000,
  offset: number = 0
): Promise<RawMessage[]> {
  if (isLocalMode) {
    return localStore.slice(offset, offset + limit);
  }

  try {
    const sql = getSql();
    const rows = await sql`
      SELECT * FROM raw_messages
      ORDER BY timestamp DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    return rows as RawMessage[];
  } catch (error) {
    console.error('[RawMessage] Error querying all raw messages:', error);
    return [];
  }
}
