CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS consolidated_memories (
  id            VARCHAR(26) PRIMARY KEY,
  persona_id    VARCHAR(64) NOT NULL DEFAULT 'default',
  cluster       VARCHAR(255) NOT NULL,
  turn_ids      JSONB NOT NULL,
  summary       TEXT NOT NULL,
  embedding     vector(768),
  cohesion_peak SMALLINT NOT NULL,
  merged_entities    JSONB,
  merged_facts       JSONB,
  merged_preferences JSONB,
  merged_decisions   JSONB,
  tier              VARCHAR(10) NOT NULL DEFAULT 'warm',
  last_retrieved    BIGINT,
  retrieval_count   INTEGER NOT NULL DEFAULT 0,
  confidence        FLOAT NOT NULL DEFAULT 0.0,
  created_at        BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_persona   ON consolidated_memories(persona_id);
CREATE INDEX IF NOT EXISTS idx_memories_cohesion  ON consolidated_memories(cohesion_peak DESC);
CREATE INDEX IF NOT EXISTS idx_memories_tier      ON consolidated_memories(tier);
-- HNSW index for fast cosine similarity search on embeddings
CREATE INDEX IF NOT EXISTS idx_memories_embedding ON consolidated_memories
  USING hnsw (embedding vector_cosine_ops);
