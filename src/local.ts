import 'dotenv/config';
import http from 'http';
import { validateConfig } from './config';
import {
  validateWebhookSignature,
  parseWebhookEvents,
} from './services/line.service';
import { handleEvents } from './handlers/message.handler';

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/webhook') {
    res.writeHead(200);
    res.end('OK');
    return;
  }

  // Only handle POST /webhook
  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  // Read body
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }

  // Validate signature
  const signature = req.headers['x-line-signature'] as string | undefined;
  if (!validateWebhookSignature(body, signature)) {
    console.error('Invalid signature');
    res.writeHead(401);
    res.end('Invalid signature');
    return;
  }

  // Respond immediately to prevent LINE retries
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'OK' }));

  // Process events asynchronously (after responding)
  const events = parseWebhookEvents(body);
  if (events.length > 0) {
    // Use setImmediate to process after response is sent
    setImmediate(async () => {
      try {
        await handleEvents(events);
      } catch (error) {
        console.error('Error handling events:', error);
      }
    });
  }
});

// Validate config on startup
try {
  validateConfig();
  console.log('Configuration validated');
} catch (error) {
  console.error('Configuration error:', error);
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(`🚀 Local server running at http://localhost:${PORT}`);
  console.log(`📡 Webhook endpoint: http://localhost:${PORT}/webhook`);
  console.log('\nNext steps:');
  console.log('1. Run: ngrok http 3000');
  console.log('2. Copy the https URL from ngrok');
  console.log('3. Set it as your LINE webhook URL: <ngrok-url>/webhook');
});
