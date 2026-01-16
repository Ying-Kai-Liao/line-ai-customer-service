import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { config } from '../../config';
import type { GraphStateType } from '../state';
import { queryVectorStore, determineIndex, type RAGResult } from '../../services/rag.service';
import { trackRagQuery } from '../../services/analytics.service';

/**
 * Get LLM instance based on config
 */
function getLLM() {
  if (config.llmProvider === 'anthropic') {
    return new ChatAnthropic({
      apiKey: config.anthropic.apiKey,
      model: config.anthropic.model,
      maxTokens: 800,
    });
  }
  return new ChatOpenAI({
    apiKey: config.openai.apiKey,
    model: config.openai.model,
    maxTokens: 800,
  });
}

/**
 * Synthesize answer using LLM with RAG context
 */
async function synthesizeAnswer(
  question: string,
  context: string,
  history: BaseMessage[]
): Promise<string> {
  const llm = getLLM();

  const systemPrompt = `你是 CircleWe (圈圈) 的知識助理，專門提供心理健康相關的資訊和支持。

根據以下參考資料回答用戶問題：

${context}

回答要求：
1. 基於參考資料提供準確、有幫助的答案
2. 如果參考資料不完整或不相關，誠實說明並提供你知道的一般性建議
3. 保持專業、友善、具同理心的語氣
4. 使用繁體中文回答
5. 保持簡潔，適合聊天介面閱讀
6. 如果資料中有相關連結，可以建議用戶參考`;

  const messages = [
    new SystemMessage(systemPrompt),
    ...history,
    new HumanMessage(question),
  ];

  const response = await llm.invoke(messages);
  return typeof response.content === 'string' ? response.content : '';
}

/**
 * Format RAG results into context string
 */
function formatContext(results: RAGResult[]): string {
  return results
    .map(
      (r, idx) =>
        `[資料 ${idx + 1}]
來源：${r.metadata.title || r.metadata.source}
${r.metadata.url ? `連結：${r.metadata.url}` : ''}
內容：${r.content}`
    )
    .join('\n\n---\n\n');
}

/**
 * Knowledge agent node - handles RAG queries
 * Retrieves relevant documents from Pinecone and synthesizes answers
 */
export async function knowledgeAgentNode(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  console.log(`[Knowledge Agent] Processing: "${state.userMessage}"`);

  // Determine which index to query based on message content
  const indexName = determineIndex(state.userMessage);
  console.log(`[Knowledge Agent] Using index: ${indexName}`);

  // Query vector store
  const results = await queryVectorStore({
    query: state.userMessage,
    indexName,
    topK: 3,
  });

  // Track RAG query (non-blocking)
  trackRagQuery({
    user_id: state.userId,
    query: state.userMessage,
    index_name: indexName,
    results_count: results.length,
    top_score: results.length > 0 ? results[0].metadata.score : undefined,
    sources: results.map(r => r.metadata.source),
  }).catch(() => {});

  // If no results, fallback to main agent behavior
  if (results.length === 0) {
    console.log('[Knowledge Agent] No results found, falling back to main agent behavior');

    // Use LLM without context (same as main agent)
    const llm = getLLM();
    const fallbackPrompt = `你是 CircleWe (圈圈) 的客服助理，專門提供心理健康相關的資訊和支持。

請友善地回答用戶問題。如果你不確定答案，誠實告知並建議他們聯繫客服或查看官網。
使用繁體中文回答，保持簡潔。`;

    const messages = [
      new SystemMessage(fallbackPrompt),
      ...state.messages,
      new HumanMessage(state.userMessage),
    ];

    const response = await llm.invoke(messages);
    const content = typeof response.content === 'string' ? response.content : '';

    return {
      response: content,
      toolResults: { ragResults: [], ragIndex: indexName },
      messages: [new HumanMessage(state.userMessage), new AIMessage(content)],
    };
  }

  // Build context from results
  const context = formatContext(results);

  // Synthesize answer using LLM + context
  const synthesizedResponse = await synthesizeAnswer(
    state.userMessage,
    context,
    state.messages
  );

  console.log(`[Knowledge Agent] Synthesized response with ${results.length} sources`);

  return {
    response: synthesizedResponse,
    toolResults: { ragResults: results, ragIndex: indexName },
    messages: [new HumanMessage(state.userMessage), new AIMessage(synthesizedResponse)],
  };
}
