import dotenv from 'dotenv';
dotenv.config();
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function migrate() {
  console.log('Starting ore_nodes migration...');

  // 1. Check if crystals column exists on players
  const { data: testPlayer } = await sb.from('players').select('crystals').limit(1);
  if (testPlayer === null) {
    console.log('crystals column may not exist — will try to add via update');
  } else {
    console.log('crystals column exists on players');
  }

  // 2. Try to set default crystals=0 for all players who have null
  const { error: crystalErr } = await sb.from('players').update({ crystals: 0 }).is('crystals', null);
  if (crystalErr) {
    console.error('crystals update error (column may not exist):', crystalErr.message);
    console.log('You need to run: ALTER TABLE players ADD COLUMN crystals INTEGER DEFAULT 0;');
    console.log('Do this via the Supabase Dashboard SQL Editor');
  } else {
    console.log('crystals column initialized');
  }

  // 3. Check if ore_nodes table exists
  const { data: testOre, error: oreErr } = await sb.from('ore_nodes').select('id').limit(1);
  if (oreErr && oreErr.message.includes('does not exist')) {
    console.log('ore_nodes table does not exist');
    console.log('You need to run this SQL in Supabase Dashboard:');
    console.log(`
CREATE TABLE IF NOT EXISTS ore_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lat FLOAT NOT NULL,
  lng FLOAT NOT NULL,
  cell_id TEXT NOT NULL,
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 10),
  hp INTEGER,
  max_hp INTEGER,
  owner_id UUID REFERENCES players(id) ON DELETE SET NULL,
  last_collected TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ore_nodes_owner ON ore_nodes(owner_id);
CREATE INDEX IF NOT EXISTS idx_ore_nodes_expires ON ore_nodes(expires_at);
CREATE INDEX IF NOT EXISTS idx_ore_nodes_cell ON ore_nodes(cell_id);

ALTER TABLE ore_nodes DISABLE ROW LEVEL SECURITY;

-- Also add crystals to players if not exists:
ALTER TABLE players ADD COLUMN IF NOT EXISTS crystals INTEGER DEFAULT 0;
    `);
  } else {
    console.log('ore_nodes table exists (or query succeeded)');
    if (testOre) console.log('ore_nodes rows:', testOre.length);
  }

  console.log('Migration check complete');
}

migrate().catch(e => console.error('Migration error:', e.message));
