import { neon } from '@neondatabase/serverless';
import type { WebhookEvent } from '@line/bot-sdk';
import { config } from '../config';
import type { RawMessage } from '../types';

// In-memory store for local development
const localStore: RawMessage[] = [];
const isLocalMode = process.env.USE_LOCAL_STORAGE === 'true';

// Circuit breaker state - skip DB operations if too many failures
let consecutiveFailures = 0;
let circuitOpenUntil = 0;
const MAX_FAILURES = 3;
const CIRCUIT_RESET_MS = 60 * 1000; // 1 minute

/**
 * Check if Neon is properly configured
 */
function isNeonConfigured(): boolean {
  return Boolean(config.neon.connectionString);
}

/**
 * Check if circuit breaker is open (should skip DB operations)
 */
function isCircuitOpen(): boolean {
  if (Date.now() < circuitOpenUntil) {
    return true;
  }
  // Reset circuit if timeout passed
  if (circuitOpenUntil > 0 && Date.now() >= circuitOpenUntil) {
    circuitOpenUntil = 0;
    consecutiveFailures = 0;
  }
  return false;
}

/**
 * Record a failure and potentially open circuit
 */
function recordFailure(): void {
  consecutiveFailures++;
  if (consecutiveFailures >= MAX_FAILURES) {
    circuitOpenUntil = Date.now() + CIRCUIT_RESET_MS;
    console.warn(`[RawMessage] Circuit breaker opened - skipping DB for ${CIRCUIT_RESET_MS / 1000}s`);
  }
}

/**
 * Record a success and reset failure count
 */
function recordSuccess(): void {
  consecutiveFailures = 0;
}

/**
 * Wrap a promise with a timeout
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Operation timed out')), ms)
  );
  return Promise.race([promise, timeout]);
}

/**
 * Get Neon SQL client (only if configured)
 */
function getSql() {
  if (!isNeonConfigured()) {
    return null;
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
 * This is non-blocking and will not affect the main message flow
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

  // Local mode: store in memory
  if (isLocalMode) {
    localStore.push(rawMessage as RawMessage);
    console.log(`[RawMessage] Stored locally: ${messageId} for user ${userId}`);
    return;
  }

  // Check if Neon is configured
  if (!isNeonConfigured()) {
    console.log('[RawMessage] Neon not configured, skipping storage');
    return;
  }

  // Check circuit breaker
  if (isCircuitOpen()) {
    console.log('[RawMessage] Circuit breaker open, skipping storage');
    return;
  }

  try {
    const sql = getSql();
    if (!sql) return;

    // Use timeout to prevent long waits (3 seconds max)
    await withTimeout(
      sql`
        INSERT INTO raw_messages (message_id, user_id, event_type, source_type, raw_event, timestamp, received_at)
        VALUES (${rawMessage.message_id}, ${rawMessage.user_id}, ${rawMessage.event_type}, ${rawMessage.source_type}, ${JSON.stringify(rawMessage.raw_event)}, ${rawMessage.timestamp}, ${rawMessage.received_at})
        ON CONFLICT (message_id) DO NOTHING
      `,
      3000
    );

    recordSuccess();
    console.log(`[RawMessage] Stored: ${messageId} for user ${userId}`);
  } catch (error) {
    recordFailure();
    console.error('[RawMessage] Error storing raw message:', error instanceof Error ? error.message : error);
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

  if (!isNeonConfigured()) {
    console.log('[RawMessage] Neon not configured');
    return [];
  }

  try {
    const sql = getSql();
    if (!sql) return [];

    let queryPromise;

    if (startTime && endTime) {
      queryPromise = sql`
        SELECT * FROM raw_messages
        WHERE user_id = ${userId} AND timestamp >= ${startTime} AND timestamp <= ${endTime}
        ORDER BY timestamp DESC
        LIMIT ${limit}
      `;
    } else if (startTime) {
      queryPromise = sql`
        SELECT * FROM raw_messages
        WHERE user_id = ${userId} AND timestamp >= ${startTime}
        ORDER BY timestamp DESC
        LIMIT ${limit}
      `;
    } else if (endTime) {
      queryPromise = sql`
        SELECT * FROM raw_messages
        WHERE user_id = ${userId} AND timestamp <= ${endTime}
        ORDER BY timestamp DESC
        LIMIT ${limit}
      `;
    } else {
      queryPromise = sql`
        SELECT * FROM raw_messages
        WHERE user_id = ${userId}
        ORDER BY timestamp DESC
        LIMIT ${limit}
      `;
    }

    const rows = await withTimeout(queryPromise, 5000);
    return rows as RawMessage[];
  } catch (error) {
    console.error('[RawMessage] Error querying raw messages:', error instanceof Error ? error.message : error);
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

  if (!isNeonConfigured()) {
    console.log('[RawMessage] Neon not configured');
    return [];
  }

  try {
    const sql = getSql();
    if (!sql) return [];

    const rows = await withTimeout(
      sql`
        SELECT * FROM raw_messages
        ORDER BY timestamp DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      10000 // 10 second timeout for larger queries
    );

    return rows as RawMessage[];
  } catch (error) {
    console.error('[RawMessage] Error querying all raw messages:', error instanceof Error ? error.message : error);
    return [];
  }
}
