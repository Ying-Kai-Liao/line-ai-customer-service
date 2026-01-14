// Expert data structure from the API
export interface Expert {
  expert_id: number;
  member_id: number;
  personal_name: string;
  identity_desr: string;
  org_description: string | null;
  expert_years: number;
  domain: string[];
  image: string;
  thumb?: string;
}

// Raw API response structure for expert list
interface RawExpertFromApi {
  id: number;
  member_id: number;
  personal_name: string;
  identity_desr: string;
  org_description: string | null;
  expert_years: number;
  domain: string;  // API returns domain as newline-separated string
  image: string;
  thumb: string;
  plans?: {
    periods?: Record<string, { start_time: string; end_time: string; type?: string }[]>;
  }[];
}

// API response wrapper
interface ExpertsApiResponse {
  success: boolean;
  data: RawExpertFromApi[];
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
 * Convert raw API expert to our Expert interface
 */
function transformExpert(raw: RawExpertFromApi): Expert {
  // Parse domain string (newline-separated) into array
  const domainArray = raw.domain
    ? raw.domain.split('\n').map(d => d.trim()).filter(d => d.length > 0)
    : [];

  return {
    expert_id: raw.id,
    member_id: raw.member_id,
    personal_name: raw.personal_name,
    identity_desr: raw.identity_desr || '',
    org_description: raw.org_description,
    expert_years: raw.expert_years || 0,
    domain: domainArray,
    image: raw.image,
    thumb: raw.thumb,
  };
}

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
    const data = await response.json() as RawExpertFromApi;
    return transformExpert(data);
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

    const data = await response.json() as RawExpertFromApi;
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
    console.log('[API] Fetching experts list...');
    const response = await fetch(`${BASE_URL}/experts`);
    if (!response.ok) {
      console.error(`Failed to fetch experts list: ${response.status}`);
      return [];
    }
    const result = await response.json() as ExpertsApiResponse;

    if (result.success && Array.isArray(result.data) && result.data.length > 0) {
      const experts = result.data.map(transformExpert);
      console.log(`[API] Found ${experts.length} experts`);
      return experts;
    }

    console.log('[API] No experts found in response');
    return [];
  } catch (error) {
    console.error('Error fetching experts list:', error);
    return [];
  }
}

/**
 * Search experts by criteria
 */
export async function searchExperts(query: string): Promise<TherapistRecommendation> {
  console.log(`[API] Search experts query: ${query}`);

  const experts = await getExpertsList();

  if (experts.length === 0) {
    return {
      type: 'therapist_recommendation',
      results: [],
    };
  }

  // Simple keyword matching
  const lowerQuery = query.toLowerCase();
  let filtered = experts;

  // If query contains specific keywords, filter by domain
  const keywords = ['焦慮', '憂鬱', '關係', '人際', '情緒', '壓力', '家庭', '親子', '伴侶', '職場', '自我'];
  for (const keyword of keywords) {
    if (lowerQuery.includes(keyword)) {
      const matches = experts.filter(e =>
        e.domain.some(d => d.includes(keyword)) ||
        (e.identity_desr && e.identity_desr.includes(keyword))
      );
      if (matches.length > 0) {
        filtered = matches;
        break;
      }
    }
  }

  return {
    type: 'therapist_recommendation',
    results: filtered.slice(0, 10), // Limit to 10
  };
}
