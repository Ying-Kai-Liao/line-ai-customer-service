import { HumanMessage, AIMessage } from '@langchain/core/messages';
import type { GraphStateType } from '../state';
import { sendEmotionalSupportAlert } from '../../services/notification.service';

/**
 * Emotional Support Agent
 *
 * This agent handles users who express emotional distress.
 * Instead of providing emotional support (which is removed),
 * it acknowledges feelings and redirects to finding a professional.
 *
 * Actions:
 * 1. Acknowledge the user's feelings briefly (1 sentence)
 * 2. Redirect to finding an expert
 * 3. Send notifications (email + dashboard + multicast)
 */
export async function emotionalSupportAgentNode(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  console.log(`[EmotionalSupportAgent] Processing message for user ${state.userId}`);

  // 1. Send notifications (non-blocking)
  setImmediate(() => {
    sendEmotionalSupportAlert({
      userId: state.userId,
      message: state.userMessage,
    }).catch((error) => {
      console.error('[EmotionalSupportAgent] Failed to send alert:', error);
    });
  });

  // 2. Generate redirect response
  const response = `我理解你現在的感受，謝謝你願意分享。讓我幫你找一位合適的心理師，專業的陪伴會更有幫助。

請問你最想解決的議題是什麼？例如情緒壓力、人際關係、工作煩惱、親子相處...`;

  console.log(`[EmotionalSupportAgent] Redirecting user ${state.userId} to expert search`);

  return {
    response,
    currentAgent: 'emotional_support',
    messages: [
      new HumanMessage(state.userMessage),
      new AIMessage(response),
    ],
  };
}
