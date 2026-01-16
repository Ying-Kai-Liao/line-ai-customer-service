-- Migration: 004_emotional_support_events
-- Description: Add table for tracking emotional support events (when users need support but get redirected to experts)

-- Create emotional support events table
CREATE TABLE IF NOT EXISTS emotional_support_events (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  message_content TEXT NOT NULL,
  notification_sent BOOLEAN DEFAULT false,
  email_sent BOOLEAN DEFAULT false,
  multicast_sent BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_emotional_support_user ON emotional_support_events(user_id);
CREATE INDEX IF NOT EXISTS idx_emotional_support_created ON emotional_support_events(created_at DESC);

-- Grant permissions
GRANT SELECT, INSERT ON emotional_support_events TO PUBLIC;
GRANT USAGE, SELECT ON SEQUENCE emotional_support_events_id_seq TO PUBLIC;
