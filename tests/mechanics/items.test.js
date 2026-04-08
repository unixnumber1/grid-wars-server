import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateItem, getMaxUpgradeLevel, getUpgradeCost, getUpgradedStats,
  rollRarity, rollItem, rollVaseItem, getCraftRecipe,
  ITEM_STATS, ITEM_SELL_PRICE, RARITY_WEIGHTS, RARITY_ORDER,
} from '../../game/mechanics/items.js';

describe('generateItem', () => {
  it('generates sword with correct fields', () => {
    const item = generateItem('sword', 'common');
    assert.strictEqual(item.type, 'sword');
    assert.strictEqual(item.rarity, 'common');
    assert.strictEqual(item.plus, 0);
    assert(item.attack > 0);
    assert(item.crit_chance >= 0);
    assert.strictEqual(item.upgrade_level, 0);
  });

  it('generates axe with correct fields', () => {
    const item = generateItem('axe', 'rare');
    assert.strictEqual(item.type, 'axe');
    assert(item.attack > 0);
    assert.strictEqual(item.crit_chance, 0);
  });

  it('generates shield with defense', () => {
    const item = generateItem('shield', 'epic');
    assert.strictEqual(item.type, 'shield');
    assert(item.defense > 0);
  });

  it('generates sword common in range [12,24]', () => {
    const item = generateItem('sword', 'common');
    assert(item.attack >= 12 && item.attack <= 24, `attack ${item.attack} not in [12,24]`);
    assert(item.crit_chance >= 2 && item.crit_chance <= 4, `crit ${item.crit_chance} not in [2,4]`);
    assert.strictEqual(item.base_attack, item.attack);
  });

  it('generates item with plus tier', () => {
    const item = generateItem('sword', 'epic', 2);
    assert.strictEqual(item.rarity, 'epic');
    assert.strictEqual(item.plus, 2);
    assert(item.attack >= 270 && item.attack <= 365, `epic+2 sword attack ${item.attack} not in [270,365]`);
  });

  it('generates legendary+3 with highest stats', () => {
    const item = generateItem('sword', 'legendary', 3);
    assert.strictEqual(item.plus, 3);
    assert(item.attack >= 1150 && item.attack <= 1300, `lega+3 attack ${item.attack} not in [1150,1300]`);
  });

  it('generates shield with block_chance only at mythic+', () => {
    const epic = generateItem('shield', 'epic');
    assert.strictEqual(epic.block_chance, 0);
    const mythic = generateItem('shield', 'mythic');
    assert(mythic.block_chance >= 10 && mythic.block_chance <= 15);
  });
});

describe('getMaxUpgradeLevel', () => {
  it('common = 10', () => {
    assert.strictEqual(getMaxUpgradeLevel('common'), 10);
  });

  it('legendary = 100', () => {
    assert.strictEqual(getMaxUpgradeLevel('legendary'), 100);
  });

  it('epic+0 = 40, epic+1 = 50, epic+2 = 60', () => {
    assert.strictEqual(getMaxUpgradeLevel('epic', 0), 40);
    assert.strictEqual(getMaxUpgradeLevel('epic', 1), 50);
    assert.strictEqual(getMaxUpgradeLevel('epic', 2), 60);
  });

  it('mythic+3 = 100', () => {
    assert.strictEqual(getMaxUpgradeLevel('mythic', 3), 100);
  });

  it('legendary+3 = 100', () => {
    assert.strictEqual(getMaxUpgradeLevel('legendary', 3), 100);
  });
});

describe('getUpgradeCost', () => {
  it('low levels cost 200 shards', () => {
    assert.strictEqual(getUpgradeCost(1), 200);
    assert.strictEqual(getUpgradeCost(10), 200);
  });

  it('high levels cost 40000 shards', () => {
    assert.strictEqual(getUpgradeCost(91), 40000);
  });
});

describe('getUpgradedStats', () => {
  it('lv0 returns same attack', () => {
    const item = { type: 'sword', rarity: 'common', attack: 10, base_attack: 10, crit_chance: 3, base_crit_chance: 3, upgrade_level: 0 };
    const upgraded = getUpgradedStats(item);
    assert.strictEqual(upgraded.attack, 10);
  });

  it('lv10 increases attack by 90% (x1.9)', () => {
    const item = { type: 'sword', rarity: 'common', attack: 100, base_attack: 100, crit_chance: 5, base_crit_chance: 5, upgrade_level: 10 };
    const upgraded = getUpgradedStats(item);
    assert.strictEqual(upgraded.attack, 190);
  });

  it('crit_chance does not scale with level', () => {
    const item = { type: 'sword', rarity: 'common', attack: 100, base_attack: 100, crit_chance: 5, base_crit_chance: 5, upgrade_level: 10, plus: 0 };
    const upgraded = getUpgradedStats(item);
    assert.strictEqual(upgraded.crit_chance, 5);
  });

  it('respects plus for max level cap', () => {
    const item = { type: 'sword', rarity: 'epic', attack: 200, base_attack: 200, crit_chance: 10, base_crit_chance: 10, upgrade_level: 50, plus: 0 };
    const upgraded = getUpgradedStats(item);
    // epic+0 maxLv=40, so upgrade_level 50 is capped to 40
    assert.strictEqual(upgraded.attack, Math.floor(200 * (1 + 40 * 0.09)));
  });
});

describe('getCraftRecipe', () => {
  it('common → uncommon (basic 3→1)', () => {
    const r = getCraftRecipe('common', 0);
    assert.strictEqual(r.mode, 'basic');
    assert.strictEqual(r.materialCount, 2);
    assert.strictEqual(r.resultRarity, 'uncommon');
    assert.strictEqual(r.resultPlus, 0);
  });

  it('rare → epic (basic)', () => {
    const r = getCraftRecipe('rare', 0);
    assert.strictEqual(r.resultRarity, 'epic');
  });

  it('epic+0 → epic+1 (fusion)', () => {
    const r = getCraftRecipe('epic', 0);
    assert.strictEqual(r.mode, 'fusion');
    assert.strictEqual(r.materialCount, 1);
    assert.strictEqual(r.resultRarity, 'epic');
    assert.strictEqual(r.resultPlus, 1);
  });

  it('epic+2 → mythic (fusion)', () => {
    const r = getCraftRecipe('epic', 2);
    assert.strictEqual(r.resultRarity, 'mythic');
    assert.strictEqual(r.resultPlus, 0);
  });

  it('mythic+3 → legendary (special, 2 materials)', () => {
    const r = getCraftRecipe('mythic', 3);
    assert.strictEqual(r.mode, 'legendary');
    assert.strictEqual(r.materialCount, 2);
    assert.strictEqual(r.materialRarity, 'mythic');
    assert.strictEqual(r.materialPlus, 0);
    assert.strictEqual(r.resultRarity, 'legendary');
  });

  it('legendary+2 → legendary+3', () => {
    const r = getCraftRecipe('legendary', 2);
    assert.strictEqual(r.resultRarity, 'legendary');
    assert.strictEqual(r.resultPlus, 3);
  });

  it('legendary+3 → null (max tier)', () => {
    assert.strictEqual(getCraftRecipe('legendary', 3), null);
  });
});

describe('rollRarity', () => {
  it('returns valid rarity', () => {
    const rarity = rollRarity();
    assert(RARITY_ORDER[rarity], `${rarity} not a valid rarity`);
  });
});

describe('rollItem', () => {
  it('returns item with required fields', () => {
    const item = rollItem();
    assert(item.type);
    assert(item.rarity);
    assert(item.name);
    assert(item.emoji);
  });
});

describe('rollVaseItem', () => {
  it('returns item', () => {
    const item = rollVaseItem();
    assert(item.type);
    assert(item.rarity);
  });
});
