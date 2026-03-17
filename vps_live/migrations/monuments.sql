-- Monuments system — raid bosses on the map

CREATE TABLE monuments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lat FLOAT NOT NULL,
  lng FLOAT NOT NULL,
  cell_id TEXT NOT NULL UNIQUE,
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 10),
  name TEXT NOT NULL,
  hp INTEGER NOT NULL,
  max_hp INTEGER NOT NULL,
  shield_hp INTEGER NOT NULL,
  max_shield_hp INTEGER NOT NULL,
  shield_regen INTEGER NOT NULL,
  phase TEXT NOT NULL DEFAULT 'shield' CHECK (phase IN ('shield','open','defeated')),
  raid_started_at TIMESTAMP,
  shield_broken_at TIMESTAMP,
  respawn_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE monument_raid_damage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  monument_id UUID REFERENCES monuments(id),
  player_id BIGINT REFERENCES players(telegram_id),
  damage_dealt BIGINT DEFAULT 0,
  shield_damage BIGINT DEFAULT 0,
  joined_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE monument_defenders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  monument_id UUID REFERENCES monuments(id),
  emoji TEXT NOT NULL,
  hp INTEGER NOT NULL,
  max_hp INTEGER NOT NULL,
  attack INTEGER NOT NULL,
  wave INTEGER NOT NULL,
  lat FLOAT NOT NULL,
  lng FLOAT NOT NULL,
  alive BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE monument_loot_boxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  monument_id UUID REFERENCES monuments(id),
  player_id BIGINT REFERENCES players(telegram_id),
  player_name TEXT NOT NULL,
  player_avatar TEXT NOT NULL,
  box_type TEXT NOT NULL CHECK (box_type IN ('trophy','gift')),
  monument_level INTEGER NOT NULL,
  gems INTEGER NOT NULL,
  items JSONB NOT NULL DEFAULT '[]',
  opened BOOLEAN DEFAULT false,
  lat FLOAT NOT NULL,
  lng FLOAT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_monuments_phase ON monuments(phase);
CREATE INDEX idx_monument_damage_monument ON monument_raid_damage(monument_id);
CREATE INDEX idx_loot_boxes_player ON monument_loot_boxes(player_id);
CREATE INDEX idx_loot_boxes_expires ON monument_loot_boxes(expires_at);
