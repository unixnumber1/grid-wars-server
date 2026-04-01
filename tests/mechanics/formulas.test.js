import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getMineIncome, getMineUpgradeCost, getMineCapacity, getMineCountBoost,
  getMineHp, getMineHpRegen, calcAccumulatedCoins, getMineUpgradeCostBulk,
  getAffordableLevels, hqConfig, hqUpgradeCost, xpForLevel, calculateLevel,
  getBuildRadius, getMaxHp, getPlayerAttack, getMineAppearance, getMineEmoji,
  MINE_MAX_LEVEL, HQ_MAX_LEVEL, SMALL_RADIUS, LARGE_RADIUS, BASE_PLAYER_ATTACK, BASE_PLAYER_HP,
  calcMineHpRegen, calcHpRegen,
} from '../../config/formulas.js';

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

  it('lv200 income ~2M/hour', () => {
    const perHour = getMineIncome(200) * 3600;
    assert(perHour > 1500000 && perHour < 3000000, `lv200 income=${perHour}`);
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

  it('lv100+ = 336h capacity', () => {
    const income = Math.floor(50 * Math.pow(120, 2.0));
    const cap = getMineCapacity(120);
    assert.strictEqual(cap, Math.floor(income * 336));
  });
});

describe('getMineCountBoost', () => {
  it('0 mines = x1', () => {
    assert.strictEqual(getMineCountBoost(0), 1);
  });

  it('1000 mines = x2', () => {
    assert.strictEqual(getMineCountBoost(1000), 2);
  });
});

describe('HQ formulas', () => {
  it('hqConfig returns correct maxMines for level 1', () => {
    const cfg = hqConfig(1);
    assert.strictEqual(cfg.maxMines, 10);
    assert.strictEqual(cfg.maxMineLevel, 25);
  });

  it('hqUpgradeCost returns null at max level', () => {
    assert.strictEqual(hqUpgradeCost(10), null);
  });

  it('hqUpgradeCost returns number for valid levels', () => {
    assert.strictEqual(hqUpgradeCost(1), 1000);
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
