import type { FlexBubble, FlexCarousel, FlexMessage, QuickReply } from '@line/bot-sdk';
import type { Expert, AvailableSlots, TimeSlot } from './expert-api';

// AI Assistant sender info
export const AI_SENDER = {
  name: 'AI 小幫手',
  iconUrl: 'https://pub-1deef48ef8c04017bddec0b1d5c53fe9.r2.dev/%E5%9C%88%E5%9C%88AI-1.png',
};

// Quick reply items for most responses
export const DEFAULT_QUICK_REPLY: QuickReply = {
  items: [
    {
      type: 'action',
      action: {
        type: 'postback',
        label: '🙋🏻‍♀️呼叫真人客服',
        data: 'actionId=21',
      },
    },
    {
      type: 'action',
      action: {
        type: 'uri',
        label: '⭐️到官網看看',
        uri: 'https://circlewelife.com/',
      },
    },
  ],
};

/**
 * Create an expert bubble card for the carousel
 */
export function createExpertBubble(expert: Expert): FlexBubble {
  return {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '20px',
      spacing: 'lg',
      contents: [
        {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'image',
              url: `https://circlewelife.com/images/members/${expert.member_id}?file-name=${expert.image}`,
              aspectMode: 'cover',
              aspectRatio: '1:1',
              size: 'full',
            },
          ],
          cornerRadius: '200px',
          backgroundColor: '#FFFFFF',
          width: '80%',
        },
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'xs',
          contents: [
            {
              type: 'text',
              text: expert.personal_name,
              size: 'xl',
              weight: 'bold',
              align: 'center',
            },
            {
              type: 'text',
              text: `${expert.identity_desr}・${expert.org_description}`,
              size: 'sm',
              color: '#777777',
              align: 'center',
              wrap: true,
            },
          ],
        },
        {
          type: 'separator',
          margin: 'md',
        },
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            {
              type: 'box',
              layout: 'vertical',
              spacing: 'sm',
              contents: [
                {
                  type: 'text',
                  text: `✅ ${expert.expert_years}年經驗`,
                  size: 'sm',
                  color: '#444444',
                },
                {
                  type: 'text',
                  text: '🌐 支援線上諮詢',
                  size: 'sm',
                  color: '#444444',
                },
              ],
            },
          ],
          width: '100%',
        },
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          margin: 'lg',
          contents: [
            {
              type: 'text',
              text: '擅長領域',
              weight: 'bold',
              size: 'sm',
              color: '#5BC3E1',
            },
            {
              type: 'text',
              text: expert.domain.join('、'),
              wrap: true,
              size: 'sm',
              color: '#333333',
            },
          ],
        },
      ],
      alignItems: 'center',
    },
    footer: {
      type: 'box',
      layout: 'horizontal',
      spacing: 'md',
      contents: [
        {
          type: 'button',
          style: 'secondary',
          color: '#E1F5FA',
          action: {
            type: 'uri',
            label: '看介紹',
            uri: `https://circlewelife.com/expert/${expert.expert_id}`,
          },
        },
        {
          type: 'button',
          style: 'primary',
          color: '#5BC3E1',
          action: {
            type: 'postback',
            label: '預約諮詢',
            data: `expertId=${expert.expert_id}`,
          },
        },
      ],
    },
  };
}

/**
 * Create expert list carousel flex message
 */
export function createExpertCarousel(experts: Expert[]): FlexMessage {
  const bubbles = experts.slice(0, 10).map(createExpertBubble);

  const carousel: FlexCarousel = {
    type: 'carousel',
    contents: bubbles,
  };

  return {
    type: 'flex',
    altText: '專家推薦清單',
    contents: carousel,
    sender: AI_SENDER,
    quickReply: DEFAULT_QUICK_REPLY,
  };
}

/**
 * Create time slots bubble for booking
 */
export function createTimeSlotsFlexMessage(data: AvailableSlots): FlexMessage {
  // Group slots by date
  const groupedByDate: Record<string, TimeSlot[]> = {};
  for (const slot of data.results) {
    if (!groupedByDate[slot.date]) {
      groupedByDate[slot.date] = [];
    }
    groupedByDate[slot.date].push(slot);
  }

  const dates = Object.keys(groupedByDate).slice(0, 4); // Max 4 dates

  const dateColumns = dates.map((date) => ({
    type: 'box' as const,
    layout: 'vertical' as const,
    spacing: 'md' as const,
    width: `${Math.floor(93 / dates.length)}%`,
    contents: [
      {
        type: 'text' as const,
        text: date.replace(/(\d+)-(\d+)-(\d+)/, '$2/$3'),
        size: 'sm' as const,
        weight: 'bold' as const,
        align: 'center' as const,
      },
      ...groupedByDate[date].slice(0, 4).map((slot) => ({
        type: 'button' as const,
        style: 'secondary' as const,
        color: '#E1F5FA',
        action: {
          type: 'uri' as const,
          label: slot.start_time,
          uri: `https://circlewelife.com/expert/${data.therapist_id}`,
        },
      })),
    ],
  }));

  const bubble: FlexBubble = {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '20px',
      spacing: 'lg',
      contents: [
        {
          type: 'text',
          text: `${data.name} ${data.title}`,
          size: 'xl',
          weight: 'bold',
          align: 'center',
        },
        {
          type: 'text',
          text: '可預約時段',
          size: 'xl',
          weight: 'bold',
          align: 'center',
        },
        {
          type: 'text',
          text: '點擊時段即至官網預約',
          size: 'xs',
          color: '#999999',
          align: 'center',
        },
        {
          type: 'separator',
          margin: 'md',
        },
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'md',
          contents: dateColumns.length > 0 ? dateColumns : [
            {
              type: 'text',
              text: '目前無可預約時段',
              align: 'center',
              color: '#999999',
            },
          ],
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'horizontal',
      spacing: 'md',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#5BC3E1',
          action: {
            type: 'uri',
            label: '前往查看專家',
            uri: `https://circlewelife.com/expert/${data.therapist_id}`,
          },
        },
      ],
    },
  };

  return {
    type: 'flex',
    altText: '預約時段',
    contents: bubble,
    sender: AI_SENDER,
    quickReply: DEFAULT_QUICK_REPLY,
  };
}

/**
 * Create welcome message when AI arrives
 */
export function createWelcomeMessage(): object {
  return {
    type: 'text',
    text: 'Hi 我是圈圈AI小幫手，你可以問我以下問題～\n1. 最近讓你感到煩躁的事\n2. 想知道怎麼預約專家\n3. 心理學的任何知識\n4. 圈圈的服務內容\n\n請放心的與我說話，你的訊息不會有任何的紀錄留存。',
    sender: AI_SENDER,
    quickReply: DEFAULT_QUICK_REPLY,
  };
}

/**
 * Create a standard text message with AI sender
 */
export function createTextMessage(text: string): object {
  return {
    type: 'text',
    text,
    sender: AI_SENDER,
    quickReply: DEFAULT_QUICK_REPLY,
  };
}
