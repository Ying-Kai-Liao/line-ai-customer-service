-- Analytics tables for LINE AI Customer Service Bot
-- Run this in your Neon SQL Editor: https://console.neon.tech

-- ============================================
-- 1. conversations - Track conversation sessions
-- ============================================
CREATE TABLE IF NOT EXISTS conversations (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  message_count INT DEFAULT 0,
  agents_used TEXT[], -- ['main', 'search_expert', 'appointment']
  had_crisis BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_started_at ON conversations(started_at DESC);

COMMENT ON TABLE conversations IS 'Tracks conversation sessions for analytics';

-- ============================================
-- 2. messages - Store all messages with context
-- ============================================
CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT REFERENCES conversations(id),
  user_id TEXT NOT NULL,
  role TEXT NOT NULL, -- 'user' | 'assistant'
  content TEXT NOT NULL,
  message_type TEXT, -- 'text' | 'flex' | 'image' | etc.
  agent_type TEXT, -- 'main' | 'search_expert' | 'appointment' | 'knowledge' | 'notification'
  response_time_ms INT, -- Time taken to generate response
  timestamp BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_agent_type ON messages(agent_type);

COMMENT ON TABLE messages IS 'Stores all user and assistant messages for analytics';

-- ============================================
-- 3. agent_routing - Track routing decisions
-- ============================================
CREATE TABLE IF NOT EXISTS agent_routing (
  id BIGSERIAL PRIMARY KEY,
  message_id BIGINT REFERENCES messages(id),
  user_message TEXT NOT NULL,
  routed_to TEXT NOT NULL, -- Agent type
  routing_reason TEXT, -- 'keyword' | 'llm_decision' | 'postback'
  keywords_matched TEXT[], -- RAG keywords, crisis keywords, etc.
  confidence FLOAT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_routing_routed_to ON agent_routing(routed_to);
CREATE INDEX IF NOT EXISTS idx_agent_routing_created_at ON agent_routing(created_at DESC);

COMMENT ON TABLE agent_routing IS 'Tracks agent routing decisions for analysis';

-- ============================================
-- 4. expert_interactions - Track expert search and booking
-- ============================================
CREATE TABLE IF NOT EXISTS expert_interactions (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL, -- 'search' | 'view' | 'select' | 'book'
  search_query TEXT,
  expert_id INT,
  expert_name TEXT,
  expert_domains TEXT[],
  results_count INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expert_interactions_user_id ON expert_interactions(user_id);
CREATE INDEX IF NOT EXISTS idx_expert_interactions_action ON expert_interactions(action);
CREATE INDEX IF NOT EXISTS idx_expert_interactions_expert_id ON expert_interactions(expert_id);

COMMENT ON TABLE expert_interactions IS 'Tracks expert search and booking funnel';

-- ============================================
-- 5. rag_queries - Track knowledge retrieval
-- ============================================
CREATE TABLE IF NOT EXISTS rag_queries (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  query TEXT NOT NULL,
  index_name TEXT NOT NULL, -- 'circle-professional' | 'company-files'
  results_count INT,
  top_score FLOAT,
  sources TEXT[], -- Document sources returned
  was_helpful BOOLEAN, -- Could infer from follow-up questions
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_queries_index_name ON rag_queries(index_name);
CREATE INDEX IF NOT EXISTS idx_rag_queries_created_at ON rag_queries(created_at DESC);

COMMENT ON TABLE rag_queries IS 'Tracks RAG knowledge retrieval for optimization';

-- ============================================
-- 6. crisis_events - Track crisis detection (sensitive)
-- ============================================
CREATE TABLE IF NOT EXISTS crisis_events (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  message_content TEXT NOT NULL,
  detection_keywords TEXT[],
  response_sent BOOLEAN DEFAULT TRUE,
  notification_sent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- No index on user_id for privacy, query by date only
CREATE INDEX IF NOT EXISTS idx_crisis_events_created_at ON crisis_events(created_at DESC);

COMMENT ON TABLE crisis_events IS 'Tracks crisis detection events (sensitive data)';

-- ============================================
-- 7. daily_metrics - Pre-aggregated daily stats
-- ============================================
CREATE TABLE IF NOT EXISTS daily_metrics (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL UNIQUE,
  total_messages INT DEFAULT 0,
  unique_users INT DEFAULT 0,
  new_users INT DEFAULT 0,
  conversations_started INT DEFAULT 0,
  avg_messages_per_conversation FLOAT,
  avg_response_time_ms INT,
  agent_distribution JSONB, -- {"main": 100, "search_expert": 50, ...}
  crisis_count INT DEFAULT 0,
  expert_searches INT DEFAULT 0,
  expert_bookings INT DEFAULT 0,
  rag_queries INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_metrics_date ON daily_metrics(date DESC);

COMMENT ON TABLE daily_metrics IS 'Pre-aggregated daily statistics for dashboard';
