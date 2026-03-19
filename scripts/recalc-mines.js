#!/usr/bin/env node
/**
 * Recalculate all mine HP based on the new formula.
 * Preserves HP ratio (current/max stays the same).
 * Run on VPS: node scripts/recalc-mines.js
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// New HP formula — must match config/formulas.js getMineHp
function getMineHp(level) {
  if (level <= 0) return 0;
  return Math.floor(500 * Math.pow(level, 1.3));
}

async function main() {
  const { rows: mines } = await pool.query(
    'SELECT id, level, hp, max_hp FROM mines'
  );
  console.log(`Found ${mines.length} mines to recalculate`);

  let updated = 0;
  for (const mine of mines) {
    const newMaxHp = getMineHp(mine.level);
    if (newMaxHp === 0) continue;

    // Preserve HP ratio
    const oldMax = mine.max_hp || newMaxHp;
    const ratio = Math.min(1, (mine.hp || oldMax) / oldMax);
    const newHp = Math.max(1, Math.floor(newMaxHp * ratio));

    await pool.query(
      'UPDATE mines SET hp = $1, max_hp = $2 WHERE id = $3',
      [newHp, newMaxHp, mine.id]
    );
    updated++;
  }

  console.log(`Done. Updated ${updated}/${mines.length} mines.`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
