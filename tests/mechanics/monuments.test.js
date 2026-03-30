import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MONUMENT_HP, MONUMENT_SHIELD_HP, MONUMENT_SHIELD_REGEN_PER_SEC,
  MONUMENT_GEMS_LOOT, MONUMENT_ITEMS_LOOT, MONUMENT_CORES_LOOT,
  getShieldRegen,
} from '../../config/constants.js';

describe('Monument HP & Shield tables', () => {
  it('has 10 levels of HP', () => {
    for (let lv = 1; lv <= 10; lv++) {
      assert(MONUMENT_HP[lv] > 0, `MONUMENT_HP[${lv}] should be > 0`);
    }
  });

  it('HP increases with level', () => {
    for (let lv = 2; lv <= 10; lv++) {
      assert(MONUMENT_HP[lv] > MONUMENT_HP[lv - 1], `HP lv${lv} > lv${lv - 1}`);
    }
  });

  it('has 10 levels of shield HP', () => {
    for (let lv = 1; lv <= 10; lv++) {
      assert(MONUMENT_SHIELD_HP[lv] > 0, `MONUMENT_SHIELD_HP[${lv}] should be > 0`);
    }
  });

  it('shield HP increases with level', () => {
    for (let lv = 2; lv <= 10; lv++) {
      assert(MONUMENT_SHIELD_HP[lv] > MONUMENT_SHIELD_HP[lv - 1], `Shield HP lv${lv} > lv${lv - 1}`);
    }
  });
});

describe('Shield regen', () => {
  it('has 10 levels of regen', () => {
    for (let lv = 1; lv <= 10; lv++) {
      assert(MONUMENT_SHIELD_REGEN_PER_SEC[lv] > 0, `regen[${lv}] should be > 0`);
    }
  });

  it('regen increases with level', () => {
    for (let lv = 2; lv <= 10; lv++) {
      assert(MONUMENT_SHIELD_REGEN_PER_SEC[lv] >= MONUMENT_SHIELD_REGEN_PER_SEC[lv - 1], `regen lv${lv} >= lv${lv - 1}`);
    }
  });

  it('regen values are multiples of 500', () => {
    for (let lv = 1; lv <= 10; lv++) {
      assert.strictEqual(MONUMENT_SHIELD_REGEN_PER_SEC[lv] % 500, 0, `regen[${lv}]=${MONUMENT_SHIELD_REGEN_PER_SEC[lv]} not multiple of 500`);
    }
  });

  it('getShieldRegen returns correct values', () => {
    assert.strictEqual(getShieldRegen(1), 500);
    assert.strictEqual(getShieldRegen(4), 2000);
    assert.strictEqual(getShieldRegen(10), 17000);
  });

  it('getShieldRegen returns 0 for invalid level', () => {
    assert.strictEqual(getShieldRegen(0), 0);
    assert.strictEqual(getShieldRegen(99), 0);
  });
});

describe('Monument gems loot', () => {
  it('has 10 levels', () => {
    for (let lv = 1; lv <= 10; lv++) {
      const cfg = MONUMENT_GEMS_LOOT[lv];
      assert(cfg, `gems loot[${lv}] missing`);
      assert(cfg.min > 0, `gems min[${lv}] > 0`);
      assert(cfg.max >= cfg.min, `gems max >= min at lv${lv}`);
    }
  });

  it('gem rewards increase with level', () => {
    for (let lv = 2; lv <= 10; lv++) {
      assert(MONUMENT_GEMS_LOOT[lv].max > MONUMENT_GEMS_LOOT[lv - 1].max, `gems lv${lv} > lv${lv - 1}`);
    }
  });
});

describe('Monument items loot (pool system)', () => {
  it('has 10 levels with pool + trophyBonus', () => {
    for (let lv = 1; lv <= 10; lv++) {
      const cfg = MONUMENT_ITEMS_LOOT[lv];
      assert(cfg, `items loot[${lv}] missing`);
      assert(Array.isArray(cfg.pool), `pool[${lv}] should be array`);
      assert(cfg.pool.length > 0, `pool[${lv}] should not be empty`);
      assert(cfg.trophyBonus, `trophyBonus[${lv}] missing`);
      assert(cfg.trophyBonus.count > 0, `trophyBonus count[${lv}] > 0`);
      assert(cfg.trophyBonus.rarity, `trophyBonus rarity[${lv}] missing`);
    }
  });

  it('pool has reasonable item counts per level', () => {
    for (let lv = 1; lv <= 10; lv++) {
      const total = MONUMENT_ITEMS_LOOT[lv].pool.reduce((s, e) => s + e.count, 0);
      assert(total >= 5, `pool total lv${lv}=${total} should be >= 5`);
      assert(total <= 20, `pool total lv${lv}=${total} should be <= 20`);
    }
  });

  it('no trophy/gift keys (old format removed)', () => {
    for (let lv = 1; lv <= 10; lv++) {
      const cfg = MONUMENT_ITEMS_LOOT[lv];
      assert(!cfg.trophy, `lv${lv} should not have trophy (old format)`);
      assert(!cfg.gift, `lv${lv} should not have gift (old format)`);
    }
  });
});

describe('Monument cores loot', () => {
  it('has 10 levels', () => {
    for (let lv = 1; lv <= 10; lv++) {
      const cfg = MONUMENT_CORES_LOOT[lv];
      assert(cfg, `cores loot[${lv}] missing`);
      assert(cfg.chance > 0 && cfg.chance <= 1, `chance[${lv}] in (0,1]`);
      assert(cfg.min >= 1, `min[${lv}] >= 1`);
      assert(cfg.max >= cfg.min, `max >= min at lv${lv}`);
    }
  });

  it('core drop chance increases with level', () => {
    for (let lv = 2; lv <= 10; lv++) {
      assert(MONUMENT_CORES_LOOT[lv].chance >= MONUMENT_CORES_LOOT[lv - 1].chance, `chance lv${lv} >= lv${lv - 1}`);
    }
  });
});
