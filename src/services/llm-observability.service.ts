import { neon } from '@neondatabase/serverless';
import { config } from '../config';
import type { LLMCall, LLMStats } from '../types';

// In-memory store for local development
const localLLMCalls: LLMCall[] = [];

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
    console.warn(`[LLM] Circuit breaker opened - skipping DB for ${CIRCUIT_RESET_MS / 1000}s`);
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
// LLM Call Logging
// ============================================

/**
 * Log an LLM call (non-blocking, fire-and-forget)
 */
export async function logLLMCall(call: Omit<LLMCall, 'id' | 'created_at'>): Promise<number | null> {
  // Calculate total tokens if not provided
  const totalTokens = call.total_tokens ?? ((call.prompt_tokens || 0) + (call.completion_tokens || 0));

  if (isLocalMode) {
    const id = localLLMCalls.length + 1;
    localLLMCalls.push({
      ...call,
      id,
      total_tokens: totalTokens,
      created_at: new Date().toISOString(),
    });
    console.log(`[LLM] Logged local call ${id} - ${call.agent_type} (${totalTokens} tokens)`);
    return id;
  }

  if (!isNeonConfigured() || isCircuitOpen()) return null;

  try {
    const sql = getSql();
    if (!sql) return null;

    const result = await withTimeout(
      sql`
        INSERT INTO llm_calls (
          user_id, agent_type, model, provider, system_prompt,
          input_messages, output_content, prompt_tokens, completion_tokens,
          total_tokens, duration_ms, status, error_message
        )
        VALUES (
          ${call.user_id}, ${call.agent_type}, ${call.model}, ${call.provider}, ${call.system_prompt || null},
          ${JSON.stringify(call.input_messages)}, ${call.output_content || null}, ${call.prompt_tokens || null}, ${call.completion_tokens || null},
          ${totalTokens}, ${call.duration_ms || null}, ${call.status}, ${call.error_message || null}
        )
        RETURNING id
      `,
      3000
    );

    recordSuccess();
    const llmCallId = result[0]?.id;
    console.log(`[LLM] Logged call ${llmCallId} - ${call.agent_type} (${totalTokens} tokens)`);
    return llmCallId;
  } catch (error) {
    recordFailure();
    console.error('[LLM] Error logging call:', error instanceof Error ? error.message : error);
    return null;
  }
}

// ============================================
// LLM Stats for Dashboard
// ============================================

/**
 * Get LLM usage stats for the past N days
 */
export async function getLLMStats(days: number = 7): Promise<LLMStats> {
  const defaultStats: LLMStats = {
    totalCalls: 0,
    totalTokens: 0,
    avgDurationMs: 0,
    errorRate: 0,
    byAgent: {},
    byDay: {},
  };

  if (isLocalMode) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const recentCalls = localLLMCalls.filter(
      c => new Date(c.created_at || 0).getTime() > cutoff
    );

    const errorCount = recentCalls.filter(c => c.status === 'error').length;
    const totalDuration = recentCalls.reduce((sum, c) => sum + (c.duration_ms || 0), 0);

    const byAgent: Record<string, { calls: number; tokens: number }> = {};
    const byDay: Record<string, number> = {};

    for (const call of recentCalls) {
      // By agent
      if (!byAgent[call.agent_type]) {
        byAgent[call.agent_type] = { calls: 0, tokens: 0 };
      }
      byAgent[call.agent_type].calls++;
      byAgent[call.agent_type].tokens += call.total_tokens || 0;

      // By day
      const date = new Date(call.created_at || 0).toISOString().split('T')[0];
      byDay[date] = (byDay[date] || 0) + (call.total_tokens || 0);
    }

    return {
      totalCalls: recentCalls.length,
      totalTokens: recentCalls.reduce((sum, c) => sum + (c.total_tokens || 0), 0),
      avgDurationMs: recentCalls.length > 0 ? Math.round(totalDuration / recentCalls.length) : 0,
      errorRate: recentCalls.length > 0 ? errorCount / recentCalls.length : 0,
      byAgent,
      byDay,
    };
  }

  if (!isNeonConfigured() || isCircuitOpen()) return defaultStats;

  try {
    const sql = getSql();
    if (!sql) return defaultStats;

    // Get aggregate stats
    const [statsResult, agentResult, dailyResult] = await Promise.all([
      withTimeout(
        sql`
          SELECT
            COUNT(*) as total_calls,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(AVG(duration_ms), 0) as avg_duration,
            COUNT(CASE WHEN status = 'error' THEN 1 END)::float / NULLIF(COUNT(*), 0) as error_rate
          FROM llm_calls
          WHERE created_at > NOW() - INTERVAL '${days} days'
        `,
        5000
      ),
      withTimeout(
        sql`
          SELECT
            agent_type,
            COUNT(*) as calls,
            COALESCE(SUM(total_tokens), 0) as tokens
          FROM llm_calls
          WHERE created_at > NOW() - INTERVAL '${days} days'
          GROUP BY agent_type
        `,
        5000
      ),
      withTimeout(
        sql`
          SELECT
            DATE(created_at) as date,
            COALESCE(SUM(total_tokens), 0) as tokens
          FROM llm_calls
          WHERE created_at > NOW() - INTERVAL '${days} days'
          GROUP BY DATE(created_at)
          ORDER BY date
        `,
        5000
      ),
    ]);

    recordSuccess();

    const byAgent: Record<string, { calls: number; tokens: number }> = {};
    for (const row of agentResult) {
      byAgent[row.agent_type] = {
        calls: parseInt(row.calls),
        tokens: parseInt(row.tokens),
      };
    }

    const byDay: Record<string, number> = {};
    for (const row of dailyResult) {
      byDay[row.date] = parseInt(row.tokens);
    }

    return {
      totalCalls: parseInt(statsResult[0]?.total_calls || '0'),
      totalTokens: parseInt(statsResult[0]?.total_tokens || '0'),
      avgDurationMs: Math.round(parseFloat(statsResult[0]?.avg_duration || '0')),
      errorRate: parseFloat(statsResult[0]?.error_rate || '0'),
      byAgent,
      byDay,
    };
  } catch (error) {
    recordFailure();
    console.error('[LLM] Error getting stats:', error instanceof Error ? error.message : error);
    return defaultStats;
  }
}

// ============================================
// LLM Call History
// ============================================

/**
 * Get recent LLM calls with optional filters
 */
export async function getLLMCalls(params: {
  limit?: number;
  offset?: number;
  agent?: string;
  status?: string;
}): Promise<LLMCall[]> {
  const { limit = 50, offset = 0, agent, status } = params;

  if (isLocalMode) {
    let calls = [...localLLMCalls].reverse();
    if (agent) calls = calls.filter(c => c.agent_type === agent);
    if (status) calls = calls.filter(c => c.status === status);
    return calls.slice(offset, offset + limit);
  }

  if (!isNeonConfigured() || isCircuitOpen()) return [];

  try {
    const sql = getSql();
    if (!sql) return [];

    let result;
    if (agent && status) {
      result = await withTimeout(
        sql`
          SELECT * FROM llm_calls
          WHERE agent_type = ${agent} AND status = ${status}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `,
        5000
      );
    } else if (agent) {
      result = await withTimeout(
        sql`
          SELECT * FROM llm_calls
          WHERE agent_type = ${agent}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `,
        5000
      );
    } else if (status) {
      result = await withTimeout(
        sql`
          SELECT * FROM llm_calls
          WHERE status = ${status}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `,
        5000
      );
    } else {
      result = await withTimeout(
        sql`
          SELECT * FROM llm_calls
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `,
        5000
      );
    }

    recordSuccess();
    return result as LLMCall[];
  } catch (error) {
    recordFailure();
    console.error('[LLM] Error getting calls:', error instanceof Error ? error.message : error);
    return [];
  }
}

/**
 * Get a single LLM call by ID
 */
export async function getLLMCallById(id: number): Promise<LLMCall | null> {
  if (isLocalMode) {
    return localLLMCalls.find(c => c.id === id) || null;
  }

  if (!isNeonConfigured() || isCircuitOpen()) return null;

  try {
    const sql = getSql();
    if (!sql) return null;

    const result = await withTimeout(
      sql`SELECT * FROM llm_calls WHERE id = ${id}`,
      3000
    );

    recordSuccess();
    return result[0] as LLMCall || null;
  } catch (error) {
    recordFailure();
    console.error('[LLM] Error getting call by ID:', error instanceof Error ? error.message : error);
    return null;
  }
}

// ============================================
// Local Data Getter (for testing/debugging)
// ============================================

export function getLocalLLMCalls() {
  return localLLMCalls;
}
