import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateItem, getMaxUpgradeLevel, getUpgradeCost, getUpgradedStats,
  rollRarity, rollItem, rollVaseItem,
  ITEM_STATS, ITEM_SELL_PRICE, RARITY_WEIGHTS, RARITY_ORDER,
} from '../../game/mechanics/items.js';

describe('generateItem', () => {
  it('generates sword with correct fields', () => {
    const item = generateItem('sword', 'common');
    assert.strictEqual(item.type, 'sword');
    assert.strictEqual(item.rarity, 'common');
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
});

describe('getMaxUpgradeLevel', () => {
  it('common = 10', () => {
    assert.strictEqual(getMaxUpgradeLevel('common'), 10);
  });

  it('legendary = 100', () => {
    assert.strictEqual(getMaxUpgradeLevel('legendary'), 100);
  });
});

describe('getUpgradeCost', () => {
  it('low levels cost 40 shards', () => {
    assert.strictEqual(getUpgradeCost(1), 40);
    assert.strictEqual(getUpgradeCost(10), 40);
  });

  it('high levels cost 5000 shards', () => {
    assert.strictEqual(getUpgradeCost(91), 5000);
  });
});

describe('getUpgradedStats', () => {
  it('lv0 returns same attack', () => {
    const item = { type: 'sword', rarity: 'common', attack: 10, base_attack: 10, crit_chance: 3, base_crit_chance: 3, upgrade_level: 0 };
    const upgraded = getUpgradedStats(item);
    assert.strictEqual(upgraded.attack, 10);
  });

  it('lv10 increases attack by 10%', () => {
    const item = { type: 'sword', rarity: 'common', attack: 100, base_attack: 100, crit_chance: 5, base_crit_chance: 5, upgrade_level: 10 };
    const upgraded = getUpgradedStats(item);
    assert.strictEqual(upgraded.attack, 110); // 100 * 1.10
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
