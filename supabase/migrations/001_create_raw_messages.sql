-- Create raw_messages table for storing LINE webhook events
-- Run this in your Supabase SQL Editor: https://supabase.com/dashboard/project/YOUR_PROJECT/sql

CREATE TABLE IF NOT EXISTS raw_messages (
  id BIGSERIAL PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  source_type TEXT NOT NULL,
  raw_event JSONB NOT NULL,
  timestamp BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_raw_messages_user_id ON raw_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_raw_messages_timestamp ON raw_messages(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_raw_messages_user_timestamp ON raw_messages(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_raw_messages_event_type ON raw_messages(event_type);

-- Create unique constraint on message_id to prevent duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_messages_message_id ON raw_messages(message_id);

-- Enable Row Level Security (RLS) - optional but recommended
ALTER TABLE raw_messages ENABLE ROW LEVEL SECURITY;

-- Create policy to allow insert from service role (anon key with service_role)
-- Adjust this based on your security requirements
CREATE POLICY "Allow insert for authenticated users" ON raw_messages
  FOR INSERT
  TO anon
  WITH CHECK (true);

CREATE POLICY "Allow select for authenticated users" ON raw_messages
  FOR SELECT
  TO anon
  USING (true);

-- Add comment to table
COMMENT ON TABLE raw_messages IS 'Stores raw LINE webhook events for permanent storage and analytics';
