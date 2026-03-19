import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CORE_TYPES, MAX_CORE_SLOTS,
  getCoreMultiplier, getCoreUpgradeCost, getCoresTotalBoost,
  getCoreDropConfig, randomCoreType,
} from '../../game/mechanics/cores.js';

describe('Core types', () => {
  it('has 4 core types', () => {
    assert.strictEqual(Object.keys(CORE_TYPES).length, 4);
    assert(CORE_TYPES.income);
    assert(CORE_TYPES.capacity);
    assert(CORE_TYPES.hp);
    assert(CORE_TYPES.regen);
  });

  it('MAX_CORE_SLOTS = 10', () => {
    assert.strictEqual(MAX_CORE_SLOTS, 10);
  });
});

describe('getCoreMultiplier', () => {
  it('lv0 = x1', () => {
    assert.strictEqual(getCoreMultiplier(0), 1);
  });

  it('lv50 = x25.5', () => {
    assert.strictEqual(getCoreMultiplier(50), 25.5);
  });

  it('lv100 = x50', () => {
    assert.strictEqual(getCoreMultiplier(100), 50);
  });

  it('multiplier increases with level', () => {
    assert(getCoreMultiplier(50) > getCoreMultiplier(10));
    assert(getCoreMultiplier(100) > getCoreMultiplier(50));
  });
});

describe('getCoreUpgradeCost', () => {
  it('low levels cost 100 ether', () => {
    assert.strictEqual(getCoreUpgradeCost(0), 100);
    assert.strictEqual(getCoreUpgradeCost(5), 100);
  });

  it('high levels cost 53000 ether', () => {
    assert.strictEqual(getCoreUpgradeCost(95), 53000);
  });
});

describe('getCoresTotalBoost', () => {
  it('returns 1 with no cores', () => {
    assert.strictEqual(getCoresTotalBoost([], 'income'), 1);
  });

  it('returns sum of multipliers for matching cores', () => {
    const cores = [
      { core_type: 'income', level: 0 },
      { core_type: 'income', level: 0 },
    ];
    const boost = getCoresTotalBoost(cores, 'income');
    assert.strictEqual(boost, 2); // 1 + 1
  });

  it('ignores non-matching core types', () => {
    const cores = [
      { core_type: 'hp', level: 0 },
    ];
    assert.strictEqual(getCoresTotalBoost(cores, 'income'), 1);
  });
});

describe('getCoreDropConfig', () => {
  it('lv1 = 10% chance, 1 core', () => {
    const cfg = getCoreDropConfig(1);
    assert.strictEqual(cfg.chance, 0.10);
    assert.strictEqual(cfg.min, 1);
    assert.strictEqual(cfg.max, 1);
  });

  it('lv10 = 95% chance, 3-5 cores', () => {
    const cfg = getCoreDropConfig(10);
    assert.strictEqual(cfg.chance, 0.95);
    assert.strictEqual(cfg.min, 3);
    assert.strictEqual(cfg.max, 5);
  });

  it('returns default for invalid level', () => {
    const cfg = getCoreDropConfig(99);
    assert.strictEqual(cfg.chance, 0.10);
  });
});

describe('randomCoreType', () => {
  it('returns valid core type', () => {
    const type = randomCoreType();
    assert(CORE_TYPES[type], `${type} is not a valid core type`);
  });
});
