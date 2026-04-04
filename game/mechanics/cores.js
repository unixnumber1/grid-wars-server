// ── Core types and formulas ──────────────────────────────────────────────────
import { MONUMENT_CORES_LOOT } from '../../config/constants.js';

export const CORE_TYPES = {
  income:   { emoji: '✴️', name: 'Ядро дохода',       affects: 'income'   },
  capacity: { emoji: '✳️', name: 'Ядро вместимости',   affects: 'capacity' },
  hp:       { emoji: '❤️', name: 'Ядро здоровья',      affects: 'hp'       },
  regen:    { emoji: '♻️', name: 'Ядро регенерации',   affects: 'regen'    },
};

export const MAX_CORE_SLOTS = 10;

// Slots unlock every 20 mine levels: lv1=1 slot, lv20=2, lv40=3, ... lv180+=10
export function getUnlockedSlots(mineLevel) {
  return Math.min(MAX_CORE_SLOTS, Math.floor((mineLevel || 1) / 20) + 1);
}

// Multiplier per core level: lv0=x1, lv50=x25.5, lv100=x50
// Formula: 1 + level * 0.49
export function getCoreMultiplier(level) {
  if (level <= 0) return 1;
  return Math.round((1 + level * 0.49) * 100) / 100;
}

// Upgrade cost in ether (500K total for lv0→100, smooth steps every 10 levels)
export function getCoreUpgradeCost(level) {
  if (level < 10) return 100;
  if (level < 20) return 200;
  if (level < 30) return 400;
  if (level < 40) return 800;
  if (level < 50) return 1500;
  if (level < 60) return 2500;
  if (level < 70) return 4500;
  if (level < 80) return 7500;
  if (level < 90) return 12500;
  return 20000;
}

// Sell price: lv0 = 10, otherwise 10% of invested ether
export function getCoreSellPrice(level) {
  if (level <= 0) return 10;
  let invested = 0;
  for (let i = 0; i < level; i++) invested += getCoreUpgradeCost(i);
  return Math.max(10, Math.floor(invested * 0.1));
}

// Total boost from all cores of a given type on a mine (additive)
export function getCoresTotalBoost(cores, type) {
  const relevant = cores.filter(c => c.core_type === type);
  if (relevant.length === 0) return 1;
  return 1 + relevant.reduce((sum, c) => sum + (getCoreMultiplier(c.level) - 1), 0);
}

// Core drop config from monument by level (returns { chance, min, max })
export function getCoreDropConfig(monumentLevel) {
  return MONUMENT_CORES_LOOT[monumentLevel] || { chance: 0.10, min: 1, max: 1 };
}

// Random core type (equal probability)
export function randomCoreType() {
  const types = ['income', 'capacity', 'hp', 'regen'];
  return types[Math.floor(Math.random() * types.length)];
}
