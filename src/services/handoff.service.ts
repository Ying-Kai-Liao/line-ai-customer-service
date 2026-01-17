import { neon } from '@neondatabase/serverless';
import { config } from '../config';
import type { HandoffStatus, HandoffEventType, HandoffEvent, ActiveHandoff } from '../types';
import { pushMessage } from './line.service';
import type { TextMessage } from '@line/bot-sdk';

// In-memory store for local development
interface LocalHandoff {
  user_id: string;
  handoff_status: HandoffStatus;
  handoff_requested_at?: string;
  handoff_admin_id?: string;
  handoff_timeout_at?: string;
}

const localHandoffs: Map<string, LocalHandoff> = new Map();
const localHandoffEvents: HandoffEvent[] = [];

const isLocalMode = process.env.USE_LOCAL_STORAGE === 'true';

// Default timeout: 1 hour
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

// Circuit breaker state
let consecutiveFailures = 0;
let circuitOpenUntil = 0;
const MAX_FAILURES = 3;
const CIRCUIT_RESET_MS = 60 * 1000; // 1 minute

function isNeonConfigured(): boolean {
  return Boolean(config.neon.connectionString);
}

function isCircuitOpen(): boolean {
  if (Date.now() < circuitOpenUntil) {
    return true;
  }
  if (circuitOpenUntil > 0 && Date.now() >= circuitOpenUntil) {
    circuitOpenUntil = 0;
    consecutiveFailures = 0;
  }
  return false;
}

function recordFailure(): void {
  consecutiveFailures++;
  if (consecutiveFailures >= MAX_FAILURES) {
    circuitOpenUntil = Date.now() + CIRCUIT_RESET_MS;
    console.warn(`[Handoff] Circuit breaker opened - skipping DB for ${CIRCUIT_RESET_MS / 1000}s`);
  }
}

function recordSuccess(): void {
  consecutiveFailures = 0;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Operation timed out')), ms)
  );
  return Promise.race([promise, timeout]);
}

function getSql() {
  if (!isNeonConfigured()) {
    return null;
  }
  return neon(config.neon.connectionString);
}

// ============================================
// Handoff Status Management
// ============================================

/**
 * Get the current handoff status for a user
 * Returns 'ai' if not in handoff mode
 */
export async function getHandoffStatus(userId: string): Promise<HandoffStatus> {
  if (isLocalMode) {
    const handoff = localHandoffs.get(userId);
    return handoff?.handoff_status || 'ai';
  }

  if (!isNeonConfigured() || isCircuitOpen()) {
    return 'ai';
  }

  try {
    const sql = getSql();
    if (!sql) return 'ai';

    const result = await withTimeout(
      sql`
        SELECT handoff_status, handoff_timeout_at
        FROM conversations
        WHERE user_id = ${userId}
        ORDER BY started_at DESC
        LIMIT 1
      `,
      3000
    );

    recordSuccess();

    if (result.length === 0) {
      return 'ai';
    }

    const { handoff_status, handoff_timeout_at } = result[0];

    // Check if timeout has passed
    if (handoff_status !== 'ai' && handoff_timeout_at) {
      const timeoutDate = new Date(handoff_timeout_at);
      if (Date.now() > timeoutDate.getTime()) {
        // Auto-resume AI due to timeout
        await resumeAI(userId, null, 'timeout_resumed');
        return 'ai';
      }
    }

    return (handoff_status as HandoffStatus) || 'ai';
  } catch (error) {
    recordFailure();
    console.error('[Handoff] Error getting handoff status:', error instanceof Error ? error.message : error);
    return 'ai';
  }
}

/**
 * User requests human handoff
 * Sets status to 'pending_human'
 */
export async function requestHandoff(userId: string, message: string): Promise<boolean> {
  const now = new Date();
  const timeoutAt = new Date(now.getTime() + DEFAULT_TIMEOUT_MS);

  if (isLocalMode) {
    localHandoffs.set(userId, {
      user_id: userId,
      handoff_status: 'pending_human',
      handoff_requested_at: now.toISOString(),
      handoff_timeout_at: timeoutAt.toISOString(),
    });
    localHandoffEvents.push({
      user_id: userId,
      event_type: 'user_requested',
      notes: message.substring(0, 500),
      created_at: now.toISOString(),
    });
    console.log(`[Handoff] Local: User ${userId} requested handoff`);
    return true;
  }

  if (!isNeonConfigured() || isCircuitOpen()) {
    return false;
  }

  try {
    const sql = getSql();
    if (!sql) return false;

    // Update the most recent conversation or create handoff state
    const result = await withTimeout(
      sql`
        UPDATE conversations
        SET handoff_status = 'pending_human',
            handoff_requested_at = ${now.toISOString()},
            handoff_timeout_at = ${timeoutAt.toISOString()}
        WHERE user_id = ${userId}
          AND id = (SELECT id FROM conversations WHERE user_id = ${userId} ORDER BY started_at DESC LIMIT 1)
        RETURNING id
      `,
      3000
    );

    if (result.length === 0) {
      // No conversation exists, create one
      const newConv = await withTimeout(
        sql`
          INSERT INTO conversations (user_id, started_at, message_count, agents_used, had_crisis, handoff_status, handoff_requested_at, handoff_timeout_at)
          VALUES (${userId}, NOW(), 0, '{}', false, 'pending_human', ${now.toISOString()}, ${timeoutAt.toISOString()})
          RETURNING id
        `,
        3000
      );
      if (newConv.length > 0) {
        await logHandoffEvent(newConv[0].id, userId, 'user_requested', null, message.substring(0, 500));
      }
    } else {
      await logHandoffEvent(result[0].id, userId, 'user_requested', null, message.substring(0, 500));
    }

    recordSuccess();
    console.log(`[Handoff] User ${userId} requested handoff`);
    return true;
  } catch (error) {
    recordFailure();
    console.error('[Handoff] Error requesting handoff:', error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Admin starts handling a user's conversation
 * Sets status to 'human_active'
 */
export async function startHandoff(userId: string, adminId: string): Promise<boolean> {
  const now = new Date();
  const timeoutAt = new Date(now.getTime() + DEFAULT_TIMEOUT_MS);

  if (isLocalMode) {
    const existing = localHandoffs.get(userId) || {
      user_id: userId,
      handoff_status: 'pending_human' as HandoffStatus,
      handoff_requested_at: now.toISOString(),
    };
    localHandoffs.set(userId, {
      ...existing,
      handoff_status: 'human_active',
      handoff_admin_id: adminId,
      handoff_timeout_at: timeoutAt.toISOString(),
    });
    localHandoffEvents.push({
      user_id: userId,
      event_type: 'admin_started',
      admin_id: adminId,
      created_at: now.toISOString(),
    });
    console.log(`[Handoff] Local: Admin ${adminId} started handling user ${userId}`);
    return true;
  }

  if (!isNeonConfigured() || isCircuitOpen()) {
    return false;
  }

  try {
    const sql = getSql();
    if (!sql) return false;

    const result = await withTimeout(
      sql`
        UPDATE conversations
        SET handoff_status = 'human_active',
            handoff_admin_id = ${adminId},
            handoff_timeout_at = ${timeoutAt.toISOString()}
        WHERE user_id = ${userId}
          AND id = (SELECT id FROM conversations WHERE user_id = ${userId} ORDER BY started_at DESC LIMIT 1)
        RETURNING id
      `,
      3000
    );

    if (result.length > 0) {
      await logHandoffEvent(result[0].id, userId, 'admin_started', adminId, null);
    }

    recordSuccess();
    console.log(`[Handoff] Admin ${adminId} started handling user ${userId}`);
    return true;
  } catch (error) {
    recordFailure();
    console.error('[Handoff] Error starting handoff:', error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Resume AI responses for a user
 * Called by admin, timeout, or user request
 */
export async function resumeAI(
  userId: string,
  adminId: string | null,
  reason: HandoffEventType
): Promise<boolean> {
  if (isLocalMode) {
    localHandoffs.delete(userId);
    localHandoffEvents.push({
      user_id: userId,
      event_type: reason,
      admin_id: adminId || undefined,
      created_at: new Date().toISOString(),
    });
    console.log(`[Handoff] Local: AI resumed for user ${userId}, reason: ${reason}`);
    return true;
  }

  if (!isNeonConfigured() || isCircuitOpen()) {
    return false;
  }

  try {
    const sql = getSql();
    if (!sql) return false;

    const result = await withTimeout(
      sql`
        UPDATE conversations
        SET handoff_status = 'ai',
            handoff_admin_id = NULL,
            handoff_timeout_at = NULL
        WHERE user_id = ${userId}
          AND id = (SELECT id FROM conversations WHERE user_id = ${userId} ORDER BY started_at DESC LIMIT 1)
        RETURNING id
      `,
      3000
    );

    if (result.length > 0) {
      await logHandoffEvent(result[0].id, userId, reason, adminId, null);
    }

    recordSuccess();
    console.log(`[Handoff] AI resumed for user ${userId}, reason: ${reason}`);
    return true;
  } catch (error) {
    recordFailure();
    console.error('[Handoff] Error resuming AI:', error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Get all active handoffs (pending + human_active)
 * For admin dashboard
 */
export async function getActiveHandoffs(): Promise<ActiveHandoff[]> {
  if (isLocalMode) {
    return Array.from(localHandoffs.values())
      .filter(h => h.handoff_status !== 'ai')
      .map(h => ({
        user_id: h.user_id,
        handoff_status: h.handoff_status,
        handoff_requested_at: h.handoff_requested_at,
        handoff_admin_id: h.handoff_admin_id,
        handoff_timeout_at: h.handoff_timeout_at,
      }));
  }

  if (!isNeonConfigured() || isCircuitOpen()) {
    return [];
  }

  try {
    const sql = getSql();
    if (!sql) return [];

    const result = await withTimeout(
      sql`
        SELECT DISTINCT ON (c.user_id)
          c.user_id,
          c.id as conversation_id,
          c.handoff_status,
          c.handoff_requested_at,
          c.handoff_admin_id,
          c.handoff_timeout_at,
          c.message_count
        FROM conversations c
        WHERE c.handoff_status != 'ai'
        ORDER BY c.user_id, c.started_at DESC
      `,
      5000
    );

    recordSuccess();
    return result as ActiveHandoff[];
  } catch (error) {
    recordFailure();
    console.error('[Handoff] Error getting active handoffs:', error instanceof Error ? error.message : error);
    return [];
  }
}

/**
 * Get handoff details for a specific user
 */
export async function getHandoffDetails(userId: string): Promise<ActiveHandoff | null> {
  if (isLocalMode) {
    const handoff = localHandoffs.get(userId);
    if (!handoff || handoff.handoff_status === 'ai') {
      return null;
    }
    return {
      user_id: handoff.user_id,
      handoff_status: handoff.handoff_status,
      handoff_requested_at: handoff.handoff_requested_at,
      handoff_admin_id: handoff.handoff_admin_id,
      handoff_timeout_at: handoff.handoff_timeout_at,
    };
  }

  if (!isNeonConfigured() || isCircuitOpen()) {
    return null;
  }

  try {
    const sql = getSql();
    if (!sql) return null;

    const result = await withTimeout(
      sql`
        SELECT
          c.user_id,
          c.id as conversation_id,
          c.handoff_status,
          c.handoff_requested_at,
          c.handoff_admin_id,
          c.handoff_timeout_at,
          c.message_count
        FROM conversations c
        WHERE c.user_id = ${userId}
          AND c.handoff_status != 'ai'
        ORDER BY c.started_at DESC
        LIMIT 1
      `,
      3000
    );

    recordSuccess();
    return result.length > 0 ? (result[0] as ActiveHandoff) : null;
  } catch (error) {
    recordFailure();
    console.error('[Handoff] Error getting handoff details:', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Check and auto-resume timed-out handoffs
 * Can be called periodically or on message receipt
 */
export async function checkTimeouts(): Promise<number> {
  if (isLocalMode) {
    let resumed = 0;
    const now = Date.now();
    for (const [userId, handoff] of localHandoffs) {
      if (handoff.handoff_timeout_at) {
        const timeoutDate = new Date(handoff.handoff_timeout_at);
        if (now > timeoutDate.getTime()) {
          localHandoffs.delete(userId);
          localHandoffEvents.push({
            user_id: userId,
            event_type: 'timeout_resumed',
            created_at: new Date().toISOString(),
          });
          resumed++;
          console.log(`[Handoff] Local: Auto-resumed AI for user ${userId} due to timeout`);
        }
      }
    }
    return resumed;
  }

  if (!isNeonConfigured() || isCircuitOpen()) {
    return 0;
  }

  try {
    const sql = getSql();
    if (!sql) return 0;

    // Get all timed-out handoffs
    const timedOut = await withTimeout(
      sql`
        SELECT user_id, id as conversation_id
        FROM conversations
        WHERE handoff_status != 'ai'
          AND handoff_timeout_at IS NOT NULL
          AND handoff_timeout_at < NOW()
      `,
      5000
    );

    // Resume each one
    for (const row of timedOut) {
      await withTimeout(
        sql`
          UPDATE conversations
          SET handoff_status = 'ai',
              handoff_admin_id = NULL,
              handoff_timeout_at = NULL
          WHERE id = ${row.conversation_id}
        `,
        3000
      );
      await logHandoffEvent(row.conversation_id, row.user_id, 'timeout_resumed', null, null);
    }

    recordSuccess();
    console.log(`[Handoff] Auto-resumed ${timedOut.length} timed-out handoffs`);
    return timedOut.length;
  } catch (error) {
    recordFailure();
    console.error('[Handoff] Error checking timeouts:', error instanceof Error ? error.message : error);
    return 0;
  }
}

// ============================================
// Notifications
// ============================================

/**
 * Send handoff notification to staff
 * Uses email + LINE multicast like emotional support alerts
 */
export async function sendHandoffNotification(userId: string, message: string): Promise<void> {
  console.log(`[Handoff] Sending notification for user ${userId}`);

  // 1. Send email notification
  const emails = config.notification.emails;
  if (emails) {
    const emailList = emails.split(',').map(e => e.trim()).filter(Boolean);
    if (emailList.length > 0) {
      // Log email intent (actual email integration would go here)
      console.log(`[Handoff] Email notification:`);
      console.log(`  To: ${emailList.join(', ')}`);
      console.log(`  Subject: [圈圈] 用戶請求真人客服`);
      console.log(`  Body: 用戶 ${userId} 請求真人客服：\n\n${message.substring(0, 200)}`);
    }
  }

  // 2. Send LINE multicast to staff
  const staffIds = config.notification.staffLineIds;
  if (staffIds) {
    const staffLineIds = staffIds.split(',').map(id => id.trim()).filter(Boolean);
    if (staffLineIds.length > 0) {
      const truncatedMessage = message.length > 100
        ? message.substring(0, 100) + '...'
        : message;

      try {
        const response = await fetch('https://api.line.me/v2/bot/message/multicast', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.line.channelAccessToken}`,
          },
          body: JSON.stringify({
            to: staffLineIds,
            messages: [
              {
                type: 'text',
                text: `[真人客服請求]\n用戶需要協助\n\n訊息：${truncatedMessage}\n\n請至管理後台處理。`,
              },
            ],
          }),
        });

        if (response.ok) {
          console.log(`[Handoff] LINE multicast sent to ${staffLineIds.length} staff members`);
        } else {
          const errorBody = await response.text().catch(() => 'Unknown error');
          console.error(`[Handoff] LINE multicast failed: ${response.status} - ${errorBody}`);
        }
      } catch (error) {
        console.error('[Handoff] Error sending LINE multicast:', error instanceof Error ? error.message : error);
      }
    }
  }
}

/**
 * Admin sends a message to a user
 * Uses LINE push message API
 */
export async function sendAdminReply(userId: string, adminId: string, message: string): Promise<boolean> {
  try {
    const textMessage: TextMessage = {
      type: 'text',
      text: message,
      sender: {
        name: '圈圈客服',
        iconUrl: 'https://circlewe.com/icon.png', // Replace with actual icon
      },
    };

    await pushMessage(userId, [textMessage]);

    // Log the event
    if (!isLocalMode && isNeonConfigured() && !isCircuitOpen()) {
      const sql = getSql();
      if (sql) {
        // Get conversation ID for this user
        const conv = await sql`
          SELECT id FROM conversations WHERE user_id = ${userId} ORDER BY started_at DESC LIMIT 1
        `;
        if (conv.length > 0) {
          await logHandoffEvent(conv[0].id, userId, 'admin_started', adminId, `Reply: ${message.substring(0, 200)}`);
        }
      }
    }

    console.log(`[Handoff] Admin ${adminId} sent reply to user ${userId}`);
    return true;
  } catch (error) {
    console.error('[Handoff] Error sending admin reply:', error instanceof Error ? error.message : error);
    return false;
  }
}

// ============================================
// Event Logging
// ============================================

async function logHandoffEvent(
  conversationId: number,
  userId: string,
  eventType: HandoffEventType,
  adminId: string | null,
  notes: string | null
): Promise<void> {
  if (isLocalMode) {
    localHandoffEvents.push({
      conversation_id: conversationId,
      user_id: userId,
      event_type: eventType,
      admin_id: adminId || undefined,
      notes: notes || undefined,
      created_at: new Date().toISOString(),
    });
    return;
  }

  if (!isNeonConfigured() || isCircuitOpen()) {
    return;
  }

  try {
    const sql = getSql();
    if (!sql) return;

    await withTimeout(
      sql`
        INSERT INTO handoff_events (conversation_id, user_id, event_type, admin_id, notes)
        VALUES (${conversationId}, ${userId}, ${eventType}, ${adminId}, ${notes})
      `,
      3000
    );
  } catch (error) {
    console.error('[Handoff] Error logging handoff event:', error instanceof Error ? error.message : error);
  }
}

/**
 * Get handoff events for a user
 */
export async function getHandoffEvents(userId: string, limit = 50): Promise<HandoffEvent[]> {
  if (isLocalMode) {
    return localHandoffEvents
      .filter(e => e.user_id === userId)
      .slice(-limit)
      .reverse();
  }

  if (!isNeonConfigured() || isCircuitOpen()) {
    return [];
  }

  try {
    const sql = getSql();
    if (!sql) return [];

    const result = await withTimeout(
      sql`
        SELECT * FROM handoff_events
        WHERE user_id = ${userId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `,
      3000
    );

    recordSuccess();
    return result as HandoffEvent[];
  } catch (error) {
    recordFailure();
    console.error('[Handoff] Error getting handoff events:', error instanceof Error ? error.message : error);
    return [];
  }
}

// ============================================
// Local Data Getters (for testing/debugging)
// ============================================

export function getLocalHandoffs() {
  return {
    handoffs: Array.from(localHandoffs.values()),
    events: localHandoffEvents,
  };
}
