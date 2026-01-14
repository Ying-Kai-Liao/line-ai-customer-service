import { HumanMessage, AIMessage } from '@langchain/core/messages';
import type { GraphStateType } from '../state';
import { searchExperts } from '../../tools/expert-api';
import { createExpertCarousel } from '../../tools/line-flex';

/**
 * Search expert agent - finds and recommends experts based on user query
 * Returns a flex message carousel with expert cards
 */
export async function searchExpertAgentNode(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  console.log(`Search expert agent processing: "${state.userMessage}"`);

  // Search for experts based on the user's message
  const recommendation = await searchExperts(state.userMessage);

  if (recommendation.results.length > 0) {
    // Create the expert carousel flex message
    const flexMessage = createExpertCarousel(recommendation.results);

    const responseText = `根據您的需求，我為您找到了 ${recommendation.results.length} 位專家，請左右滑動查看，點擊「預約諮詢」即可查看可預約時段！`;

    console.log(`Found ${recommendation.results.length} experts, returning carousel`);

    return {
      response: responseText,
      flexMessage,
      toolResults: { expertRecommendation: recommendation },
      messages: [
        new HumanMessage(state.userMessage),
        new AIMessage(responseText),
      ],
    };
  }

  // No experts found - provide a helpful response
  const noResultsText = '抱歉，目前沒有找到符合您需求的專家。請問您想找哪方面的協助呢？例如：焦慮、憂鬱、人際關係、親密關係等。';

  console.log('No experts found, returning text response');

  return {
    response: noResultsText,
    messages: [
      new HumanMessage(state.userMessage),
      new AIMessage(noResultsText),
    ],
  };
}
