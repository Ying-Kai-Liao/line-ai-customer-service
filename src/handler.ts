import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { validateConfig } from './config';
import {
  validateWebhookSignature,
  parseWebhookEvents,
} from './services/line.service';
import { handleEvents } from './handlers/message.handler';

/**
 * Main Lambda handler for LINE webhook
 */
export async function webhook(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  console.log('Received webhook event');

  // Validate configuration on cold start
  try {
    validateConfig();
  } catch (error) {
    console.error('Configuration error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server configuration error' }),
    };
  }

  // Handle GET requests (LINE webhook verification)
  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      body: 'OK',
    };
  }

  // Validate request body exists
  if (!event.body) {
    console.error('No request body');
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'No request body' }),
    };
  }

  // Validate LINE signature
  const signature = event.headers['x-line-signature'] || event.headers['X-Line-Signature'];
  if (!validateWebhookSignature(event.body, signature)) {
    console.error('Invalid signature');
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Invalid signature' }),
    };
  }

  // Parse webhook events
  const lineEvents = parseWebhookEvents(event.body);
  if (lineEvents.length === 0) {
    console.log('No events to process');
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'No events' }),
    };
  }

  // Process events
  try {
    await handleEvents(lineEvents);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'OK' }),
    };
  } catch (error) {
    console.error('Error processing events:', error);
    // Return 200 to prevent LINE from retrying
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Processed with errors' }),
    };
  }
}
