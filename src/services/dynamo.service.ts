import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { config } from '../config';
import type { ChatHistory, ChatMessage } from '../types';

const client = new DynamoDBClient({ region: config.dynamodb.region });
const docClient = DynamoDBDocumentClient.from(client);

// TTL: 24 hours in seconds
const TTL_SECONDS = 24 * 60 * 60;

export async function getChatHistory(userId: string): Promise<ChatMessage[]> {
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: config.dynamodb.tableName,
        Key: { userId },
      })
    );

    if (!result.Item) {
      return [];
    }

    const history = result.Item as ChatHistory;
    return history.messages || [];
  } catch (error) {
    console.error('Error getting chat history:', error);
    return [];
  }
}

export async function saveChatHistory(
  userId: string,
  messages: ChatMessage[]
): Promise<void> {
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + TTL_SECONDS;

  // Keep only the most recent messages
  const trimmedMessages = messages.slice(-config.maxHistoryMessages);

  const history: ChatHistory = {
    userId,
    messages: trimmedMessages,
    createdAt: now,
    updatedAt: now,
    ttl,
  };

  try {
    await docClient.send(
      new PutCommand({
        TableName: config.dynamodb.tableName,
        Item: history,
      })
    );
  } catch (error) {
    console.error('Error saving chat history:', error);
    throw error;
  }
}

export async function addMessageToHistory(
  userId: string,
  message: ChatMessage
): Promise<ChatMessage[]> {
  const existingMessages = await getChatHistory(userId);
  const updatedMessages = [...existingMessages, message];
  await saveChatHistory(userId, updatedMessages);
  return updatedMessages;
}
