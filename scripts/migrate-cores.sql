-- Cores system migration

-- New currency: ether
ALTER TABLE players ADD COLUMN IF NOT EXISTS ether BIGINT DEFAULT 0;

-- Currency choice for ore nodes
ALTER TABLE ore_nodes ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'shards';

-- Cores table
CREATE TABLE IF NOT EXISTS cores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id BIGINT NOT NULL,
  mine_cell_id TEXT,
  slot_index INTEGER,
  core_type TEXT NOT NULL CHECK (core_type IN ('income','capacity','hp','regen')),
  level INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cores_owner ON cores(owner_id);
CREATE INDEX IF NOT EXISTS idx_cores_mine ON cores(mine_cell_id);
