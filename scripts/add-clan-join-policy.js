#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE clans ADD COLUMN IF NOT EXISTS join_policy TEXT DEFAULT 'open';
      CREATE TABLE IF NOT EXISTS clan_requests (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        clan_id UUID NOT NULL,
        player_id UUID NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE(clan_id, player_id)
      );
      CREATE INDEX IF NOT EXISTS idx_clan_requests_clan ON clan_requests(clan_id, status);
    `);
    console.log('[OK] join_policy column + clan_requests table created');
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
