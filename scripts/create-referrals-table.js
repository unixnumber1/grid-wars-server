#!/usr/bin/env node
// Run on VPS: node scripts/create-referrals-table.js
import dotenv from 'dotenv';
dotenv.config();
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        referrer_id BIGINT NOT NULL,
        referred_id BIGINT NOT NULL UNIQUE,
        referrer_rewarded BOOLEAN DEFAULT false,
        referred_rewarded BOOLEAN DEFAULT false,
        level50_rewarded BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
      CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_id);
    `);
    console.log('[OK] Table referrals created');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
