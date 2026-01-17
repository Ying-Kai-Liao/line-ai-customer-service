import { HumanMessage, AIMessage } from '@langchain/core/messages';
import type { GraphStateType } from '../state';
import { requestHandoff, sendHandoffNotification } from '../../services/handoff.service';

/**
 * Handoff Agent
 *
 * This agent handles user requests to speak with a human agent.
 * It:
 * 1. Acknowledges the request
 * 2. Sets the user's status to 'pending_human'
 * 3. Sends notifications to staff (email + LINE multicast)
 * 4. Informs the user that AI responses are paused
 */
export async function handoffAgentNode(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  console.log(`[HandoffAgent] Processing handoff request for user ${state.userId}`);

  // 1. Request handoff (sets status to pending_human)
  const success = await requestHandoff(state.userId, state.userMessage);

  if (!success) {
    console.error(`[HandoffAgent] Failed to request handoff for user ${state.userId}`);
  }

  // 2. Send notifications to staff (non-blocking)
  setImmediate(() => {
    sendHandoffNotification(state.userId, state.userMessage).catch((error) => {
      console.error('[HandoffAgent] Failed to send notification:', error);
    });
  });

  // 3. Generate response
  const response = `我已經收到您的請求！真人客服會儘快與您聯繫。

在等待期間，AI 回覆已暫停。如果您想繼續使用 AI 助理，請輸入「回到AI」或「機器人」。

感謝您的耐心等候！`;

  console.log(`[HandoffAgent] Handoff requested for user ${state.userId}`);

  return {
    response,
    currentAgent: 'handoff',
    messages: [
      new HumanMessage(state.userMessage),
      new AIMessage(response),
    ],
  };
}
