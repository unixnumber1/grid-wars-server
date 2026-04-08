#!/usr/bin/env node
/**
 * Migration: Item System v2
 * - Add `plus` column (DEFAULT 0)
 * - Refund ALL upgrade crystals to players
 * - Regenerate item stats with new tables (rarity+0)
 * - Reset bonus_attack/bonus_crit on players
 *
 * Run on VPS: DATABASE_URL=... node scripts/migrate-items-v2.js
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Stat tables from game/mechanics/items.js ──
const SWORD_STATS = {
  common:    { attack: [12, 24],   crit_chance: [2, 4]  },
  uncommon:  { attack: [35, 55],   crit_chance: [4, 7]  },
  rare:      { attack: [75, 115],  crit_chance: [6, 10] },
  epic:      { attack: [145, 210], crit_chance: [9, 12] },
  mythic:    { attack: [350, 450], crit_chance: [13, 16] },
  legendary: { attack: [750, 880], crit_chance: [17, 20] },
};
const AXE_STATS = {
  common:    { attack: [17, 34]   },
  uncommon:  { attack: [49, 77]   },
  rare:      { attack: [105, 161] },
  epic:      { attack: [203, 294] },
  mythic:    { attack: [490, 630] },
  legendary: { attack: [1050, 1232] },
};
const SHIELD_STATS = {
  common:    { defense: [90, 150]    },
  uncommon:  { defense: [240, 370]   },
  rare:      { defense: [510, 790]   },
  epic:      { defense: [1050, 1550] },
  mythic:    { defense: [3500, 5300], block_chance: [12, 20] },
  legendary: { defense: [5400, 8100], block_chance: [22, 30] },
};

function randomInRange(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateStats(type, rarity) {
  if (type === 'sword') {
    const s = SWORD_STATS[rarity]; if (!s) return null;
    const attack = randomInRange(s.attack[0], s.attack[1]);
    const crit_chance = randomInRange(s.crit_chance[0], s.crit_chance[1]);
    return { attack, crit_chance, defense: 0, block_chance: 0, stat_value: attack };
  }
  if (type === 'axe') {
    const s = AXE_STATS[rarity]; if (!s) return null;
    const attack = randomInRange(s.attack[0], s.attack[1]);
    return { attack, crit_chance: 0, defense: 0, block_chance: 0, stat_value: attack };
  }
  if (type === 'shield') {
    const s = SHIELD_STATS[rarity]; if (!s) return null;
    const defense = randomInRange(s.defense[0], s.defense[1]);
    const block_chance = s.block_chance ? randomInRange(s.block_chance[0], s.block_chance[1]) : 0;
    return { attack: 0, crit_chance: 0, defense, block_chance, stat_value: defense };
  }
  return null;
}

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
  const client = await pool.connect();
  try {
    console.log('[migrate] Starting item system v2 migration...\n');

    // ── Step 1: Add plus column ──
    console.log('[migrate] Step 1: Adding plus column...');
    await client.query('ALTER TABLE items ADD COLUMN IF NOT EXISTS plus INTEGER NOT NULL DEFAULT 0');
    console.log('[migrate] ✓ plus column ready\n');

    // ── Step 2: Refund crystals ──
    console.log('[migrate] Step 2: Refunding upgrade crystals...');
    const { rows: upgradedItems } = await client.query(
      'SELECT id, owner_id, upgrade_level FROM items WHERE upgrade_level > 0'
    );
    console.log(`[migrate] Found ${upgradedItems.length} upgraded items`);

    const refundByPlayer = new Map();
    for (const item of upgradedItems) {
      const cost = getTotalUpgradeCost(item.upgrade_level);
      refundByPlayer.set(item.owner_id, (refundByPlayer.get(item.owner_id) || 0) + cost);
    }

    let totalRefunded = 0;
    for (const [playerId, amount] of refundByPlayer) {
      await client.query('UPDATE players SET crystals = COALESCE(crystals, 0) + $1 WHERE id = $2', [amount, playerId]);
      totalRefunded += amount;
      // Get username for log
      const { rows } = await client.query('SELECT game_username FROM players WHERE id = $1', [playerId]);
      console.log(`[migrate]   ${rows[0]?.game_username || playerId}: +${amount} crystals`);
    }
    console.log(`[migrate] ✓ Refunded ${totalRefunded} crystals to ${refundByPlayer.size} players\n`);

    // ── Step 3: Regenerate all item stats ──
    console.log('[migrate] Step 3: Regenerating item stats...');
    const { rows: allItems } = await client.query('SELECT id, type, rarity FROM items');
    console.log(`[migrate] Processing ${allItems.length} items...`);

    let regenerated = 0, skipped = 0;
    for (const item of allItems) {
      const stats = generateStats(item.type, item.rarity);
      if (!stats) { skipped++; continue; }
      await client.query(`
        UPDATE items SET
          attack = $1, crit_chance = $2, defense = $3, block_chance = $4, stat_value = $5,
          base_attack = $1, base_crit_chance = $2, base_defense = $3,
          upgrade_level = 0, plus = 0
        WHERE id = $6
      `, [stats.attack, stats.crit_chance, stats.defense, stats.block_chance, stats.stat_value, item.id]);
      regenerated++;
    }
    console.log(`[migrate] ✓ Regenerated ${regenerated} items (skipped ${skipped})\n`);

    // ── Step 4: Reset player bonuses ──
    console.log('[migrate] Step 4: Resetting player combat bonuses...');
    const { rowCount } = await client.query('UPDATE players SET bonus_attack = 0, bonus_crit = 0');
    console.log(`[migrate] ✓ Reset bonuses for ${rowCount} players\n`);

    console.log('[migrate] ═══════════════════════════════════');
    console.log('[migrate] Migration complete!');
    console.log(`[migrate] Items regenerated: ${regenerated}`);
    console.log(`[migrate] Crystals refunded: ${totalRefunded}`);
    console.log(`[migrate] Players affected: ${refundByPlayer.size}`);
    console.log('[migrate] ═══════════════════════════════════');
  } catch (err) {
    console.error('[migrate] ERROR:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
