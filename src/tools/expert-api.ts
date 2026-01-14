// Expert data structure from the API
export interface Expert {
  expert_id: number;
  member_id: number;
  personal_name: string;
  identity_desr: string;
  org_description: string;
  expert_years: number;
  domain: string[];
  image: string;
}

// API response structure for expert details
interface ExpertApiResponse extends Expert {
  plans?: {
    periods?: Record<string, { start_time: string; end_time: string; type?: string }[]>;
  }[];
}

// Time slot structure
export interface TimeSlot {
  slot_id: number;
  date: string;
  start_time: string;
  end_time: string;
  channel: string;
}

// Structured response for therapist recommendations
export interface TherapistRecommendation {
  type: 'therapist_recommendation';
  results: Expert[];
}

// Structured response for available slots
export interface AvailableSlots {
  type: 'available_slots';
  therapist_id: number;
  name: string;
  title: string;
  results: TimeSlot[];
}

const BASE_URL = 'https://circlewelife.com/api';

/**
 * Get expert details by ID
 */
export async function getExpertById(expertId: number): Promise<Expert | null> {
  try {
    const response = await fetch(`${BASE_URL}/experts/${expertId}`);
    if (!response.ok) {
      console.error(`Failed to fetch expert ${expertId}: ${response.status}`);
      return null;
    }
    const data = await response.json() as ExpertApiResponse;
    return data;
  } catch (error) {
    console.error(`Error fetching expert ${expertId}:`, error);
    return null;
  }
}

/**
 * Get available time slots for an expert
 * Parses the plans.periods structure from the API response
 */
export async function getAvailableSlots(expertId: number): Promise<AvailableSlots | null> {
  try {
    const response = await fetch(`${BASE_URL}/experts/${expertId}`);
    if (!response.ok) {
      console.error(`Failed to fetch expert ${expertId}: ${response.status}`);
      return null;
    }

    const data = await response.json() as ExpertApiResponse;
    const slots: TimeSlot[] = [];
    let slotId = 1;

    // Parse plans array and extract periods
    if (data.plans && Array.isArray(data.plans)) {
      for (const plan of data.plans) {
        if (plan.periods && typeof plan.periods === 'object') {
          for (const [date, times] of Object.entries(plan.periods)) {
            if (Array.isArray(times)) {
              for (const time of times) {
                slots.push({
                  slot_id: slotId++,
                  date,
                  start_time: time.start_time,
                  end_time: time.end_time,
                  channel: 'online',
                });
              }
            }
          }
        }
      }
    }

    return {
      type: 'available_slots',
      therapist_id: expertId,
      name: data.personal_name || '',
      title: data.identity_desr || '',
      results: slots.slice(0, 15), // Limit to 15 slots
    };
  } catch (error) {
    console.error(`Error fetching slots for expert ${expertId}:`, error);
    return null;
  }
}

/**
 * Get list of all experts from the API
 */
export async function getExpertsList(): Promise<Expert[]> {
  try {
    const response = await fetch(`${BASE_URL}/experts`);
    if (!response.ok) {
      console.error(`Failed to fetch experts list: ${response.status}`);
      return getMockExperts();
    }
    const data = await response.json() as Expert[];
    if (Array.isArray(data) && data.length > 0) {
      return data;
    }
    // If API returns empty, use mock data for testing
    return getMockExperts();
  } catch (error) {
    console.error('Error fetching experts list:', error);
    // Fallback to mock data
    return getMockExperts();
  }
}

/**
 * Mock experts for testing when API is unavailable
 */
function getMockExperts(): Expert[] {
  return [
    {
      expert_id: 1,
      member_id: 101,
      personal_name: '王心理師',
      identity_desr: '臨床心理師',
      org_description: '圈圈心理諮商所',
      expert_years: 8,
      domain: ['焦慮', '憂鬱', '人際關係'],
      image: 'default.jpg',
    },
    {
      expert_id: 2,
      member_id: 102,
      personal_name: '李諮商師',
      identity_desr: '諮商心理師',
      org_description: '圈圈心理諮商所',
      expert_years: 5,
      domain: ['親密關係', '自我探索', '生涯規劃'],
      image: 'default.jpg',
    },
    {
      expert_id: 3,
      member_id: 103,
      personal_name: '陳治療師',
      identity_desr: '藝術治療師',
      org_description: '圈圈心理諮商所',
      expert_years: 6,
      domain: ['創傷', '情緒調節', '藝術治療'],
      image: 'default.jpg',
    },
  ];
}

/**
 * Search experts by criteria
 */
export async function searchExperts(query: string): Promise<TherapistRecommendation> {
  console.log(`Search experts query: ${query}`);

  const experts = await getExpertsList();

  // Simple keyword matching (could be enhanced with better search logic)
  const lowerQuery = query.toLowerCase();
  let filtered = experts;

  // If query contains specific domains, filter by them
  if (lowerQuery.includes('焦慮') || lowerQuery.includes('anxiety')) {
    filtered = experts.filter(e => e.domain.some(d => d.includes('焦慮')));
  } else if (lowerQuery.includes('憂鬱') || lowerQuery.includes('depression')) {
    filtered = experts.filter(e => e.domain.some(d => d.includes('憂鬱')));
  } else if (lowerQuery.includes('關係') || lowerQuery.includes('relationship')) {
    filtered = experts.filter(e => e.domain.some(d => d.includes('關係')));
  }

  // If no specific filter matched, return all experts
  if (filtered.length === 0) {
    filtered = experts;
  }

  return {
    type: 'therapist_recommendation',
    results: filtered.slice(0, 10), // Limit to 10
  };
}
