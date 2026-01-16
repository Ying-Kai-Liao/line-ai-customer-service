import { neon } from '@neondatabase/serverless';
import { config } from '../config';
import type {
  Conversation,
  AnalyticsMessage,
  AgentRouting,
  ExpertInteraction,
  RagQuery,
  CrisisEvent,
} from '../types';

// In-memory store for local development
const localConversations: Conversation[] = [];
const localMessages: AnalyticsMessage[] = [];
const localRoutings: AgentRouting[] = [];
const localExpertInteractions: ExpertInteraction[] = [];
const localRagQueries: RagQuery[] = [];
const localCrisisEvents: CrisisEvent[] = [];

const isLocalMode = process.env.USE_LOCAL_STORAGE === 'true';

// Circuit breaker state - shared with raw-message service pattern
let consecutiveFailures = 0;
let circuitOpenUntil = 0;
const MAX_FAILURES = 3;
const CIRCUIT_RESET_MS = 60 * 1000; // 1 minute

// Session tracking - map user_id to active conversation_id
const activeConversations: Map<string, number> = new Map();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const lastActivityTime: Map<string, number> = new Map();

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
    console.warn(`[Analytics] Circuit breaker opened - skipping DB for ${CIRCUIT_RESET_MS / 1000}s`);
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
// Conversation Management
// ============================================

/**
 * Get or create a conversation for a user
 * Returns conversation_id
 */
export async function getOrCreateConversation(userId: string): Promise<number | null> {
  const now = Date.now();
  const lastActivity = lastActivityTime.get(userId) || 0;

  // Check if existing session is still valid
  if (activeConversations.has(userId) && (now - lastActivity) < SESSION_TIMEOUT_MS) {
    lastActivityTime.set(userId, now);
    return activeConversations.get(userId) || null;
  }

  // Need to create a new conversation
  if (isLocalMode) {
    const id = localConversations.length + 1;
    const conversation: Conversation = {
      id,
      user_id: userId,
      started_at: new Date().toISOString(),
      message_count: 0,
      agents_used: [],
      had_crisis: false,
    };
    localConversations.push(conversation);
    activeConversations.set(userId, id);
    lastActivityTime.set(userId, now);
    console.log(`[Analytics] Created local conversation ${id} for user ${userId}`);
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
        INSERT INTO conversations (user_id, started_at, message_count, agents_used, had_crisis)
        VALUES (${userId}, NOW(), 0, '{}', false)
        RETURNING id
      `,
      3000
    );

    recordSuccess();
    const conversationId = result[0]?.id;
    if (conversationId) {
      activeConversations.set(userId, conversationId);
      lastActivityTime.set(userId, now);
      console.log(`[Analytics] Created conversation ${conversationId} for user ${userId}`);
    }
    return conversationId;
  } catch (error) {
    recordFailure();
    console.error('[Analytics] Error creating conversation:', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Update conversation with new agent used
 */
export async function updateConversationAgent(conversationId: number, agentType: string): Promise<void> {
  if (isLocalMode) {
    const conv = localConversations.find(c => c.id === conversationId);
    if (conv && !conv.agents_used.includes(agentType)) {
      conv.agents_used.push(agentType);
    }
    return;
  }

  if (!isNeonConfigured() || isCircuitOpen()) return;

  try {
    const sql = getSql();
    if (!sql) return;

    await withTimeout(
      sql`
        UPDATE conversations
        SET agents_used = array_append(
          CASE WHEN ${agentType} = ANY(agents_used) THEN agents_used ELSE agents_used END,
          CASE WHEN ${agentType} = ANY(agents_used) THEN NULL ELSE ${agentType} END
        ),
        message_count = message_count + 1
        WHERE id = ${conversationId}
      `,
      3000
    );
    recordSuccess();
  } catch (error) {
    recordFailure();
    console.error('[Analytics] Error updating conversation:', error instanceof Error ? error.message : error);
  }
}

/**
 * Mark conversation as having crisis
 */
export async function markConversationCrisis(conversationId: number): Promise<void> {
  if (isLocalMode) {
    const conv = localConversations.find(c => c.id === conversationId);
    if (conv) conv.had_crisis = true;
    return;
  }

  if (!isNeonConfigured() || isCircuitOpen()) return;

  try {
    const sql = getSql();
    if (!sql) return;

    await withTimeout(
      sql`UPDATE conversations SET had_crisis = true WHERE id = ${conversationId}`,
      3000
    );
    recordSuccess();
  } catch (error) {
    recordFailure();
    console.error('[Analytics] Error marking crisis:', error instanceof Error ? error.message : error);
  }
}

// ============================================
// Message Tracking
// ============================================

/**
 * Track a message (user or assistant)
 */
export async function trackMessage(message: Omit<AnalyticsMessage, 'id' | 'created_at'>): Promise<number | null> {
  if (isLocalMode) {
    const id = localMessages.length + 1;
    localMessages.push({ ...message, id });
    console.log(`[Analytics] Tracked local message ${id}`);
    return id;
  }

  if (!isNeonConfigured() || isCircuitOpen()) return null;

  try {
    const sql = getSql();
    if (!sql) return null;

    const result = await withTimeout(
      sql`
        INSERT INTO messages (conversation_id, user_id, role, content, message_type, agent_type, response_time_ms, timestamp)
        VALUES (${message.conversation_id || null}, ${message.user_id}, ${message.role}, ${message.content}, ${message.message_type || null}, ${message.agent_type || null}, ${message.response_time_ms || null}, ${message.timestamp})
        RETURNING id
      `,
      3000
    );

    recordSuccess();
    const messageId = result[0]?.id;
    console.log(`[Analytics] Tracked message ${messageId}`);
    return messageId;
  } catch (error) {
    recordFailure();
    console.error('[Analytics] Error tracking message:', error instanceof Error ? error.message : error);
    return null;
  }
}

// ============================================
// Agent Routing Tracking
// ============================================

/**
 * Track an agent routing decision
 */
export async function trackAgentRouting(routing: Omit<AgentRouting, 'id' | 'created_at'>): Promise<void> {
  if (isLocalMode) {
    localRoutings.push({ ...routing, id: localRoutings.length + 1 });
    console.log(`[Analytics] Tracked local routing to ${routing.routed_to}`);
    return;
  }

  if (!isNeonConfigured() || isCircuitOpen()) return;

  try {
    const sql = getSql();
    if (!sql) return;

    await withTimeout(
      sql`
        INSERT INTO agent_routing (message_id, user_message, routed_to, routing_reason, keywords_matched, confidence)
        VALUES (${routing.message_id || null}, ${routing.user_message}, ${routing.routed_to}, ${routing.routing_reason || null}, ${routing.keywords_matched || []}, ${routing.confidence || null})
      `,
      3000
    );

    recordSuccess();
    console.log(`[Analytics] Tracked routing to ${routing.routed_to}`);
  } catch (error) {
    recordFailure();
    console.error('[Analytics] Error tracking routing:', error instanceof Error ? error.message : error);
  }
}

// ============================================
// Expert Interaction Tracking
// ============================================

/**
 * Track an expert interaction
 */
export async function trackExpertInteraction(interaction: Omit<ExpertInteraction, 'id' | 'created_at'>): Promise<void> {
  if (isLocalMode) {
    localExpertInteractions.push({ ...interaction, id: localExpertInteractions.length + 1 });
    console.log(`[Analytics] Tracked local expert ${interaction.action}`);
    return;
  }

  if (!isNeonConfigured() || isCircuitOpen()) return;

  try {
    const sql = getSql();
    if (!sql) return;

    await withTimeout(
      sql`
        INSERT INTO expert_interactions (user_id, action, search_query, expert_id, expert_name, expert_domains, results_count)
        VALUES (${interaction.user_id}, ${interaction.action}, ${interaction.search_query || null}, ${interaction.expert_id || null}, ${interaction.expert_name || null}, ${interaction.expert_domains || []}, ${interaction.results_count || null})
      `,
      3000
    );

    recordSuccess();
    console.log(`[Analytics] Tracked expert ${interaction.action}`);
  } catch (error) {
    recordFailure();
    console.error('[Analytics] Error tracking expert interaction:', error instanceof Error ? error.message : error);
  }
}

// ============================================
// RAG Query Tracking
// ============================================

/**
 * Track a RAG query
 */
export async function trackRagQuery(query: Omit<RagQuery, 'id' | 'created_at'>): Promise<void> {
  if (isLocalMode) {
    localRagQueries.push({ ...query, id: localRagQueries.length + 1 });
    console.log(`[Analytics] Tracked local RAG query`);
    return;
  }

  if (!isNeonConfigured() || isCircuitOpen()) return;

  try {
    const sql = getSql();
    if (!sql) return;

    await withTimeout(
      sql`
        INSERT INTO rag_queries (user_id, query, index_name, results_count, top_score, sources, was_helpful)
        VALUES (${query.user_id}, ${query.query}, ${query.index_name}, ${query.results_count}, ${query.top_score || null}, ${query.sources || []}, ${query.was_helpful || null})
      `,
      3000
    );

    recordSuccess();
    console.log(`[Analytics] Tracked RAG query on ${query.index_name}`);
  } catch (error) {
    recordFailure();
    console.error('[Analytics] Error tracking RAG query:', error instanceof Error ? error.message : error);
  }
}

// ============================================
// Crisis Event Tracking
// ============================================

/**
 * Track a crisis event
 */
export async function trackCrisisEvent(event: Omit<CrisisEvent, 'id' | 'created_at'>): Promise<void> {
  if (isLocalMode) {
    localCrisisEvents.push({ ...event, id: localCrisisEvents.length + 1 });
    console.log(`[Analytics] Tracked local crisis event`);
    return;
  }

  if (!isNeonConfigured() || isCircuitOpen()) return;

  try {
    const sql = getSql();
    if (!sql) return;

    await withTimeout(
      sql`
        INSERT INTO crisis_events (user_id, message_content, detection_keywords, response_sent, notification_sent)
        VALUES (${event.user_id}, ${event.message_content}, ${event.detection_keywords}, ${event.response_sent}, ${event.notification_sent})
      `,
      3000
    );

    recordSuccess();
    console.log(`[Analytics] Tracked crisis event`);
  } catch (error) {
    recordFailure();
    console.error('[Analytics] Error tracking crisis event:', error instanceof Error ? error.message : error);
  }
}

// ============================================
// Local Data Getters (for testing/debugging)
// ============================================

export function getLocalAnalytics() {
  return {
    conversations: localConversations,
    messages: localMessages,
    routings: localRoutings,
    expertInteractions: localExpertInteractions,
    ragQueries: localRagQueries,
    crisisEvents: localCrisisEvents,
  };
}
