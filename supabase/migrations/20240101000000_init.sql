-- ============================================================
--  GRID WARS — Supabase Schema
--  Paste this into: Supabase Dashboard → SQL Editor → Run
-- ============================================================

-- Players
CREATE TABLE players (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT UNIQUE NOT NULL,
  username    TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Headquarters (one per player)
CREATE TABLE headquarters (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id  UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  lat        FLOAT8 NOT NULL,
  lng        FLOAT8 NOT NULL,
  cell_id    TEXT UNIQUE NOT NULL,
  coins      INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Mines
CREATE TABLE mines (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  original_builder_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  lat                 FLOAT8 NOT NULL,
  lng                 FLOAT8 NOT NULL,
  cell_id             TEXT UNIQUE NOT NULL,
  level               INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 10),
  last_collected      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ DEFAULT now()
);

-- ─── Indexes ──────────────────────────────────────────────

-- Geospatial bounding-box lookups
CREATE INDEX idx_hq_lat_lng       ON headquarters (lat, lng);
CREATE INDEX idx_mines_lat_lng    ON mines (lat, lng);

-- Owner lookups
CREATE INDEX idx_hq_player_id     ON headquarters (player_id);
CREATE INDEX idx_mines_owner_id   ON mines (owner_id);

-- ─── Row Level Security ───────────────────────────────────
-- The backend uses the service-role key (SUPABASE_KEY) so RLS
-- is disabled for server-to-server calls. If you ever add a
-- client-side Supabase call, enable RLS and add policies.

ALTER TABLE players      DISABLE ROW LEVEL SECURITY;
ALTER TABLE headquarters DISABLE ROW LEVEL SECURITY;
ALTER TABLE mines        DISABLE ROW LEVEL SECURITY;
