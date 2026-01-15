export const config = {
  line: {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    channelSecret: process.env.LINE_CHANNEL_SECRET || '',
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4',
  },
  // LLM provider: 'anthropic' or 'openai'
  llmProvider: (process.env.LLM_PROVIDER || 'anthropic') as 'anthropic' | 'openai',
  dynamodb: {
    tableName: process.env.DYNAMODB_TABLE_NAME || 'line-chat-history',
    region: process.env.AWS_REGION || 'ap-northeast-1',
  },
  neon: {
    connectionString: process.env.NEON_DATABASE_URL || '',
  },
  // Expert API for appointments
  expertApi: {
    url: process.env.EXPERT_API_URL || '',
    apiKey: process.env.EXPERT_API_KEY || '',
  },
  // Notification settings
  notification: {
    emails: process.env.NOTIFICATION_EMAILS || '',
  },
  // Number of previous messages to include in context
  maxHistoryMessages: parseInt(process.env.MAX_HISTORY_MESSAGES || '10', 10),
  // Pinecone configuration for RAG
  pinecone: {
    apiKey: process.env.PINECONE_API_KEY || '',
    indexes: {
      articles: process.env.PINECONE_INDEX_ARTICLES || 'circle-professional',
      company: process.env.PINECONE_INDEX_COMPANY || 'company-files',
    },
  },
  // OpenAI embeddings model for RAG
  embeddings: {
    model: 'text-embedding-3-small',
  },
  // RAG keyword triggers - when these keywords are detected, route to knowledge agent
  ragKeywords: ['文章', '資料', '最新', '參考', '研究', '相關內容', '知識', '資訊'],
};

export function validateConfig(): void {
  const required = [
    { key: 'LINE_CHANNEL_ACCESS_TOKEN', value: config.line.channelAccessToken },
    { key: 'LINE_CHANNEL_SECRET', value: config.line.channelSecret },
  ];

  // Validate LLM provider credentials
  if (config.llmProvider === 'anthropic') {
    required.push({ key: 'ANTHROPIC_API_KEY', value: config.anthropic.apiKey });
  } else {
    required.push({ key: 'OPENAI_API_KEY', value: config.openai.apiKey });
  }

  const missing = required.filter(({ value }) => !value);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.map((m) => m.key).join(', ')}`
    );
  }
}
