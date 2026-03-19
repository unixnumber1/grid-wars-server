#!/usr/bin/env node
/**
 * Recalculate all item stats based on new fixed base stats and upgrade formula.
 * Run on VPS: node scripts/recalc-items.js
 */
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// New fixed base stats — must match game/mechanics/items.js
const SWORD_STATS = {
  common:    { attack: 20,  crit_chance: 3  },
  uncommon:  { attack: 50,  crit_chance: 5  },
  rare:      { attack: 110, crit_chance: 8  },
  epic:      { attack: 220, crit_chance: 12 },
  mythic:    { attack: 380, crit_chance: 16 },
  legendary: { attack: 580, crit_chance: 20 },
};
const AXE_STATS = {
  common:    { attack: 28  },
  uncommon:  { attack: 70  },
  rare:      { attack: 150 },
  epic:      { attack: 300 },
  mythic:    { attack: 520 },
  legendary: { attack: 800 },
};
const SHIELD_STATS = {
  common:    { defense: 100  },
  uncommon:  { defense: 250  },
  rare:      { defense: 550  },
  epic:      { defense: 1100 },
  mythic:    { defense: 3800 },
  legendary: { defense: 5800 },
};

function getNewBaseStats(type, rarity) {
  if (type === 'sword') return SWORD_STATS[rarity];
  if (type === 'axe')   return AXE_STATS[rarity];
  if (type === 'shield') return SHIELD_STATS[rarity];
  return null;
}

function getUpgradedStats(type, rarity, baseAttack, baseCrit, baseDefense, blockChance, level) {
  const mul = 1 + level * 0.09;
  const result = { attack: 0, crit_chance: 0, defense: 0, block_chance: blockChance || 0 };

  if (type === 'sword') {
    result.attack = Math.floor(baseAttack * mul);
    result.crit_chance = baseCrit;
  } else if (type === 'axe') {
    result.attack = Math.floor(baseAttack * mul);
  } else if (type === 'shield') {
    result.defense = Math.floor(baseDefense * mul);
    // block_chance keeps existing value for shields (random at generation)
  }
  return result;
}

async function main() {
  const { rows: items } = await pool.query(
    'SELECT id, type, rarity, attack, crit_chance, defense, block_chance, base_attack, base_crit_chance, base_defense, upgrade_level, stat_value, owner_id, equipped FROM items'
  );
  console.log(`Found ${items.length} items to recalculate`);

  let updated = 0;
  let skipped = 0;
  const summary = { sword: 0, axe: 0, shield: 0 };

  for (const item of items) {
    const base = getNewBaseStats(item.type, item.rarity);
    if (!base) { skipped++; continue; }

    const newBaseAttack = base.attack || 0;
    const newBaseCrit = base.crit_chance || 0;
    const newBaseDefense = base.defense || 0;
    const lvl = item.upgrade_level || 0;

    const upgraded = getUpgradedStats(
      item.type, item.rarity,
      newBaseAttack, newBaseCrit, newBaseDefense,
      item.block_chance, lvl
    );

    const statValue = item.type === 'shield' ? upgraded.defense : upgraded.attack;

    await pool.query(
      `UPDATE items SET
        base_attack = $1, base_crit_chance = $2, base_defense = $3,
        attack = $4, crit_chance = $5, defense = $6,
        stat_value = $7
      WHERE id = $8`,
      [newBaseAttack, newBaseCrit, newBaseDefense,
       upgraded.attack, upgraded.crit_chance, upgraded.defense,
       statValue, item.id]
    );

    updated++;
    summary[item.type] = (summary[item.type] || 0) + 1;
  }

  console.log(`\nItems updated: ${updated}, skipped: ${skipped}`);
  console.log(`  Swords: ${summary.sword}, Axes: ${summary.axe}, Shields: ${summary.shield}`);

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
    const max_hp = 1000 + bonus_hp; // BASE_PLAYER_HP = 1000

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
