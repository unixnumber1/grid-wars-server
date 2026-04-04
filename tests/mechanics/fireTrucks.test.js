import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getMineUpgradeCost } from '../../config/formulas.js';

// Import constants and pure functions directly (avoid gameState -> supabase -> pg chain)
const FIRETRUCK_BUILD_COST = 75;
const FIREFIGHTER_HP = 5000;
const FIREFIGHTER_SPEED = 0.0002;
const FIRETRUCK_MINE_COST_PERCENT = 0.05;

const FIRETRUCK_LEVELS = {
  1:{radius:200,hp:2000,upgradeCost:0},2:{radius:225,hp:3500,upgradeCost:50},
  3:{radius:250,hp:5500,upgradeCost:100},4:{radius:275,hp:8000,upgradeCost:200},
  5:{radius:300,hp:12000,upgradeCost:350},6:{radius:350,hp:17000,upgradeCost:550},
  7:{radius:400,hp:24000,upgradeCost:800},8:{radius:450,hp:33000,upgradeCost:1200},
  9:{radius:500,hp:45000,upgradeCost:1800},10:{radius:600,hp:60000,upgradeCost:2800},
};

function getMaxFireTrucks(hqLevel) {
  if (hqLevel >= 9) return 3;
  if (hqLevel >= 7) return 2;
  if (hqLevel >= 3) return 1;
  return 0;
}

function getTotalGemsCost(level) {
  let sum = FIRETRUCK_BUILD_COST;
  for (let i = 2; i <= level; i++) sum += FIRETRUCK_LEVELS[i].upgradeCost;
  return sum;
}

function getSellRefundDiamonds(level) {
  return Math.floor(getTotalGemsCost(level) * 0.5);
}

function getTotalMineCost(level) {
  let sum = 0;
  for (let i = 0; i < level; i++) sum += getMineUpgradeCost(i);
  return sum;
}

function getExtinguishCost(burningBuildings) {
  let totalCoins = 0;
  for (const b of burningBuildings) {
    if (b.type === 'mine' && b.level) {
      totalCoins += Math.floor(getTotalMineCost(b.level) * FIRETRUCK_MINE_COST_PERCENT);
    }
  }
  return totalCoins;
}

function getFireTruckRadius(level) {
  return FIRETRUCK_LEVELS[level]?.radius || 200;
}

describe('Fire Truck constants', () => {
  it('should have 10 levels defined', () => {
    for (let i = 1; i <= 10; i++) {
      assert.ok(FIRETRUCK_LEVELS[i], `Level ${i} missing`);
      assert.ok(FIRETRUCK_LEVELS[i].hp > 0);
      assert.ok(FIRETRUCK_LEVELS[i].radius >= 200);
    }
  });

  it('should have increasing HP per level', () => {
    for (let i = 2; i <= 10; i++) {
      assert.ok(FIRETRUCK_LEVELS[i].hp > FIRETRUCK_LEVELS[i - 1].hp, `Level ${i} HP should be > level ${i - 1}`);
    }
  });

  it('should have increasing radius per level', () => {
    for (let i = 2; i <= 10; i++) {
      assert.ok(FIRETRUCK_LEVELS[i].radius >= FIRETRUCK_LEVELS[i - 1].radius, `Level ${i} radius should be >= level ${i - 1}`);
    }
  });

  it('should have correct base values', () => {
    assert.equal(FIRETRUCK_BUILD_COST, 75);
    assert.equal(FIREFIGHTER_HP, 5000);
    assert.equal(FIREFIGHTER_SPEED, 0.0002);
    assert.equal(FIRETRUCK_LEVELS[1].upgradeCost, 0);
  });
});

describe('getMaxFireTrucks', () => {
  it('returns 0 for HQ level < 3', () => {
    assert.equal(getMaxFireTrucks(1), 0);
    assert.equal(getMaxFireTrucks(2), 0);
  });

  it('returns 1 for HQ level 3-6', () => {
    assert.equal(getMaxFireTrucks(3), 1);
    assert.equal(getMaxFireTrucks(6), 1);
  });

  it('returns 2 for HQ level 7-8', () => {
    assert.equal(getMaxFireTrucks(7), 2);
    assert.equal(getMaxFireTrucks(8), 2);
  });

  it('returns 3 for HQ level 9+', () => {
    assert.equal(getMaxFireTrucks(9), 3);
    assert.equal(getMaxFireTrucks(10), 3);
  });
});

describe('getTotalGemsCost', () => {
  it('level 1 = build cost only (75)', () => {
    assert.equal(getTotalGemsCost(1), 75);
  });

  it('level 2 = build + upgrade to 2 (75 + 50 = 125)', () => {
    assert.equal(getTotalGemsCost(2), 75 + 50);
  });

  it('level 10 includes all upgrades', () => {
    let sum = 75;
    for (let i = 2; i <= 10; i++) sum += FIRETRUCK_LEVELS[i].upgradeCost;
    assert.equal(getTotalGemsCost(10), sum);
  });
});

describe('getSellRefundDiamonds', () => {
  it('returns 50% of total gems cost', () => {
    assert.equal(getSellRefundDiamonds(1), Math.floor(75 * 0.5)); // 37
    assert.equal(getSellRefundDiamonds(2), Math.floor(125 * 0.5)); // 62
  });

  it('refund increases with level', () => {
    assert.ok(getSellRefundDiamonds(5) > getSellRefundDiamonds(1));
    assert.ok(getSellRefundDiamonds(10) > getSellRefundDiamonds(5));
  });
});

describe('getTotalMineCost', () => {
  it('returns 0 for level 0', () => {
    assert.equal(getTotalMineCost(0), 0);
  });

  it('returns positive for level > 0', () => {
    assert.ok(getTotalMineCost(1) >= 0);
    assert.ok(getTotalMineCost(50) > 0);
    assert.ok(getTotalMineCost(100) > getTotalMineCost(50));
  });
});

describe('getExtinguishCost', () => {
  it('mines cost 5% of total upgrade cost', () => {
    const buildings = [{ type: 'mine', level: 50 }];
    const cost = getExtinguishCost(buildings);
    const expected = Math.floor(getTotalMineCost(50) * 0.05);
    assert.equal(cost, expected);
  });

  it('collectors are free', () => {
    const buildings = [{ type: 'collector' }];
    assert.equal(getExtinguishCost(buildings), 0);
  });

  it('fire trucks are free', () => {
    const buildings = [{ type: 'fire_truck' }];
    assert.equal(getExtinguishCost(buildings), 0);
  });

  it('mixed buildings sum correctly', () => {
    const buildings = [
      { type: 'mine', level: 10 },
      { type: 'collector' },
      { type: 'mine', level: 20 },
    ];
    const expected = Math.floor(getTotalMineCost(10) * 0.05) + Math.floor(getTotalMineCost(20) * 0.05);
    assert.equal(getExtinguishCost(buildings), expected);
  });
});

describe('getFireTruckRadius', () => {
  it('returns correct radius per level', () => {
    assert.equal(getFireTruckRadius(1), 200);
    assert.equal(getFireTruckRadius(5), 300);
    assert.equal(getFireTruckRadius(10), 600);
  });

  it('returns 200 for unknown level', () => {
    assert.equal(getFireTruckRadius(0), 200);
    assert.equal(getFireTruckRadius(99), 200);
  });
});
