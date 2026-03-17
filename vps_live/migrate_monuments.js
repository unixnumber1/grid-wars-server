import dotenv from 'dotenv';
dotenv.config();

// Direct SQL execution via fetch to Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function execSQL(sql) {
  // Use the pg-meta endpoint for raw SQL
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify({}),
  });
  return resp;
}

// Since we can't execute raw SQL via REST, we'll create the tables
// by using a Node.js pg client connecting directly to the database
// Or use the Supabase Management API

// Alternative: Use supabase-js to check and create via workarounds
import { createClient } from '@supabase/supabase-js';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

async function checkTable(name) {
  const { error } = await sb.from(name).select('id').limit(1);
  return !error;
}

async function run() {
  console.log('Checking monuments tables...');

  const exists = await checkTable('monuments');
  if (exists) {
    console.log('monuments table already exists! Migration may already be done.');

    // Check other tables
    for (const t of ['monument_raid_damage', 'monument_defenders', 'monument_loot_boxes']) {
      const e = await checkTable(t);
      console.log(`  ${t}: ${e ? 'EXISTS' : 'NOT EXISTS'}`);
    }
    return;
  }

  console.log('Tables do NOT exist. Please run the following SQL in the Supabase Dashboard SQL Editor:');
  console.log('');
  console.log(`
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
  player_id BIGINT,
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
  player_id BIGINT,
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
  `);
}

run().catch(e => console.error(e));
