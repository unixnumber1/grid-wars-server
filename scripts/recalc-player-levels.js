#!/usr/bin/env node
/**
 * Recalculate all player levels based on the new XP curve.
 * Run on VPS: node scripts/recalc-player-levels.js
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// New XP curve — must match config/formulas.js getXpForLevel
function getXpForLevel(level) {
  if (level <= 0) return 0;
  const phase = Math.floor((level - 1) / 100);
  const levelInPhase = ((level - 1) % 100) + 1;
  const base = 800 * Math.pow(15, phase);
  let xp = Math.floor(base * Math.pow(levelInPhase, 2.15));
  if (level % 100 === 0) xp *= 5;
  return xp;
}

function getLevelFromXp(totalXp) {
  let level = 1;
  let accumulated = 0;
  while (accumulated + getXpForLevel(level) <= totalXp) {
    accumulated += getXpForLevel(level);
    level++;
    if (level > 10000) break;
  }
  return level;
}

async function main() {
  const { rows: players } = await pool.query('SELECT id, xp, level FROM players');
  console.log(`Found ${players.length} players to recalculate`);

  let updated = 0;
  for (const p of players) {
    const newLevel = getLevelFromXp(p.xp ?? 0);
    if (newLevel !== p.level) {
      await pool.query('UPDATE players SET level = $1 WHERE id = $2', [newLevel, p.id]);
      console.log(`  Player ${p.id}: level ${p.level} → ${newLevel} (xp: ${p.xp})`);
      updated++;
    }
  }

  console.log(`Done. Updated ${updated}/${players.length} players.`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
