/**
 * CRAFT SYSTEM MIGRATION
 * 1. Add `plus` column to items table (DEFAULT 0)
 * 2. Reset all upgrade_level to 0
 * 3. Refund all crystals spent on upgrades to players
 *
 * Usage: node scripts/migrate-craft-reset.js
 */

import dotenv from 'dotenv';
dotenv.config();

import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function getUpgradeCost(level) {
  if (level <= 10) return 200;
  if (level <= 20) return 400;
  if (level <= 30) return 800;
  if (level <= 40) return 1600;
  if (level <= 50) return 3000;
  if (level <= 60) return 5000;
  if (level <= 70) return 9000;
  if (level <= 80) return 15000;
  if (level <= 90) return 25000;
  return 40000;
}

function getTotalUpgradeCost(level) {
  let total = 0;
  for (let i = 1; i <= level; i++) total += getUpgradeCost(i);
  return total;
}

async function main() {
  console.log('=== CRAFT SYSTEM MIGRATION ===\n');

  // Step 1: Add plus column
  console.log('Step 1: Adding `plus` column to items table...');
  try {
    await pool.query('ALTER TABLE items ADD COLUMN plus INTEGER NOT NULL DEFAULT 0');
    console.log('  ✓ Column added');
  } catch (e) {
    if (e.message.includes('already exists')) {
      console.log('  ⓘ Column already exists, skipping');
    } else {
      throw e;
    }
  }

  // Step 2: Calculate refunds per player
  console.log('\nStep 2: Calculating crystal refunds...');
  const { rows: upgradedItems } = await pool.query(
    'SELECT owner_id, upgrade_level FROM items WHERE upgrade_level > 0'
  );

  const refunds = new Map(); // owner_id → crystals to refund
  for (const item of upgradedItems) {
    const cost = getTotalUpgradeCost(item.upgrade_level);
    refunds.set(item.owner_id, (refunds.get(item.owner_id) || 0) + cost);
  }

  console.log(`  Found ${upgradedItems.length} upgraded items across ${refunds.size} players`);

  let totalRefunded = 0;
  for (const [ownerId, amount] of refunds) {
    await pool.query('UPDATE players SET crystals = crystals + $1 WHERE id = $2', [amount, ownerId]);
    totalRefunded += amount;
    console.log(`  Player ${ownerId}: +${amount.toLocaleString()} crystals`);
  }
  console.log(`  Total crystals refunded: ${totalRefunded.toLocaleString()}`);

  // Step 3: Reset all upgrade levels and recalc stats to base
  console.log('\nStep 3: Resetting all upgrade_level to 0...');
  const { rowCount } = await pool.query(
    `UPDATE items SET upgrade_level = 0,
     attack = base_attack,
     defense = base_defense,
     crit_chance = base_crit_chance
     WHERE upgrade_level > 0`
  );
  console.log(`  ✓ Reset ${rowCount} items`);

  console.log('\n=== MIGRATION COMPLETE ===');
  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
