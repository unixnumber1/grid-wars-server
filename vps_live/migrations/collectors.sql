-- Collectors system — auto-collect mines

CREATE TABLE collectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES players(id),
  lat FLOAT NOT NULL,
  lng FLOAT NOT NULL,
  cell_id TEXT NOT NULL UNIQUE,
  level INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 10),
  hp INTEGER NOT NULL,
  max_hp INTEGER NOT NULL,
  stored_coins BIGINT NOT NULL DEFAULT 0,
  last_collected_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_collectors_owner ON collectors(owner_id);

-- HQ created_at for PIN abuse fix
ALTER TABLE headquarters ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
