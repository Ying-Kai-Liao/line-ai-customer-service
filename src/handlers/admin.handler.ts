import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { config } from '../config';
import { getAllRawMessages, getRawMessagesByUser } from '../services/raw-message.service';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

        // Count by day
        const date = new Date(msg.timestamp).toISOString().split('T')[0];
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
