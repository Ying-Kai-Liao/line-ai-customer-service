import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { WebhookEvent } from '@line/bot-sdk';
import { config } from '../config';
import type { RawMessage } from '../types';

// In-memory store for local development
const localStore: RawMessage[] = [];
const isLocalMode = process.env.USE_LOCAL_STORAGE === 'true';

// Supabase client (lazy initialization)
let supabase: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient {
  if (!supabase) {
    if (!config.supabase.url || !config.supabase.anonKey) {
      throw new Error('Supabase URL and anon key are required');
    }
    supabase = createClient(config.supabase.url, config.supabase.anonKey);
  }
  return supabase;
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
 * Store a raw LINE webhook event in Supabase
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
    const client = getSupabaseClient();
    const { error } = await client
      .from('raw_messages')
      .insert(rawMessage);

    if (error) {
      console.error('[RawMessage] Supabase error:', error);
      return;
    }

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
    const client = getSupabaseClient();
    let query = client
      .from('raw_messages')
      .select('*')
      .eq('user_id', userId)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (startTime) {
      query = query.gte('timestamp', startTime);
    }
    if (endTime) {
      query = query.lte('timestamp', endTime);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[RawMessage] Supabase query error:', error);
      return [];
    }

    return (data || []) as RawMessage[];
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
    const client = getSupabaseClient();
    const { data, error } = await client
      .from('raw_messages')
      .select('*')
      .order('timestamp', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('[RawMessage] Supabase query error:', error);
      return [];
    }

    return (data || []) as RawMessage[];
  } catch (error) {
    console.error('[RawMessage] Error querying all raw messages:', error);
    return [];
  }
}
