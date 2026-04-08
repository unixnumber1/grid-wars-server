#!/usr/bin/env node
/**
 * Recalculate all item stats: fix corrupted base_attack/base_defense values
 * caused by upgrade writing inflated stats, then re-apply upgrade formula.
 *
 * Logic:
 *   - For each item, look up the valid [min, max] range for its type+rarity+plus
 *   - If base_attack/base_defense is within range → keep it (preserve original roll)
 *   - If base_attack/base_defense is OUT of range (corrupted) → clamp to range midpoint
 *   - Recalculate attack/defense/crit_chance from base × (1 + upgrade_level × 0.09)
 *
 * Run on VPS: node scripts/recalc-items.js
 * Dry run:    node scripts/recalc-items.js --dry
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const DRY_RUN = process.argv.includes('--dry');

// ── Stat ranges per type+rarity+plus (must match game/mechanics/items.js) ──

function _sk(rarity, plus = 0) { return plus > 0 ? `${rarity}_${plus}` : rarity; }

const SWORD_RANGES = {
  common:      { attack: [12, 24],    crit_chance: [2, 4]   },
  uncommon:    { attack: [35, 55],    crit_chance: [4, 7]   },
  rare:        { attack: [75, 115],   crit_chance: [6, 10]  },
  epic:        { attack: [145, 210],  crit_chance: [9, 12]  },
  epic_1:      { attack: [200, 280],  crit_chance: [10, 13] },
  epic_2:      { attack: [270, 365],  crit_chance: [11, 14] },
  mythic:      { attack: [380, 420],  crit_chance: [13, 16] },
  mythic_1:    { attack: [470, 520],  crit_chance: [14, 17] },
  mythic_2:    { attack: [570, 630],  crit_chance: [15, 18] },
  mythic_3:    { attack: [675, 745],  crit_chance: [16, 19] },
  legendary:   { attack: [775, 855],  crit_chance: [17, 20] },
  legendary_1: { attack: [890, 980],  crit_chance: [18, 21] },
  legendary_2: { attack: [1015, 1125],crit_chance: [19, 22] },
  legendary_3: { attack: [1165, 1285],crit_chance: [20, 24] },
};
const AXE_RANGES = {
  common:      { attack: [17, 34]   },
  uncommon:    { attack: [49, 77]   },
  rare:        { attack: [105, 161] },
  epic:        { attack: [203, 294] },
  epic_1:      { attack: [280, 392] },
  epic_2:      { attack: [378, 511] },
  mythic:      { attack: [530, 590]  },
  mythic_1:    { attack: [660, 730]  },
  mythic_2:    { attack: [800, 880]  },
  mythic_3:    { attack: [945, 1045] },
  legendary:   { attack: [1085, 1200] },
  legendary_1: { attack: [1245, 1375] },
  legendary_2: { attack: [1425, 1575] },
  legendary_3: { attack: [1630, 1800] },
};
const SHIELD_RANGES = {
  common:      { defense: [90, 150]     },
  uncommon:    { defense: [240, 370]    },
  rare:        { defense: [510, 790]    },
  epic:        { defense: [1050, 1550]  },
  epic_1:      { defense: [1400, 2050]  },
  epic_2:      { defense: [1850, 2700]  },
  mythic:      { defense: [3750, 4150]  },
  mythic_1:    { defense: [4200, 4650]  },
  mythic_2:    { defense: [4700, 5200]  },
  mythic_3:    { defense: [5250, 5800]  },
  legendary:   { defense: [5850, 6450]  },
  legendary_1: { defense: [6500, 7150]  },
  legendary_2: { defense: [7200, 7900]  },
  legendary_3: { defense: [7950, 8500]  },
};

const STAT_RANGES = { sword: SWORD_RANGES, axe: AXE_RANGES, shield: SHIELD_RANGES };

function getRange(type, rarity, plus) {
  const table = STAT_RANGES[type];
  if (!table) return null;
  const key = _sk(rarity, plus);
  return table[key] || table[rarity] || null;
}

function mid(arr) { return Math.floor((arr[0] + arr[1]) / 2); }

function clampOrKeep(value, range, label, itemId) {
  if (!range) return value;
  const [lo, hi] = range;
  if (value >= lo && value <= hi) return value; // within range, keep original roll
  const fixed = mid(range);
  console.log(`  [${itemId}] ${label}: ${value} out of [${lo},${hi}] → fixed to ${fixed}`);
  return fixed;
}

async function main() {
  const { rows: items } = await pool.query(
    `SELECT id, type, rarity, plus, attack, crit_chance, defense, block_chance,
            base_attack, base_crit_chance, base_defense, upgrade_level, stat_value, owner_id, equipped
     FROM items`
  );
  console.log(`Found ${items.length} items to check${DRY_RUN ? ' (DRY RUN)' : ''}`);

  let updated = 0, corrupted = 0, skipped = 0;

  for (const item of items) {
    const plus = item.plus || 0;
    const range = getRange(item.type, item.rarity, plus);
    if (!range) { skipped++; continue; }

    const lvl = item.upgrade_level || 0;
    const mul = 1 + lvl * 0.09;
    let changed = false;

    let newBaseAttack = item.base_attack || 0;
    let newBaseCrit = item.base_crit_chance || 0;
    let newBaseDefense = item.base_defense || 0;

    if (item.type === 'sword') {
      const oldBase = newBaseAttack;
      newBaseAttack = clampOrKeep(newBaseAttack, range.attack, 'base_attack', item.id);
      newBaseCrit = clampOrKeep(newBaseCrit, range.crit_chance, 'base_crit', item.id);
      if (newBaseAttack !== oldBase || newBaseCrit !== (item.base_crit_chance || 0)) changed = true;
    } else if (item.type === 'axe') {
      const oldBase = newBaseAttack;
      newBaseAttack = clampOrKeep(newBaseAttack, range.attack, 'base_attack', item.id);
      if (newBaseAttack !== oldBase) changed = true;
    } else if (item.type === 'shield') {
      const oldBase = newBaseDefense;
      newBaseDefense = clampOrKeep(newBaseDefense, range.defense, 'base_defense', item.id);
      if (newBaseDefense !== oldBase) changed = true;
    }

    // Recalculate upgraded stats from (possibly fixed) base
    const correctAttack = item.type !== 'shield' ? Math.floor(newBaseAttack * mul) : 0;
    const correctCrit = item.type === 'sword' ? newBaseCrit : 0;
    const correctDefense = item.type === 'shield' ? Math.floor(newBaseDefense * mul) : 0;
    const correctStatValue = item.type === 'shield' ? correctDefense : correctAttack;

    // Check if attack/defense/stat_value need update (even if base was fine, attack might be wrong)
    if (
      (item.attack || 0) !== correctAttack ||
      (item.crit_chance || 0) !== correctCrit ||
      (item.defense || 0) !== correctDefense ||
      (item.stat_value || 0) !== correctStatValue ||
      (item.base_attack || 0) !== newBaseAttack ||
      (item.base_crit_chance || 0) !== newBaseCrit ||
      (item.base_defense || 0) !== newBaseDefense
    ) {
      if (changed) corrupted++;

      if (!DRY_RUN) {
        await pool.query(
          `UPDATE items SET
            base_attack = $1, base_crit_chance = $2, base_defense = $3,
            attack = $4, crit_chance = $5, defense = $6,
            stat_value = $7
          WHERE id = $8`,
          [newBaseAttack, newBaseCrit, newBaseDefense,
           correctAttack, correctCrit, correctDefense,
           correctStatValue, item.id]
        );
      }
      updated++;
    }
  }

  console.log(`\nItems updated: ${updated}, corrupted bases fixed: ${corrupted}, skipped: ${skipped}`);

  if (DRY_RUN) {
    console.log('(DRY RUN — no changes written)');
    await pool.end();
    return;
  }

  // Recalc player bonuses for equipped items
  console.log('\nRecalculating player bonuses for equipped items...');
  const { rows: players } = await pool.query(
    `SELECT DISTINCT p.id, p.level
     FROM players p
     JOIN items i ON i.owner_id = p.id AND i.equipped = true`
  );

  let playerUpdated = 0;
  for (const p of players) {
    const { rows: equipped } = await pool.query(
      'SELECT type, attack, crit_chance, defense, stat_value FROM items WHERE owner_id = $1 AND equipped = true',
      [p.id]
    );

    const weapon = equipped.find(i => i.type === 'sword' || i.type === 'axe');
    const shield = equipped.find(i => i.type === 'shield');

    const bonus_attack = weapon ? (weapon.attack || weapon.stat_value || 0) : 0;
    const bonus_crit = weapon?.type === 'sword' ? (weapon.crit_chance || 0) : 0;
    const bonus_hp = shield ? (shield.defense || shield.stat_value || 0) : 0;
    const max_hp = 1000 + bonus_hp;

    await pool.query(
      'UPDATE players SET bonus_attack = $1, bonus_crit = $2, bonus_hp = $3, max_hp = $4 WHERE id = $5',
      [bonus_attack, bonus_crit, bonus_hp, max_hp, p.id]
    );
    playerUpdated++;
  }

  console.log(`Player bonuses recalculated: ${playerUpdated}`);
  console.log('Done.');
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
