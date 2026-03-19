#!/usr/bin/env node
/**
 * Recalculate all monument HP/shield values based on new constants.
 * Run on VPS: node scripts/recalc-monuments.js
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const MONUMENT_HP = [
  0, 50000, 120000, 280000, 600000, 1200000,
  2500000, 5000000, 10000000, 22000000, 40000000,
];
const MONUMENT_SHIELD_HP = [
  0, 8000, 20000, 50000, 120000, 300000,
  700000, 1500000, 3500000, 6000000, 10000000,
];

async function main() {
  const { rows: monuments } = await pool.query('SELECT id, level, phase, shield_hp FROM monuments');
  console.log(`Found ${monuments.length} monuments to recalculate`);

  let updated = 0;
  for (const m of monuments) {
    const level = m.level || 1;
    const newHp = MONUMENT_HP[level] || MONUMENT_HP[1];
    const newMaxShieldHp = MONUMENT_SHIELD_HP[level] || MONUMENT_SHIELD_HP[1];

    // For shield phase: set shield to max. For defeated/open: keep shield at 0
    const newShieldHp = m.phase === 'shield' ? newMaxShieldHp : 0;

    await pool.query(
      `UPDATE monuments SET hp = $1, max_hp = $1, shield_hp = $2, max_shield_hp = $3 WHERE id = $4`,
      [newHp, newShieldHp, newMaxShieldHp, m.id]
    );
    console.log(`  Monument ${m.id} lv${level} (${m.phase}): hp=${newHp}, shield=${newShieldHp}/${newMaxShieldHp}`);
    updated++;
  }

  console.log(`Done. Updated ${updated}/${monuments.length} monuments.`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
