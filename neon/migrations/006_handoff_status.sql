-- Migration: 006_handoff_status
-- Description: Add human handoff support for pausing AI when human agent takes over

-- Add handoff columns to conversations table
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS handoff_status TEXT DEFAULT 'ai';
-- Values: 'ai', 'pending_human', 'human_active'

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS handoff_requested_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS handoff_admin_id TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS handoff_timeout_at TIMESTAMPTZ;

-- Create index for active handoffs (partial index for efficiency)
CREATE INDEX IF NOT EXISTS idx_conversations_handoff_status
ON conversations(handoff_status)
WHERE handoff_status != 'ai';

-- Create handoff_events table for audit trail
CREATE TABLE IF NOT EXISTS handoff_events (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT REFERENCES conversations(id),
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL, -- 'user_requested', 'admin_started', 'admin_resumed', 'timeout_resumed', 'user_resumed'
  admin_id TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_handoff_events_user ON handoff_events(user_id);
CREATE INDEX IF NOT EXISTS idx_handoff_events_created ON handoff_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_handoff_events_conversation ON handoff_events(conversation_id);
