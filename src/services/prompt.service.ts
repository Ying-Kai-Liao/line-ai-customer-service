import { neon } from '@neondatabase/serverless';
import { config } from '../config';
import type { Prompt } from '../types';

// Default prompts (fallback if DB unavailable)
const DEFAULT_PROMPTS: Record<string, string> = {
  router: `You are a customer service router for CircleWe (圈圈), a mental health platform. Analyze the conversation and determine which agent should handle the user's latest message.

Available agents:
1. "main" - General customer service queries, FAQs, company information, mental health knowledge
2. "search_expert" - Finding therapists, booking appointments, expert recommendations. Use this when:
   - User wants to book/make appointment (預約, booking)
   - User is looking for a therapist (找心理師, 找專家)
   - User mentions a topic they need help with (人際關係, 焦慮, 憂鬱, etc.) in context of seeking professional help
   - User is responding to questions about their needs/preferences for expert matching
3. "notification" - ONLY for crisis situations (self-harm, suicide, severe distress)

IMPORTANT: Consider the conversation context!
- If previous messages indicate user is in a booking/expert-finding flow, continue routing to "search_expert"
- Short responses like "好", "可以", "都可以", topic names like "人際關係" are likely follow-ups to the previous flow
- Only route to "main" if the user is clearly asking a new, unrelated question

Respond with ONLY the agent name: "main", "search_expert", or "notification"`,

  main_agent: `You are a helpful, friendly, and professional customer service assistant for CircleWe (圈圈), a mental health and wellness platform.

Your role is to:
1. Answer customer questions clearly and concisely
2. Provide information about mental health topics with empathy
3. Help users understand the services and experts available
4. Be polite and supportive in all interactions
5. Keep responses concise and suitable for a chat interface

If someone asks about booking an appointment or finding an expert, let them know you can help with that.

Always maintain a warm, professional tone. If a user seems distressed, acknowledge their feelings with empathy.

Respond in the same language the user uses (Traditional Chinese or English).`,

  knowledge_agent: `你是 CircleWe (圈圈) 的知識助理，專門提供心理健康相關的資訊和支持。

根據以下參考資料回答用戶問題：

{{context}}

回答要求：
1. 基於參考資料提供準確、有幫助的答案
2. 如果參考資料不完整或不相關，誠實說明並提供你知道的一般性建議
3. 保持專業、友善、具同理心的語氣
4. 使用繁體中文回答
5. 保持簡潔，適合聊天介面閱讀
6. 如果資料中有相關連結，可以建議用戶參考`,

  knowledge_agent_fallback: `你是 CircleWe (圈圈) 的客服助理，專門提供心理健康相關的資訊和支持。

請友善地回答用戶問題。如果你不確定答案，誠實告知並建議他們聯繫客服或查看官網。
使用繁體中文回答，保持簡潔。`,

  appointment_agent: `You are a helpful appointment booking assistant for CircleWe (圈圈), a mental health and wellness platform.

Your role is to:
1. Help users book appointments with mental health professionals
2. Check available time slots when asked
3. Guide users through the booking process
4. Answer questions about appointment policies (cancellation, rescheduling, etc.)

When helping with bookings:
- Ask which expert they'd like to book with (if not specified)
- Ask for their preferred date and time
- Confirm the booking details before finalizing

Respond in the same language the user uses (Traditional Chinese or English).
Be warm, patient, and helpful throughout the process.`,

  notification_agent: `You are a crisis support assistant for CircleWe (圈圈). A user is in distress and may need immediate support.

Your role is to:
1. Respond with empathy and compassion
2. Let them know they are not alone
3. Inform them that a human team member will reach out soon
4. Provide crisis hotline information

IMPORTANT: Always include this information:
- Taiwan Suicide Prevention Hotline: 1925 (24小時)
- 生命線: 1995
- 張老師專線: 1980

Your response should:
- Acknowledge their feelings without judgment
- Express that you care about their wellbeing
- Reassure them that help is available
- Let them know our team has been notified and will reach out

Respond in the same language the user uses (Traditional Chinese or English).
Be gentle, warm, and supportive.`,
};

// In-memory cache with TTL
interface CacheEntry {
  content: string;
  expiry: number;
}

const promptCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const isLocalMode = process.env.USE_LOCAL_STORAGE === 'true';

// Local mode storage
const localPrompts: Map<string, Prompt> = new Map();

// Initialize local prompts from defaults
function initLocalPrompts() {
  if (localPrompts.size === 0) {
    const promptNames: Record<string, { display: string; desc: string }> = {
      router: { display: 'Router Agent', desc: 'Routes messages to appropriate specialized agents' },
      main_agent: { display: 'Main Agent', desc: 'General customer service for FAQs' },
      knowledge_agent: { display: 'Knowledge Agent', desc: 'RAG-based answers using knowledge base' },
      knowledge_agent_fallback: { display: 'Knowledge Agent Fallback', desc: 'Fallback when no RAG results' },
      appointment_agent: { display: 'Appointment Agent', desc: 'Helps with booking appointments' },
      notification_agent: { display: 'Notification Agent', desc: 'Crisis support for users in distress' },
    };

    let id = 1;
    for (const [name, content] of Object.entries(DEFAULT_PROMPTS)) {
      localPrompts.set(name, {
        id: id++,
        name,
        display_name: promptNames[name]?.display || name,
        description: promptNames[name]?.desc || '',
        content,
        version: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
  }
}

// Circuit breaker state
let consecutiveFailures = 0;
let circuitOpenUntil = 0;
const MAX_FAILURES = 3;
const CIRCUIT_RESET_MS = 60 * 1000;

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
    console.warn(`[Prompt] Circuit breaker opened - using defaults for ${CIRCUIT_RESET_MS / 1000}s`);
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
// Prompt CRUD Operations
// ============================================

/**
 * Get a prompt by name (cached, with fallback to default)
 */
export async function getPrompt(name: string): Promise<string> {
  // Check cache first
  const cached = promptCache.get(name);
  if (cached && Date.now() < cached.expiry) {
    return cached.content;
  }

  // Local mode
  if (isLocalMode) {
    initLocalPrompts();
    const prompt = localPrompts.get(name);
    if (prompt) {
      promptCache.set(name, { content: prompt.content, expiry: Date.now() + CACHE_TTL_MS });
      return prompt.content;
    }
    return DEFAULT_PROMPTS[name] || '';
  }

  // Try database
  if (!isNeonConfigured() || isCircuitOpen()) {
    console.log(`[Prompt] Using default prompt for ${name} (DB unavailable)`);
    return DEFAULT_PROMPTS[name] || '';
  }

  try {
    const sql = getSql();
    if (!sql) return DEFAULT_PROMPTS[name] || '';

    const result = await withTimeout(
      sql`SELECT content FROM prompts WHERE name = ${name}`,
      3000
    );

    recordSuccess();

    if (result[0]?.content) {
      const content = result[0].content;
      promptCache.set(name, { content, expiry: Date.now() + CACHE_TTL_MS });
      return content;
    }

    // Fall back to default
    return DEFAULT_PROMPTS[name] || '';
  } catch (error) {
    recordFailure();
    console.error('[Prompt] Error fetching prompt:', error instanceof Error ? error.message : error);
    return DEFAULT_PROMPTS[name] || '';
  }
}

/**
 * Update a prompt and invalidate cache
 */
export async function updatePrompt(name: string, content: string): Promise<boolean> {
  // Local mode
  if (isLocalMode) {
    initLocalPrompts();
    const existing = localPrompts.get(name);
    if (existing) {
      localPrompts.set(name, {
        ...existing,
        previous_content: existing.content,
        content,
        version: existing.version + 1,
        updated_at: new Date().toISOString(),
      });
      promptCache.delete(name);
      console.log(`[Prompt] Updated local prompt ${name}`);
      return true;
    }
    return false;
  }

  if (!isNeonConfigured() || isCircuitOpen()) return false;

  try {
    const sql = getSql();
    if (!sql) return false;

    await withTimeout(
      sql`
        UPDATE prompts
        SET
          previous_content = content,
          content = ${content},
          version = version + 1,
          updated_at = NOW()
        WHERE name = ${name}
      `,
      3000
    );

    recordSuccess();

    // Invalidate cache
    promptCache.delete(name);
    console.log(`[Prompt] Updated prompt ${name}`);
    return true;
  } catch (error) {
    recordFailure();
    console.error('[Prompt] Error updating prompt:', error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Revert a prompt to its previous version
 */
export async function revertPrompt(name: string): Promise<boolean> {
  // Local mode
  if (isLocalMode) {
    initLocalPrompts();
    const existing = localPrompts.get(name);
    if (existing && existing.previous_content) {
      localPrompts.set(name, {
        ...existing,
        content: existing.previous_content,
        previous_content: existing.content,
        version: existing.version + 1,
        updated_at: new Date().toISOString(),
      });
      promptCache.delete(name);
      console.log(`[Prompt] Reverted local prompt ${name}`);
      return true;
    }
    return false;
  }

  if (!isNeonConfigured() || isCircuitOpen()) return false;

  try {
    const sql = getSql();
    if (!sql) return false;

    await withTimeout(
      sql`
        UPDATE prompts
        SET
          content = previous_content,
          previous_content = content,
          version = version + 1,
          updated_at = NOW()
        WHERE name = ${name} AND previous_content IS NOT NULL
      `,
      3000
    );

    recordSuccess();
    promptCache.delete(name);
    console.log(`[Prompt] Reverted prompt ${name}`);
    return true;
  } catch (error) {
    recordFailure();
    console.error('[Prompt] Error reverting prompt:', error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Get all prompts
 */
export async function getAllPrompts(): Promise<Prompt[]> {
  // Local mode
  if (isLocalMode) {
    initLocalPrompts();
    return Array.from(localPrompts.values());
  }

  if (!isNeonConfigured() || isCircuitOpen()) {
    // Return defaults as Prompt objects
    return Object.entries(DEFAULT_PROMPTS).map(([name, content], index) => ({
      id: index + 1,
      name,
      display_name: name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      description: '',
      content,
      version: 1,
    }));
  }

  try {
    const sql = getSql();
    if (!sql) return [];

    const result = await withTimeout(
      sql`SELECT * FROM prompts ORDER BY name`,
      5000
    );

    recordSuccess();
    return result as Prompt[];
  } catch (error) {
    recordFailure();
    console.error('[Prompt] Error fetching all prompts:', error instanceof Error ? error.message : error);
    return [];
  }
}

/**
 * Get a prompt with full details
 */
export async function getPromptDetails(name: string): Promise<Prompt | null> {
  // Local mode
  if (isLocalMode) {
    initLocalPrompts();
    return localPrompts.get(name) || null;
  }

  if (!isNeonConfigured() || isCircuitOpen()) return null;

  try {
    const sql = getSql();
    if (!sql) return null;

    const result = await withTimeout(
      sql`SELECT * FROM prompts WHERE name = ${name}`,
      3000
    );

    recordSuccess();
    return result[0] as Prompt || null;
  } catch (error) {
    recordFailure();
    console.error('[Prompt] Error fetching prompt details:', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Clear the prompt cache (useful for testing or manual refresh)
 */
export function clearPromptCache(): void {
  promptCache.clear();
  console.log('[Prompt] Cache cleared');
}

/**
 * Get default prompt (for comparison or reset)
 */
export function getDefaultPrompt(name: string): string | null {
  return DEFAULT_PROMPTS[name] || null;
}
