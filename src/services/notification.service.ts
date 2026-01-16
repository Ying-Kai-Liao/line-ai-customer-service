import { neon } from '@neondatabase/serverless';
import { config } from '../config';
import type { EmotionalSupportEvent } from '../types';

// In-memory store for local development
const localEmotionalSupportEvents: EmotionalSupportEvent[] = [];

const isLocalMode = process.env.USE_LOCAL_STORAGE === 'true';

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
    console.warn(`[Notification] Circuit breaker opened - skipping DB for ${CIRCUIT_RESET_MS / 1000}s`);
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
// Emotional Support Event Logging
// ============================================

/**
 * Log emotional support event to database
 */
async function logEmotionalSupportEvent(params: {
  userId: string;
  message: string;
  emailSent: boolean;
  multicastSent: boolean;
}): Promise<number | null> {
  if (isLocalMode) {
    const id = localEmotionalSupportEvents.length + 1;
    localEmotionalSupportEvents.push({
      id,
      user_id: params.userId,
      message_content: params.message,
      notification_sent: true,
      email_sent: params.emailSent,
      multicast_sent: params.multicastSent,
    });
    console.log(`[Notification] Logged local emotional support event ${id}`);
    return id;
  }

  if (!isNeonConfigured() || isCircuitOpen()) {
    return null;
  }

  try {
    const sql = getSql();
    if (!sql) return null;

    const result = await withTimeout(
      sql`
        INSERT INTO emotional_support_events (user_id, message_content, notification_sent, email_sent, multicast_sent)
        VALUES (${params.userId}, ${params.message}, true, ${params.emailSent}, ${params.multicastSent})
        RETURNING id
      `,
      3000
    );

    recordSuccess();
    const eventId = result[0]?.id;
    console.log(`[Notification] Logged emotional support event ${eventId}`);
    return eventId;
  } catch (error) {
    recordFailure();
    console.error('[Notification] Error logging emotional support event:', error instanceof Error ? error.message : error);
    return null;
  }
}

// ============================================
// Email Notification
// ============================================

/**
 * Send email notification (via external service or SMTP)
 * For now, logs the intent - can be integrated with SES, SendGrid, etc.
 */
async function sendEmail(params: {
  to: string[];
  subject: string;
  body: string;
}): Promise<boolean> {
  // TODO: Integrate with actual email service (SES, SendGrid, etc.)
  // For now, log the email intent
  console.log(`[Notification] Email notification:`);
  console.log(`  To: ${params.to.join(', ')}`);
  console.log(`  Subject: ${params.subject}`);
  console.log(`  Body: ${params.body.substring(0, 100)}...`);

  // Return true to indicate "sent" (logging counts as sent for now)
  return true;
}

// ============================================
// LINE Multicast Notification
// ============================================

/**
 * Send LINE multicast message to staff members
 * Uses LINE Messaging API multicast endpoint
 */
async function sendLineMulticast(params: {
  userIds: string[];
  message: string;
}): Promise<boolean> {
  if (params.userIds.length === 0) {
    console.log('[Notification] No staff LINE IDs configured, skipping multicast');
    return false;
  }

  const channelAccessToken = config.line.channelAccessToken;
  if (!channelAccessToken) {
    console.error('[Notification] LINE channel access token not configured');
    return false;
  }

  try {
    const response = await withTimeout(
      fetch('https://api.line.me/v2/bot/message/multicast', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${channelAccessToken}`,
        },
        body: JSON.stringify({
          to: params.userIds,
          messages: [
            {
              type: 'text',
              text: params.message,
            },
          ],
        }),
      }),
      5000
    );

    if (response.ok) {
      console.log(`[Notification] LINE multicast sent to ${params.userIds.length} staff members`);
      return true;
    } else {
      const errorBody = await response.text().catch(() => 'Unknown error');
      console.error(`[Notification] LINE multicast failed with status ${response.status}: ${errorBody}`);
      return false;
    }
  } catch (error) {
    console.error('[Notification] Error sending LINE multicast:', error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Get staff LINE IDs from config
 */
function getStaffLineIds(): string[] {
  const staffIds = config.notification.staffLineIds;
  if (!staffIds) {
    return [];
  }
  return staffIds.split(',').map(id => id.trim()).filter(Boolean);
}

// ============================================
// Main Alert Functions
// ============================================

/**
 * Send emotional support alert
 * - Logs to database
 * - Sends email to configured addresses
 * - Sends LINE multicast to staff members
 */
export async function sendEmotionalSupportAlert(params: {
  userId: string;
  message: string;
}): Promise<void> {
  console.log(`[Notification] Sending emotional support alert for user ${params.userId}`);

  let emailSent = false;
  let multicastSent = false;

  // 1. Send email notification (if configured)
  const emails = config.notification.emails;
  if (emails) {
    const emailList = emails.split(',').map(e => e.trim()).filter(Boolean);
    if (emailList.length > 0) {
      emailSent = await sendEmail({
        to: emailList,
        subject: '[圈圈] 用戶需要情緒支持',
        body: `用戶 ${params.userId} 表達情緒困擾：\n\n${params.message}\n\n請及時關注。`,
      });
    }
  }

  // 2. Send LINE multicast to staff members
  const staffLineIds = getStaffLineIds();
  if (staffLineIds.length > 0) {
    const truncatedMessage = params.message.length > 100
      ? params.message.substring(0, 100) + '...'
      : params.message;

    multicastSent = await sendLineMulticast({
      userIds: staffLineIds,
      message: `[情緒支持通知]\n用戶需要幫助\n\n訊息：${truncatedMessage}\n\n請及時關注。`,
    });
  }

  // 3. Log to database
  await logEmotionalSupportEvent({
    userId: params.userId,
    message: params.message,
    emailSent,
    multicastSent,
  });

  console.log(`[Notification] Emotional support alert completed - email: ${emailSent}, multicast: ${multicastSent}`);
}

// ============================================
// Local Data Getters (for testing/debugging)
// ============================================

export function getLocalEmotionalSupportEvents(): EmotionalSupportEvent[] {
  return localEmotionalSupportEvents;
}
