// ── Core types and formulas ──────────────────────────────────────────────────

export const CORE_TYPES = {
  income:   { emoji: '✴️', name: 'Ядро дохода',       affects: 'income'   },
  capacity: { emoji: '✳️', name: 'Ядро вместимости',   affects: 'capacity' },
  hp:       { emoji: '❤️', name: 'Ядро здоровья',      affects: 'hp'       },
  regen:    { emoji: '♻️', name: 'Ядро регенерации',   affects: 'regen'    },
};

export const MAX_CORE_SLOTS = 10;

// Multiplier per core level: lv0=x1, lv50=x25.5, lv100=x50
// Formula: 1 + level * 0.49
export function getCoreMultiplier(level) {
  if (level <= 0) return 1;
  return Math.round((1 + level * 0.49) * 100) / 100;
}

// Upgrade cost in ether
export function getCoreUpgradeCost(level) {
  if (level <= 10)  return 100;
  if (level <= 25)  return 400;
  if (level <= 50)  return 1500;
  if (level <= 75)  return 5000;
  if (level <= 90)  return 20000;
  return 53000;
}

// Total boost from all cores of a given type on a mine (additive)
export function getCoresTotalBoost(cores, type) {
  const relevant = cores.filter(c => c.core_type === type);
  if (relevant.length === 0) return 1;
  return relevant.reduce((sum, c) => sum + getCoreMultiplier(c.level), 0);
}

// Drop chance from monument by level
export function getCoreDropChance(monumentLevel) {
  const chances = { 1:0.02, 2:0.03, 3:0.05, 4:0.10, 5:0.12, 6:0.15, 7:0.20, 8:0.25, 9:0.30, 10:0.40 };
  return chances[monumentLevel] || 0.02;
}

// Random core type (equal probability)
export function randomCoreType() {
  const types = ['income', 'capacity', 'hp', 'regen'];
  return types[Math.floor(Math.random() * types.length)];
}
