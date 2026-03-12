-- ============================================================
--  GRID WARS — Full Migration
--  Paste into: Supabase Dashboard → SQL Editor → Run
--  Tables in order: players, headquarters, mines, bots,
--                   vases, items, app_settings
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- PLAYERS
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS players (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id           BIGINT      UNIQUE NOT NULL,
  username              TEXT,
  avatar                TEXT        DEFAULT '🐺',
  level                 INTEGER     NOT NULL DEFAULT 1,
  xp                    INTEGER     NOT NULL DEFAULT 0,
  hp                    INTEGER,
  max_hp                INTEGER,
  last_hp_regen         TIMESTAMPTZ DEFAULT now(),
  kills                 INTEGER     NOT NULL DEFAULT 0,
  deaths                INTEGER     NOT NULL DEFAULT 0,
  respawn_until         TIMESTAMPTZ,
  diamonds              INTEGER     NOT NULL DEFAULT 0,
  bonus_attack          INTEGER     NOT NULL DEFAULT 0,
  bonus_hp              INTEGER     NOT NULL DEFAULT 0,
  equipped_sword        UUID,
  equipped_shield       UUID,
  starting_bonus_claimed BOOLEAN   NOT NULL DEFAULT false,
  last_lat              FLOAT8,
  last_lng              FLOAT8,
  last_seen             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS players_telegram_id_idx ON players(telegram_id);

-- ────────────────────────────────────────────────────────────
-- HEADQUARTERS
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS headquarters (
  id             UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id      UUID    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  owner_username TEXT,
  lat            FLOAT8  NOT NULL,
  lng            FLOAT8  NOT NULL,
  cell_id        TEXT    UNIQUE NOT NULL,
  coins          FLOAT8  NOT NULL DEFAULT 0,
  level          INTEGER NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hq_player_id_idx ON headquarters(player_id);
CREATE INDEX IF NOT EXISTS hq_lat_lng_idx   ON headquarters(lat, lng);

-- ────────────────────────────────────────────────────────────
-- MINES
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mines (
  id                  UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            UUID    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  original_builder_id UUID    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  lat                 FLOAT8  NOT NULL,
  lng                 FLOAT8  NOT NULL,
  cell_id             TEXT    UNIQUE NOT NULL,
  level               INTEGER NOT NULL DEFAULT 0,
  last_collected      TIMESTAMPTZ NOT NULL DEFAULT now(),
  upgrade_finish_at   TIMESTAMPTZ,
  pending_level       INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mines_owner_id_idx ON mines(owner_id);
CREATE INDEX IF NOT EXISTS mines_lat_lng_idx  ON mines(lat, lng);

-- ────────────────────────────────────────────────────────────
-- BOTS
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bots (
  id                    UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  type                  TEXT    NOT NULL,
  category              TEXT    NOT NULL DEFAULT 'neutral',
  emoji                 TEXT    NOT NULL,
  lat                   FLOAT8  NOT NULL,
  lng                   FLOAT8  NOT NULL,
  cell_id               TEXT,
  direction             FLOAT8  NOT NULL DEFAULT 0,
  status                TEXT    NOT NULL DEFAULT 'roaming',
  target_mine_id        UUID    REFERENCES mines(id) ON DELETE SET NULL,
  spawned_for_player_id UUID    REFERENCES players(id) ON DELETE CASCADE,
  spawn_lat             FLOAT8,
  spawn_lng             FLOAT8,
  drained_amount        INTEGER NOT NULL DEFAULT 0,
  drain_limit           INTEGER NOT NULL DEFAULT 0,
  coins_drained         INTEGER NOT NULL DEFAULT 0,
  reward_min            INTEGER NOT NULL DEFAULT 0,
  reward_max            INTEGER NOT NULL DEFAULT 0,
  drain_per_sec         INTEGER NOT NULL DEFAULT 0,
  speed                 TEXT    NOT NULL DEFAULT 'medium',
  hp                    INTEGER NOT NULL DEFAULT 100,
  max_hp                INTEGER NOT NULL DEFAULT 100,
  attack                INTEGER NOT NULL DEFAULT 0,
  size                  TEXT    NOT NULL DEFAULT 'S',
  spawned_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS bots_expires_at_idx  ON bots(expires_at);
CREATE INDEX IF NOT EXISTS bots_lat_lng_idx     ON bots(lat, lng);

-- ────────────────────────────────────────────────────────────
-- VASES
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vases (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  lat             FLOAT8  NOT NULL,
  lng             FLOAT8  NOT NULL,
  diamonds_reward INTEGER NOT NULL DEFAULT 1,
  expires_at      TIMESTAMPTZ NOT NULL,
  broken_by       UUID    REFERENCES players(id) ON DELETE SET NULL,
  broken_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vases_expires_at_idx ON vases(expires_at);
CREATE INDEX IF NOT EXISTS vases_lat_lng_idx    ON vases(lat, lng);

-- ────────────────────────────────────────────────────────────
-- ITEMS
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS items (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    UUID    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  type        TEXT    NOT NULL CHECK (type IN ('sword', 'axe', 'shield')),
  rarity      TEXT    NOT NULL CHECK (rarity IN ('common', 'uncommon', 'rare', 'epic', 'mythic', 'legendary')),
  name        TEXT    NOT NULL,
  emoji       TEXT    NOT NULL,
  stat_value  INTEGER NOT NULL DEFAULT 0,
  attack      INTEGER NOT NULL DEFAULT 0,
  crit_chance INTEGER NOT NULL DEFAULT 0,
  defense     INTEGER NOT NULL DEFAULT 0,
  equipped    BOOLEAN NOT NULL DEFAULT false,
  obtained_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS items_owner_idx ON items(owner_id);

-- FK back-references from players to items (after items table exists)
ALTER TABLE players ADD COLUMN IF NOT EXISTS equipped_sword  UUID REFERENCES items(id);
ALTER TABLE players ADD COLUMN IF NOT EXISTS equipped_shield UUID REFERENCES items(id);

-- ────────────────────────────────────────────────────────────
-- APP_SETTINGS
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

INSERT INTO app_settings (key, value) VALUES
  ('maintenance_mode', 'false'),
  ('last_bots_move',   '0'),
  ('last_vases_spawn', '0')
ON CONFLICT (key) DO NOTHING;

-- ────────────────────────────────────────────────────────────
-- ECONOMY v4: coins stored as real_value / 1_000_000 (FLOAT8)
-- Run this once on existing tables:
-- ────────────────────────────────────────────────────────────
-- ALTER TABLE headquarters ALTER COLUMN coins TYPE FLOAT8;
-- UPDATE headquarters SET coins = 0;  -- reset old integer balances

-- ────────────────────────────────────────────────────────────
-- ECONOMY v5: coins moved to players table (BIGINT, direct value)
-- ────────────────────────────────────────────────────────────
ALTER TABLE players ADD COLUMN IF NOT EXISTS coins BIGINT NOT NULL DEFAULT 0;

-- ────────────────────────────────────────────────────────────
-- BAN SYSTEM
-- ────────────────────────────────────────────────────────────
ALTER TABLE players ADD COLUMN IF NOT EXISTS is_banned  BOOLEAN     DEFAULT false;
ALTER TABLE players ADD COLUMN IF NOT EXISTS ban_reason TEXT;
ALTER TABLE players ADD COLUMN IF NOT EXISTS ban_until  TIMESTAMPTZ;
ALTER TABLE players ADD COLUMN IF NOT EXISTS banned_at  TIMESTAMPTZ;

-- ────────────────────────────────────────────────────────────
-- CUSTOM USERNAME SYSTEM
-- ────────────────────────────────────────────────────────────
ALTER TABLE players ADD COLUMN IF NOT EXISTS game_username    TEXT;
ALTER TABLE players ADD COLUMN IF NOT EXISTS username_changes INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS players_game_username_idx ON players(game_username) WHERE game_username IS NOT NULL;

-- ────────────────────────────────────────────────────────────
-- ITEMS v2: axe type, separate attack/crit_chance/defense columns
-- ────────────────────────────────────────────────────────────
ALTER TABLE items ADD COLUMN IF NOT EXISTS attack      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS crit_chance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS defense     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS bonus_crit INTEGER NOT NULL DEFAULT 0;
-- Allow 'axe' type — drop old check and add new one
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_type_check;
ALTER TABLE items ADD CONSTRAINT items_type_check CHECK (type IN ('sword', 'axe', 'shield'));

-- ────────────────────────────────────────────────────────────
-- DISABLE RLS (service-role key used server-side)
-- ────────────────────────────────────────────────────────────
-- ────────────────────────────────────────────────────────────
-- ITEMS: on_market flag
-- ────────────────────────────────────────────────────────────
ALTER TABLE items ADD COLUMN IF NOT EXISTS on_market BOOLEAN NOT NULL DEFAULT false;

-- ────────────────────────────────────────────────────────────
-- MARKETS (physical locations on the map)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS markets (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lat        FLOAT8      NOT NULL,
  lng        FLOAT8      NOT NULL,
  name       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS markets_lat_lng_idx ON markets(lat, lng);

-- ────────────────────────────────────────────────────────────
-- MARKET LISTINGS
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS market_listings (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         UUID        NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  seller_id       UUID        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  buyer_id        UUID        REFERENCES players(id) ON DELETE SET NULL,
  market_id       UUID        REFERENCES markets(id) ON DELETE SET NULL,
  price_diamonds  INTEGER     NOT NULL CHECK (price_diamonds >= 1 AND price_diamonds <= 100000),
  is_private      BOOLEAN     NOT NULL DEFAULT false,
  private_code    TEXT,
  status          TEXT        NOT NULL DEFAULT 'active'
                  CHECK (status IN ('pending','active','sold','cancelled','expired','intercepted')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS ml_seller_idx  ON market_listings(seller_id);
CREATE INDEX IF NOT EXISTS ml_status_idx  ON market_listings(status);
CREATE INDEX IF NOT EXISTS ml_item_idx    ON market_listings(item_id);
CREATE INDEX IF NOT EXISTS ml_expires_idx ON market_listings(expires_at);

-- ────────────────────────────────────────────────────────────
-- COURIERS (visual delivery entities on the map)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS couriers (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  UUID        REFERENCES market_listings(id) ON DELETE SET NULL,
  item_id     UUID        REFERENCES items(id) ON DELETE SET NULL,
  owner_id    UUID        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  type        TEXT        NOT NULL CHECK (type IN ('to_market','delivery')),
  start_lat   FLOAT8      NOT NULL,
  start_lng   FLOAT8      NOT NULL,
  target_lat  FLOAT8      NOT NULL,
  target_lng  FLOAT8      NOT NULL,
  current_lat FLOAT8      NOT NULL,
  current_lng FLOAT8      NOT NULL,
  speed       FLOAT8      NOT NULL DEFAULT 0.00005,
  hp          INTEGER     NOT NULL DEFAULT 100,
  max_hp      INTEGER     NOT NULL DEFAULT 100,
  status      TEXT        NOT NULL DEFAULT 'moving'
              CHECK (status IN ('moving','delivered','killed','cancelled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS couriers_status_idx  ON couriers(status);
CREATE INDEX IF NOT EXISTS couriers_lat_lng_idx ON couriers(current_lat, current_lng);

-- ────────────────────────────────────────────────────────────
-- COURIER DROPS (loot from destroyed couriers)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS courier_drops (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  courier_id  UUID        NOT NULL REFERENCES couriers(id) ON DELETE CASCADE,
  item_id     UUID        NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  listing_id  UUID        REFERENCES market_listings(id) ON DELETE SET NULL,
  lat         FLOAT8      NOT NULL,
  lng         FLOAT8      NOT NULL,
  picked_up   BOOLEAN     NOT NULL DEFAULT false,
  picked_by   UUID        REFERENCES players(id) ON DELETE SET NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cd_expires_idx ON courier_drops(expires_at);
CREATE INDEX IF NOT EXISTS cd_lat_lng_idx ON courier_drops(lat, lng);

-- ────────────────────────────────────────────────────────────
-- NOTIFICATIONS
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id   UUID        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  type        TEXT        NOT NULL,
  message     TEXT        NOT NULL,
  data        JSONB,
  read        BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notif_player_idx ON notifications(player_id);
CREATE INDEX IF NOT EXISTS notif_read_idx   ON notifications(player_id, read);

-- ────────────────────────────────────────────────────────────
-- DISABLE RLS (service-role key used server-side)
-- ────────────────────────────────────────────────────────────
ALTER TABLE players          DISABLE ROW LEVEL SECURITY;
ALTER TABLE headquarters     DISABLE ROW LEVEL SECURITY;
ALTER TABLE mines            DISABLE ROW LEVEL SECURITY;
ALTER TABLE bots             DISABLE ROW LEVEL SECURITY;
ALTER TABLE vases            DISABLE ROW LEVEL SECURITY;
ALTER TABLE items            DISABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings     DISABLE ROW LEVEL SECURITY;
ALTER TABLE markets          DISABLE ROW LEVEL SECURITY;
ALTER TABLE market_listings  DISABLE ROW LEVEL SECURITY;
ALTER TABLE couriers         DISABLE ROW LEVEL SECURITY;
ALTER TABLE courier_drops    DISABLE ROW LEVEL SECURITY;
ALTER TABLE notifications    DISABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────────────────
-- MARKET LISTINGS: add 'pending' status
-- ────────────────────────────────────────────────────────────
ALTER TABLE market_listings DROP CONSTRAINT IF EXISTS market_listings_status_check;
ALTER TABLE market_listings ADD CONSTRAINT market_listings_status_check
  CHECK (status IN ('pending','active','sold','cancelled','expired','intercepted'));
