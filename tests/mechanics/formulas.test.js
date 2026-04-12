import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getMineIncome, getMineUpgradeCost, getMineCapacity, getMineCountBoost,
  getMineHp, getMineHpRegen, calcAccumulatedCoins, getMineUpgradeCostBulk,
  getAffordableLevels, hqConfig, hqUpgradeCost, xpForLevel, calculateLevel,
  getBuildRadius, getMaxHp, getPlayerAttack, getMineAppearance, getMineEmoji,
  MINE_MAX_LEVEL, HQ_MAX_LEVEL, SMALL_RADIUS, LARGE_RADIUS, BASE_PLAYER_ATTACK, BASE_PLAYER_HP,
  calcMineHpRegen, calcHpRegen, getHqBoostRadius, HQ_BOOST_RADII,
  distanceMultiplier, bowDistanceMultiplier, getDistanceMultiplier,
  getBowPiercingChance, rollBowPiercing,
} from '../../config/formulas.js';

describe('getHqBoostRadius', () => {
  it('returns 100m at level 1', () => {
    assert.strictEqual(getHqBoostRadius(1), 100);
  });
  it('returns 300m at level 10', () => {
    assert.strictEqual(getHqBoostRadius(10), 300);
  });
  it('clamps level below 1 to level 1', () => {
    assert.strictEqual(getHqBoostRadius(0), 100);
    assert.strictEqual(getHqBoostRadius(-5), 100);
    assert.strictEqual(getHqBoostRadius(null), 100);
    assert.strictEqual(getHqBoostRadius(undefined), 100);
  });
  it('clamps level above max to level 10', () => {
    assert.strictEqual(getHqBoostRadius(11), 300);
    assert.strictEqual(getHqBoostRadius(99), 300);
  });
  it('matches the HQ_BOOST_RADII table', () => {
    for (let lv = 1; lv <= 10; lv++) {
      assert.strictEqual(getHqBoostRadius(lv), HQ_BOOST_RADII[lv - 1]);
    }
  });
  it('is monotonically non-decreasing', () => {
    for (let lv = 1; lv < 10; lv++) {
      assert.ok(getHqBoostRadius(lv + 1) >= getHqBoostRadius(lv));
    }
  });
});

describe('Bow distance falloff and piercing', () => {
  it('bowDistanceMultiplier 100% at 0m', () => {
    assert.strictEqual(bowDistanceMultiplier(0, 500), 1);
  });
  it('bowDistanceMultiplier 50% at maxRadius', () => {
    assert.strictEqual(bowDistanceMultiplier(500, 500), 0.5);
  });
  it('bowDistanceMultiplier 75% at half range', () => {
    assert.strictEqual(bowDistanceMultiplier(250, 500), 0.75);
  });
  it('distanceMultiplier 10% at maxRadius (compare melee falloff)', () => {
    // Bow keeps 50% where melee keeps 10% — bow's defining advantage
    assert.ok(Math.abs(distanceMultiplier(500, 500) - 0.1) < 0.001);
  });

  it('getDistanceMultiplier picks bow curve for bow', () => {
    const bow = { type: 'bow' };
    assert.strictEqual(getDistanceMultiplier(bow, 500, 500), 0.5);
  });
  it('getDistanceMultiplier picks melee curve for sword', () => {
    const sword = { type: 'sword' };
    assert.ok(Math.abs(getDistanceMultiplier(sword, 500, 500) - 0.1) < 0.001);
  });
  it('getDistanceMultiplier picks melee curve for null weapon (fist)', () => {
    assert.ok(Math.abs(getDistanceMultiplier(null, 500, 500) - 0.1) < 0.001);
  });

  it('getBowPiercingChance 0 for non-bow', () => {
    assert.strictEqual(getBowPiercingChance({ type: 'sword', rarity: 'mythic', upgrade_level: 50 }), 0);
    assert.strictEqual(getBowPiercingChance(null), 0);
  });
  it('getBowPiercingChance 0 for common bow', () => {
    assert.strictEqual(getBowPiercingChance({ type: 'bow', rarity: 'common', upgrade_level: 0 }), 0);
  });
  it('getBowPiercingChance ~8 for fresh mythic bow', () => {
    assert.strictEqual(getBowPiercingChance({ type: 'bow', rarity: 'mythic', upgrade_level: 0 }), 8);
  });
  it('getBowPiercingChance ~18 for fully upgraded mythic bow', () => {
    assert.strictEqual(getBowPiercingChance({ type: 'bow', rarity: 'mythic', upgrade_level: 100 }), 18);
  });
  it('getBowPiercingChance ~28 for fully upgraded legendary bow', () => {
    assert.strictEqual(getBowPiercingChance({ type: 'bow', rarity: 'legendary', upgrade_level: 100 }), 28);
  });

  it('rollBowPiercing returns false for non-bow', () => {
    // Run many times to be sure
    for (let i = 0; i < 100; i++) {
      assert.strictEqual(rollBowPiercing({ type: 'sword', rarity: 'mythic', upgrade_level: 50 }), false);
    }
  });
  it('rollBowPiercing returns false when piercing_chance=0', () => {
    for (let i = 0; i < 100; i++) {
      assert.strictEqual(rollBowPiercing({ type: 'bow', rarity: 'common', upgrade_level: 0 }), false);
    }
  });
  it('rollBowPiercing eventually triggers for high-piercing bow', () => {
    let triggered = false;
    for (let i = 0; i < 1000 && !triggered; i++) {
      if (rollBowPiercing({ type: 'bow', rarity: 'legendary', upgrade_level: 100 })) triggered = true;
    }
    assert.ok(triggered, '28% chance should trigger at least once in 1000 rolls');
  });
});

describe('Constants', () => {
  it('exports correct constant values', () => {
    assert.strictEqual(MINE_MAX_LEVEL, 200);
    assert.strictEqual(HQ_MAX_LEVEL, 10);
    assert.strictEqual(SMALL_RADIUS, 200);
    assert.strictEqual(LARGE_RADIUS, 500);
    assert.strictEqual(BASE_PLAYER_ATTACK, 10);
    assert.strictEqual(BASE_PLAYER_HP, 1000);
  });
});

describe('getMineIncome', () => {
  it('returns 0 for level 0', () => {
    assert.strictEqual(getMineIncome(0), 0);
  });

  it('lv1 income ≈ 50/hour', () => {
    const perHour = getMineIncome(1) * 3600;
    assert.strictEqual(Math.round(perHour), 50);
  });

  it('lv100 income ~500K/hour', () => {
    const perHour = getMineIncome(100) * 3600;
    assert(perHour > 400000 && perHour < 600000, `lv100 income=${perHour}`);
  });

  it('lv200 income ~1.25M/hour (half growth after 100)', () => {
    const perHour = getMineIncome(200) * 3600;
    assert(perHour > 1200000 && perHour < 1300000, `lv200 income=${perHour}`);
  });
});

describe('getMineHp', () => {
  it('returns 0 for level 0', () => {
    assert.strictEqual(getMineHp(0), 0);
  });

  it('lv1 HP = 500', () => {
    assert.strictEqual(getMineHp(1), 500);
  });

  it('HP increases with level', () => {
    assert(getMineHp(50) > getMineHp(10));
    assert(getMineHp(100) > getMineHp(50));
    assert(getMineHp(200) > getMineHp(100));
  });
});

describe('getMineHpRegen', () => {
  it('returns 0 for level 0', () => {
    assert.strictEqual(getMineHpRegen(0), 0);
  });

  it('regen = 25% of max HP', () => {
    const maxHp = getMineHp(10);
    const regen = getMineHpRegen(10);
    assert.strictEqual(regen, Math.max(1, Math.floor(maxHp * 0.25)));
  });
});

describe('getMineUpgradeCost', () => {
  it('returns 0 for level 0', () => {
    assert.strictEqual(getMineUpgradeCost(0), 0);
  });

  it('lv1 cost ≈ 998', () => {
    assert.strictEqual(getMineUpgradeCost(1), 998);
  });

  it('cost increases with level', () => {
    assert(getMineUpgradeCost(50) > getMineUpgradeCost(10));
    assert(getMineUpgradeCost(100) > getMineUpgradeCost(50));
  });
});

describe('getMineCapacity', () => {
  it('low level = 168h capacity', () => {
    const income = Math.floor(50 * Math.pow(10, 2.0));
    const cap = getMineCapacity(10);
    assert.strictEqual(cap, Math.floor(income * 168));
  });

  it('lv100+ = 336h capacity (half growth)', () => {
    const incomePerHour = Math.floor(getMineIncome(120) * 3600);
    const cap = getMineCapacity(120);
    assert.strictEqual(cap, Math.floor(incomePerHour * 336));
  });
});

describe('getMineCountBoost', () => {
  it('0 points = x1', () => {
    assert.strictEqual(getMineCountBoost(0), 1);
  });

  it('600 points (spam lv1) = x1 (no boost)', () => {
    assert.strictEqual(getMineCountBoost(600), 1);
  });

  it('1000 points = +1%', () => {
    assert.strictEqual(getMineCountBoost(1000), 1.01);
  });

  it('15000 points (600 mines lv25) = +15%', () => {
    assert.strictEqual(getMineCountBoost(15000), 1.15);
  });

  it('150000 points (3000 mines lv50) = +150%', () => {
    assert.strictEqual(getMineCountBoost(150000), 2.5);
  });
});

describe('HQ formulas', () => {
  it('hqConfig returns correct config for level 1', () => {
    const cfg = hqConfig(1);
    assert.strictEqual(cfg.upgradeCost, 0);
  });

  it('hqUpgradeCost returns null at max level', () => {
    assert.strictEqual(hqUpgradeCost(10), null);
  });

  it('hqUpgradeCost returns number for valid levels', () => {
    assert.strictEqual(hqUpgradeCost(1), 10000);
  });
});

describe('XP/Level system', () => {
  it('xpForLevel(1) = 80', () => {
    assert.strictEqual(xpForLevel(1), 80);
  });

  it('calculateLevel returns 1 for 0 xp', () => {
    assert.strictEqual(calculateLevel(0), 1);
  });

  it('calculateLevel returns 2 for 80+ xp', () => {
    assert.strictEqual(calculateLevel(80), 2);
  });

  it('xpForLevel monotonically increases within phase', () => {
    assert(xpForLevel(50) > xpForLevel(10));
    assert(xpForLevel(99) > xpForLevel(50));
    assert(xpForLevel(100) > xpForLevel(99));
  });
});

describe('Player combat formulas', () => {
  it('getMaxHp returns 1000', () => {
    assert.strictEqual(getMaxHp(1), 1000);
  });

  it('getPlayerAttack returns 10', () => {
    assert.strictEqual(getPlayerAttack(1), 10);
  });

  it('getBuildRadius returns SMALL_RADIUS', () => {
    assert.strictEqual(getBuildRadius(1), 200);
  });
});

describe('getMineAppearance', () => {
  it('returns emoji and name', () => {
    const app = getMineAppearance(1);
    assert(app.emoji);
    assert(app.name);
  });

  it('getMineEmoji returns emoji', () => {
    assert.strictEqual(getMineEmoji(1), getMineAppearance(1).emoji);
  });
});

describe('calcMineHpRegen', () => {
  it('returns maxHp when already full', () => {
    assert.strictEqual(calcMineHpRegen(1000, 1000, 250, new Date().toISOString()), 1000);
  });

  it('returns capped at maxHp', () => {
    const result = calcMineHpRegen(900, 1000, 360000, new Date(Date.now() - 10000).toISOString());
    assert(result <= 1000);
  });
});

describe('calcAccumulatedCoins', () => {
  it('returns 0 for level 0', () => {
    assert.strictEqual(calcAccumulatedCoins(0, new Date().toISOString()), 0);
  });

  it('returns capped at capacity', () => {
    const coins = calcAccumulatedCoins(1, new Date(Date.now() - 999999999).toISOString());
    assert(coins <= getMineCapacity(1));
  });
});
