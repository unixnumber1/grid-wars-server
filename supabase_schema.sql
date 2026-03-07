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

-- Bots
CREATE TABLE IF NOT EXISTS bots (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type                  TEXT NOT NULL,
  category              TEXT NOT NULL,
  emoji                 TEXT NOT NULL,
  lat                   FLOAT8 NOT NULL,
  lng                   FLOAT8 NOT NULL,
  cell_id               TEXT,
  target_mine_id        UUID REFERENCES mines(id) ON DELETE SET NULL,
  spawned_for_player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  coins_drained         INTEGER DEFAULT 0,
  reward_min            INTEGER NOT NULL,
  reward_max            INTEGER NOT NULL,
  drain_per_sec         INTEGER DEFAULT 0,
  speed                 TEXT NOT NULL,
  spawned_at            TIMESTAMPTZ DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bots_player    ON bots (spawned_for_player_id);
CREATE INDEX IF NOT EXISTS idx_bots_expires   ON bots (expires_at);

ALTER TABLE bots DISABLE ROW LEVEL SECURITY;

-- ─── Migrations (run these if tables already exist) ───────
-- Economy v2: 100 mine levels (remove old CHECK constraint)
ALTER TABLE mines DROP CONSTRAINT IF EXISTS mines_level_check;

-- Player level & XP system
ALTER TABLE players ADD COLUMN IF NOT EXISTS xp    integer NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS level integer NOT NULL DEFAULT 1;

-- Player avatar
ALTER TABLE players ADD COLUMN IF NOT EXISTS avatar text DEFAULT '🐺';

-- HQ level
ALTER TABLE headquarters ADD COLUMN IF NOT EXISTS level integer NOT NULL DEFAULT 1;

-- ─── Combat system ─────────────────────────────────────────────────────────
-- Player combat stats
ALTER TABLE players ADD COLUMN IF NOT EXISTS hp           integer;
ALTER TABLE players ADD COLUMN IF NOT EXISTS max_hp       integer;
ALTER TABLE players ADD COLUMN IF NOT EXISTS last_hp_regen TIMESTAMPTZ DEFAULT now();
ALTER TABLE players ADD COLUMN IF NOT EXISTS kills         integer NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS deaths        integer NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS respawn_until TIMESTAMPTZ;

-- Bot combat stats
ALTER TABLE bots ADD COLUMN IF NOT EXISTS hp             integer;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS max_hp         integer;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS attack         integer NOT NULL DEFAULT 0;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS size           text    NOT NULL DEFAULT 'S';
ALTER TABLE bots ADD COLUMN IF NOT EXISTS direction      float8;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS spawn_lat      float8;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS spawn_lng      float8;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS status         text    DEFAULT 'roaming';
ALTER TABLE bots ADD COLUMN IF NOT EXISTS drained_amount integer DEFAULT 0;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS drain_limit    integer DEFAULT 0;

-- ─── App settings (maintenance mode etc.) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz DEFAULT now()
);

INSERT INTO app_settings (key, value)
VALUES ('maintenance_mode', 'false')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_settings (key, value)
VALUES ('last_bots_move', '0')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE app_settings DISABLE ROW LEVEL SECURITY;

-- ─── Vases ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vases (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lat              FLOAT8 NOT NULL,
  lng              FLOAT8 NOT NULL,
  spawned_at       TIMESTAMPTZ DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  broken_by        UUID REFERENCES players(id) ON DELETE SET NULL,
  broken_at        TIMESTAMPTZ,
  diamonds_reward  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vases_lat     ON vases(lat);
CREATE INDEX IF NOT EXISTS idx_vases_lng     ON vases(lng);
CREATE INDEX IF NOT EXISTS idx_vases_expires ON vases(expires_at);

ALTER TABLE vases DISABLE ROW LEVEL SECURITY;

ALTER TABLE players ADD COLUMN IF NOT EXISTS diamonds INTEGER DEFAULT 0;

INSERT INTO app_settings (key, value)
VALUES ('last_vases_spawn', '0')
ON CONFLICT (key) DO NOTHING;

-- ─── Bbox indexes for viewport queries ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_mines_lat       ON mines(lat);
CREATE INDEX IF NOT EXISTS idx_mines_lng       ON mines(lng);
CREATE INDEX IF NOT EXISTS idx_hq_lat          ON headquarters(lat);
CREATE INDEX IF NOT EXISTS idx_hq_lng          ON headquarters(lng);
CREATE INDEX IF NOT EXISTS idx_players_last_lat ON players(last_lat);
CREATE INDEX IF NOT EXISTS idx_players_last_lng ON players(last_lng);
