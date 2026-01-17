import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { config } from '../config';
import { getAllRawMessages, getRawMessagesByUser } from '../services/raw-message.service';
import { getLLMStats, getLLMCalls, getLLMCallById } from '../services/llm-observability.service';
import {
  getAllPrompts,
  getPromptDetails,
  updatePrompt,
  revertPrompt,
  clearPromptCache,
  getDefaultPrompt,
} from '../services/prompt.service';
import {
  getActiveHandoffs,
  getHandoffDetails,
  getHandoffEvents,
  startHandoff,
  resumeAI,
  sendAdminReply,
  checkTimeouts,
} from '../services/handoff.service';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Content-Type': 'application/json',
};

/**
 * Validate admin API key
 */
function validateAdminKey(event: APIGatewayProxyEvent): boolean {
  const adminKey = config.adminApiKey;
  if (!adminKey) {
    console.warn('[Admin] No ADMIN_API_KEY configured, admin endpoints disabled');
    return false;
  }

  const providedKey =
    event.headers['x-admin-key'] ||
    event.headers['X-Admin-Key'] ||
    event.queryStringParameters?.apiKey;

  return providedKey === adminKey;
}

/**
 * Admin API handler
 */
export async function admin(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: '',
    };
  }

  // Validate admin key
  if (!validateAdminKey(event)) {
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  const path = event.path.replace('/admin', '');

  try {
    // GET /admin/messages - List all messages
    if (path === '/messages' && event.httpMethod === 'GET') {
      const limit = parseInt(event.queryStringParameters?.limit || '100', 10);
      const offset = parseInt(event.queryStringParameters?.offset || '0', 10);
      const userId = event.queryStringParameters?.userId;

      let messages;
      if (userId) {
        messages = await getRawMessagesByUser(userId, undefined, undefined, limit);
      } else {
        messages = await getAllRawMessages(limit, offset);
      }

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          data: messages,
          pagination: {
            limit,
            offset,
            count: messages.length,
          },
        }),
      };
    }

    // GET /admin/stats - Get message statistics
    if (path === '/stats' && event.httpMethod === 'GET') {
      const messages = await getAllRawMessages(10000, 0);

      // Calculate stats
      const userCount = new Set(messages.map((m) => m.user_id)).size;
      const eventTypes: Record<string, number> = {};
      const messagesByDay: Record<string, number> = {};

      for (const msg of messages) {
        // Count event types
        eventTypes[msg.event_type] = (eventTypes[msg.event_type] || 0) + 1;

        // Count by day - handle invalid timestamps gracefully
        const parsedDate = new Date(msg.timestamp);
        const date = !isNaN(parsedDate.getTime())
          ? parsedDate.toISOString().split('T')[0]
          : 'unknown';
        messagesByDay[date] = (messagesByDay[date] || 0) + 1;
      }

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          totalMessages: messages.length,
          uniqueUsers: userCount,
          eventTypes,
          messagesByDay,
        }),
      };
    }

    // ============================================
    // LLM Observability Endpoints
    // ============================================

    // GET /admin/llm/stats - Get LLM usage statistics
    if (path === '/llm/stats' && event.httpMethod === 'GET') {
      const days = parseInt(event.queryStringParameters?.days || '7', 10);
      const stats = await getLLMStats(days);

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify(stats),
      };
    }

    // GET /admin/llm/calls - Get recent LLM calls
    if (path === '/llm/calls' && event.httpMethod === 'GET') {
      const limit = parseInt(event.queryStringParameters?.limit || '50', 10);
      const offset = parseInt(event.queryStringParameters?.offset || '0', 10);
      const agent = event.queryStringParameters?.agent;
      const status = event.queryStringParameters?.status;

      const calls = await getLLMCalls({ limit, offset, agent, status });

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          data: calls,
          pagination: {
            limit,
            offset,
            count: calls.length,
          },
        }),
      };
    }

    // GET /admin/llm/calls/:id - Get single LLM call details
    if (path.match(/^\/llm\/calls\/\d+$/) && event.httpMethod === 'GET') {
      const id = parseInt(path.split('/').pop() || '0', 10);
      const call = await getLLMCallById(id);

      if (!call) {
        return {
          statusCode: 404,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'LLM call not found' }),
        };
      }

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify(call),
      };
    }

    // ============================================
    // Prompt Management Endpoints
    // ============================================

    // GET /admin/prompts - List all prompts
    if (path === '/prompts' && event.httpMethod === 'GET') {
      const prompts = await getAllPrompts();

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ data: prompts }),
      };
    }

    // GET /admin/prompts/:name - Get prompt details
    if (path.match(/^\/prompts\/[a-z_]+$/) && event.httpMethod === 'GET') {
      const name = path.split('/').pop() || '';
      const prompt = await getPromptDetails(name);

      if (!prompt) {
        return {
          statusCode: 404,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'Prompt not found' }),
        };
      }

      // Include the default prompt for comparison
      const defaultPrompt = getDefaultPrompt(name);

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          ...prompt,
          default_content: defaultPrompt,
        }),
      };
    }

    // PUT /admin/prompts/:name - Update prompt content
    if (path.match(/^\/prompts\/[a-z_]+$/) && event.httpMethod === 'PUT') {
      const name = path.split('/').pop() || '';

      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'Invalid JSON body' }),
        };
      }

      if (!body.content || typeof body.content !== 'string') {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'Missing or invalid content' }),
        };
      }

      const success = await updatePrompt(name, body.content);

      if (!success) {
        return {
          statusCode: 500,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'Failed to update prompt' }),
        };
      }

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: true, message: 'Prompt updated' }),
      };
    }

    // POST /admin/prompts/:name/revert - Revert prompt to previous version
    if (path.match(/^\/prompts\/[a-z_]+\/revert$/) && event.httpMethod === 'POST') {
      const name = path.split('/')[2];

      const success = await revertPrompt(name);

      if (!success) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'Failed to revert prompt (no previous version)' }),
        };
      }

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: true, message: 'Prompt reverted' }),
      };
    }

    // POST /admin/prompts/cache/clear - Clear prompt cache
    if (path === '/prompts/cache/clear' && event.httpMethod === 'POST') {
      clearPromptCache();

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: true, message: 'Prompt cache cleared' }),
      };
    }

    // ============================================
    // Handoff Management Endpoints
    // ============================================

    // GET /admin/handoffs - List all active handoffs
    if (path === '/handoffs' && event.httpMethod === 'GET') {
      // Also check for timed-out handoffs
      await checkTimeouts();

      const handoffs = await getActiveHandoffs();

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          data: handoffs,
          count: handoffs.length,
        }),
      };
    }

    // GET /admin/handoffs/:userId - Get handoff details for a user
    if (path.match(/^\/handoffs\/[^/]+$/) && !path.includes('/start') && !path.includes('/resume') && !path.includes('/reply') && event.httpMethod === 'GET') {
      const userId = path.split('/').pop() || '';
      const handoff = await getHandoffDetails(userId);

      if (!handoff) {
        return {
          statusCode: 404,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'No active handoff for this user' }),
        };
      }

      // Get recent events for this user
      const events = await getHandoffEvents(userId, 20);

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          ...handoff,
          events,
        }),
      };
    }

    // POST /admin/handoffs/:userId/start - Admin takes over conversation
    if (path.match(/^\/handoffs\/[^/]+\/start$/) && event.httpMethod === 'POST') {
      const userId = path.split('/')[2];

      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        body = {};
      }

      const adminId = body.adminId || 'admin';
      const success = await startHandoff(userId, adminId);

      if (!success) {
        return {
          statusCode: 500,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'Failed to start handoff' }),
        };
      }

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: true, message: `Admin ${adminId} is now handling user ${userId}` }),
      };
    }

    // POST /admin/handoffs/:userId/resume - Resume AI responses
    if (path.match(/^\/handoffs\/[^/]+\/resume$/) && event.httpMethod === 'POST') {
      const userId = path.split('/')[2];

      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        body = {};
      }

      const adminId = body.adminId || 'admin';
      const success = await resumeAI(userId, adminId, 'admin_resumed');

      if (!success) {
        return {
          statusCode: 500,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'Failed to resume AI' }),
        };
      }

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: true, message: `AI responses resumed for user ${userId}` }),
      };
    }

    // POST /admin/handoffs/:userId/reply - Send message to user as admin
    if (path.match(/^\/handoffs\/[^/]+\/reply$/) && event.httpMethod === 'POST') {
      const userId = path.split('/')[2];

      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'Invalid JSON body' }),
        };
      }

      if (!body.message || typeof body.message !== 'string') {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'Missing or invalid message' }),
        };
      }

      const adminId = body.adminId || 'admin';
      const success = await sendAdminReply(userId, adminId, body.message);

      if (!success) {
        return {
          statusCode: 500,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'Failed to send message' }),
        };
      }

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: true, message: 'Message sent to user' }),
      };
    }

    // POST /admin/handoffs/check-timeouts - Manually check and process timeouts
    if (path === '/handoffs/check-timeouts' && event.httpMethod === 'POST') {
      const count = await checkTimeouts();

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: true, resumed: count }),
      };
    }

    // 404 for unknown routes
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Not found' }),
    };
  } catch (error) {
    console.error('[Admin] Error:', error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}
