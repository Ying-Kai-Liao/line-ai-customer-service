import type { WebhookEvent } from '@line/bot-sdk';
import {
  extractTextContent,
  extractPostbackData,
  parsePostbackData,
  getUserId,
  getReplyToken,
  replyMessage,
  replyMessages,
  showLoadingIndicator,
  isPostbackEvent,
  isMessageEvent,
} from '../services/line.service';
import { getChatHistory, addMessageToHistory } from '../services/dynamo.service';
import { storeRawMessage } from '../services/raw-message.service';
import { processMessage } from '../agents/graph';
import { createTextMessage } from '../tools/line-flex';
import type { ChatMessage } from '../types';
import type { Message } from '@line/bot-sdk';
import { getHandoffStatus, resumeAI, requestHandoff, sendHandoffNotification } from '../services/handoff.service';
import { RESUME_KEYWORDS } from '../agents/supervisor';

const FALLBACK_MESSAGE =
  '抱歉，處理您的訊息時發生問題。請稍後再試。';
const NON_TEXT_MESSAGE =
  '目前我只能處理文字訊息喔！請傳送文字訊息給我。';

// Deduplication: track processed webhook event IDs
// Events are kept for 5 minutes to handle LINE retries
const processedEvents = new Map<string, number>();
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Cleanup old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [eventId, timestamp] of processedEvents) {
    if (now - timestamp > DEDUP_TTL_MS) {
      processedEvents.delete(eventId);
    }
  }
}, 60 * 1000); // Cleanup every minute

/**
 * Check if event was already processed (deduplication)
 */
function isDuplicateEvent(event: WebhookEvent): boolean {
  // Use webhookEventId if available (LINE SDK v3+), fallback to timestamp + replyToken
  const eventId = (event as { webhookEventId?: string }).webhookEventId
    || `${event.timestamp}-${(event as { replyToken?: string }).replyToken || 'no-token'}`;

  if (processedEvents.has(eventId)) {
    console.log(`[Dedup] Skipping duplicate event: ${eventId}`);
    return true;
  }

  processedEvents.set(eventId, Date.now());
  return false;
}

// Helper to create a chat message
function createChatMessage(
  role: 'user' | 'assistant',
  content: string
): ChatMessage {
  return {
    role,
    content,
    timestamp: Date.now(),
  };
}

/**
 * Handles a postback event (user clicked a button)
 */
async function handlePostbackEvent(event: WebhookEvent): Promise<void> {
  if (!isPostbackEvent(event)) return;

  const replyToken = getReplyToken(event);
  if (!replyToken) {
    console.log('No reply token found for postback');
    return;
  }

  const userId = getUserId(event);
  if (!userId) {
    console.log('No user ID found for postback');
    await replyMessage(replyToken, FALLBACK_MESSAGE);
    return;
  }

  const postbackData = extractPostbackData(event);
  if (!postbackData) {
    console.log('No postback data found');
    return;
  }

  const params = parsePostbackData(postbackData);
  console.log(`Postback received: ${postbackData}`, params);

  // Show loading indicator while processing
  await showLoadingIndicator(userId);

  try {
    // Handle expert booking postback (expertId=xxx)
    if (params.expertId) {
      const expertId = parseInt(params.expertId, 10);

      // Get chat history for context
      const chatHistory = await getChatHistory(userId);
      const conversationHistory = chatHistory.map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      }));

      // Process through LangGraph with expertId
      const result = await processMessage(
        `預約專家 ${expertId}`,
        userId,
        conversationHistory,
        expertId
      );

      // Save interaction to history
      const userMessage = createChatMessage('user', `[預約專家 ${expertId}]`);
      await addMessageToHistory(userId, userMessage);
      const assistantMessage = createChatMessage('assistant', result.response);
      await addMessageToHistory(userId, assistantMessage);

      // Send response - flex message if available, otherwise text
      // Pass userId for push fallback if reply token expires
      if (result.flexMessage) {
        const messages: Message[] = [
          createTextMessage(result.response) as Message,
          result.flexMessage,
        ];
        await replyMessages(replyToken, messages, userId);
      } else {
        await replyMessage(replyToken, result.response, userId);
      }

      console.log(`Processed postback for user ${userId}, expert ${expertId}`);
      return;
    }

    // Handle handoff postback (from flex message or quick reply)
    if (params.action === 'handoff' || params.actionId === '21') {
      // Request handoff
      const success = await requestHandoff(userId, `Postback: ${postbackData}`);

      if (success) {
        // Send notification to staff (non-blocking)
        setImmediate(() => {
          sendHandoffNotification(userId, `用戶透過按鈕請求真人客服 (source: ${params.source || 'quick_reply'})`).catch((error) => {
            console.error('[Handler] Failed to send handoff notification:', error);
          });
        });

        await replyMessage(
          replyToken,
          '好的，我已經收到您的請求！真人客服會儘快與您聯繫。\n\n在等待期間，AI 回覆已暫停。如果您想繼續使用 AI 助理，請輸入「回到AI」或「機器人」。',
          userId
        );
      } else {
        await replyMessage(
          replyToken,
          '好的，我會請真人客服來協助您！請稍候片刻。',
          userId
        );
      }

      console.log(`[Handler] User ${userId} requested human support via postback`);
      return;
    }

    // Handle continue with AI postback (user declined handoff offer)
    if (params.action === 'continue_ai') {
      await replyMessage(
        replyToken,
        '沒問題！我會繼續為您服務。請問還有什麼我可以幫您的嗎？',
        userId
      );
      console.log(`[Handler] User ${userId} chose to continue with AI`);
      return;
    }

    // Unknown postback
    console.log(`Unknown postback action: ${postbackData}`);
  } catch (error) {
    console.error('Error handling postback:', error);
    await replyMessage(replyToken, FALLBACK_MESSAGE, userId);
  }
}

/**
 * Handles a message event (user sent a message)
 */
async function handleMessageEvent(event: WebhookEvent): Promise<void> {
  if (!isMessageEvent(event)) return;

  const replyToken = getReplyToken(event);
  if (!replyToken) {
    console.log('No reply token found');
    return;
  }

  const userId = getUserId(event);
  if (!userId) {
    console.log('No user ID found');
    await replyMessage(replyToken, FALLBACK_MESSAGE);
    return;
  }

  // Extract text content
  const textContent = extractTextContent(event);
  if (!textContent) {
    await replyMessage(replyToken, NON_TEXT_MESSAGE);
    return;
  }

  // Show loading indicator while AI processes
  await showLoadingIndicator(userId);

  try {
    // Check handoff status before AI processing
    const handoffStatus = await getHandoffStatus(userId);

    if (handoffStatus !== 'ai') {
      // Check if user wants to return to AI
      const messageLower = textContent.toLowerCase();
      const wantsResume = RESUME_KEYWORDS.some(kw =>
        messageLower.includes(kw.toLowerCase())
      );

      if (wantsResume) {
        // Resume AI for this user
        await resumeAI(userId, null, 'user_resumed');
        console.log(`[Handler] User ${userId} requested to return to AI`);

        // Continue to normal AI processing below
        await replyMessage(
          replyToken,
          '好的，我已經回來了！有什麼我可以幫您的嗎？',
          userId
        );

        // Save the interaction to history
        const userMessage = createChatMessage('user', textContent);
        await addMessageToHistory(userId, userMessage);
        const assistantMessage = createChatMessage('assistant', '好的，我已經回來了！有什麼我可以幫您的嗎？');
        await addMessageToHistory(userId, assistantMessage);
        return;
      }

      // User is in handoff mode - store message but don't process with AI
      console.log(`[Handler] Skipping AI - user ${userId} in handoff mode: ${handoffStatus}`);

      // Save user message to history (for admin to see)
      const userMessage = createChatMessage('user', textContent);
      await addMessageToHistory(userId, userMessage);

      // Don't send a reply - human agent will respond
      return;
    }

    // Get chat history for context
    const chatHistory = await getChatHistory(userId);

    // Convert chat history to format expected by LangGraph
    const conversationHistory = chatHistory.map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    }));

    // Process message through LangGraph multi-agent system
    const result = await processMessage(
      textContent,
      userId,
      conversationHistory
    );

    // Save user message to history
    const userMessage = createChatMessage('user', textContent);
    await addMessageToHistory(userId, userMessage);

    // Save AI response to history
    const assistantMessage = createChatMessage('assistant', result.response);
    await addMessageToHistory(userId, assistantMessage);

    // Send reply - flex message if available, otherwise text
    // Pass userId for push fallback if reply token expires
    if (result.flexMessage) {
      console.log(`[Handler] Sending flex message with text: "${result.response.substring(0, 50)}..."`);
      const messages: Message[] = [
        createTextMessage(result.response) as Message,
        result.flexMessage,
      ];
      await replyMessages(replyToken, messages, userId);
    } else {
      console.log(`[Handler] Sending text-only response: "${result.response.substring(0, 50)}..."`);
      await replyMessage(replyToken, result.response, userId);
    }

    console.log(`[Handler] Processed message for user ${userId}`);
  } catch (error) {
    console.error('Error handling message:', error);
    await replyMessage(replyToken, FALLBACK_MESSAGE, userId);
  }
}

/**
 * Handles a single LINE webhook event
 */
export async function handleEvent(event: WebhookEvent): Promise<void> {
  // Skip duplicate events (LINE retries)
  if (isDuplicateEvent(event)) {
    return;
  }

  // Store raw message for auditing/analytics (non-blocking)
  storeRawMessage(event).catch((error) => {
    console.error('[Handler] Failed to store raw message:', error);
  });

  if (isPostbackEvent(event)) {
    await handlePostbackEvent(event);
  } else if (isMessageEvent(event)) {
    await handleMessageEvent(event);
  } else {
    console.log(`Skipping event type: ${event.type}`);
  }
}

/**
 * Handles multiple LINE webhook events
 */
export async function handleEvents(events: WebhookEvent[]): Promise<void> {
  // Process events concurrently
  await Promise.all(events.map(handleEvent));
}
