import { Pinecone } from '@pinecone-database/pinecone';
import { OpenAIEmbeddings } from '@langchain/openai';
import { PineconeStore } from '@langchain/pinecone';
import { config } from '../config';

// RAG result structure
export interface RAGResult {
  content: string;
  metadata: {
    source: string;
    title?: string;
    url?: string;
    score: number;
  };
}

// Query parameters
export interface RAGQuery {
  query: string;
  indexName: 'circle-professional' | 'company-files';
  topK?: number;
}

// Lazy-initialized clients
let pineconeClient: Pinecone | null = null;
let embeddings: OpenAIEmbeddings | null = null;

/**
 * Get or initialize Pinecone client
 */
function getPineconeClient(): Pinecone {
  if (!pineconeClient) {
    pineconeClient = new Pinecone({
      apiKey: config.pinecone.apiKey,
    });
  }
  return pineconeClient;
}

/**
 * Get or initialize OpenAI embeddings
 */
function getEmbeddings(): OpenAIEmbeddings {
  if (!embeddings) {
    embeddings = new OpenAIEmbeddings({
      openAIApiKey: config.openai.apiKey,
      modelName: config.embeddings.model,
    });
  }
  return embeddings;
}

/**
 * Query Pinecone vector store and return relevant documents
 */
export async function queryVectorStore(params: RAGQuery): Promise<RAGResult[]> {
  const { query, indexName, topK = 3 } = params;

  // Check if Pinecone is configured
  if (!config.pinecone.apiKey) {
    console.log('[RAG] Pinecone not configured, skipping');
    return [];
  }

  try {
    console.log(`[RAG] Querying index: ${indexName}, query: "${query.substring(0, 50)}..."`);

    const client = getPineconeClient();
    const pineconeIndex = client.index(indexName);
    const embeddingsModel = getEmbeddings();

    // Create vector store from existing index
    // Use type assertion to handle version mismatch between @pinecone-database/pinecone versions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vectorStore = await PineconeStore.fromExistingIndex(embeddingsModel, {
      pineconeIndex: pineconeIndex as unknown as Parameters<typeof PineconeStore.fromExistingIndex>[1]['pineconeIndex'],
    });

    // Similarity search with scores
    const results = await vectorStore.similaritySearchWithScore(query, topK);

    const formattedResults: RAGResult[] = results.map(([doc, score]) => ({
      content: doc.pageContent,
      metadata: {
        source: doc.metadata.source || 'unknown',
        title: doc.metadata.title,
        url: doc.metadata.url,
        score,
      },
    }));

    console.log(`[RAG] Found ${formattedResults.length} results`);
    return formattedResults;
  } catch (error) {
    console.error('[RAG] Error querying vector store:', error);
    return [];
  }
}

/**
 * Determine which index to use based on message content
 */
export function determineIndex(message: string): 'circle-professional' | 'company-files' {
  // Admin/company-related keywords → company-files
  const companyKeywords = ['公司', '政策', '規定', '內部', '管理', '客服', '行政', '流程', '文件'];
  const hasCompanyKeyword = companyKeywords.some(k => message.includes(k));

  if (hasCompanyKeyword) {
    return 'company-files';
  }

  // Default to articles/professional content
  return 'circle-professional';
}

/**
 * Check if message contains RAG trigger keywords
 */
export function hasRAGKeywords(message: string): boolean {
  const lowerMsg = message.toLowerCase();
  return config.ragKeywords.some(keyword => lowerMsg.includes(keyword.toLowerCase()));
}
