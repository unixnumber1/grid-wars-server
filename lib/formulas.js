// ─── Mine formulas ────────────────────────────────────────────────────────────

export const MINE_MAX_LEVEL = 100;

/** Coins per second for a given mine level (1-based). */
export function mineRate(level) {
  return Math.floor(Math.pow(1.15, level - 1));
}

/** Cost to upgrade a mine FROM `level` TO `level + 1`. Level 1 is free. */
export function mineUpgradeCost(level) {
  if (level <= 1) return 0;
  return Math.floor(50 * Math.pow(2.1, level - 1));
}

/** Accumulated coins since last_collected ISO string. */
export function calcAccumulatedCoins(level, lastCollectedISO) {
  const elapsed = (Date.now() - new Date(lastCollectedISO).getTime()) / 1000;
  return Math.floor(mineRate(level) * Math.max(0, elapsed));
}

// ─── Headquarters formulas ────────────────────────────────────────────────────

export const HQ_MAX_LEVEL = 10;
export const HQ_COIN_LIMIT = 10000; // kept for legacy imports

const HQ_LIMITS = [10_000, 25_000, 50_000, 100_000, 200_000, 400_000, 700_000, 1_200_000, 2_000_000, 5_000_000];

/** Max coins the HQ can hold at a given level. */
export function getHQLimit(hqLevel) {
  return HQ_LIMITS[Math.min(Math.max(hqLevel, 1), HQ_MAX_LEVEL) - 1];
}

/**
 * HQ level config table.
 * maxMines  — how many mines the player may own simultaneously
 * maxMineLevel — highest mine level the player can upgrade to
 * upgradeCost  — coins required to reach this HQ level (0 = starting level)
 */
const HQ_LEVELS = [
  { level: 1,  maxMines: 10,  maxMineLevel: 10,  upgradeCost: 0 },
  { level: 2,  maxMines: 20,  maxMineLevel: 20,  upgradeCost: 5_000 },
  { level: 3,  maxMines: 30,  maxMineLevel: 30,  upgradeCost: 15_000 },
  { level: 4,  maxMines: 40,  maxMineLevel: 40,  upgradeCost: 35_000 },
  { level: 5,  maxMines: 50,  maxMineLevel: 50,  upgradeCost: 70_000 },
  { level: 6,  maxMines: 60,  maxMineLevel: 60,  upgradeCost: 120_000 },
  { level: 7,  maxMines: 70,  maxMineLevel: 70,  upgradeCost: 200_000 },
  { level: 8,  maxMines: 80,  maxMineLevel: 80,  upgradeCost: 350_000 },
  { level: 9,  maxMines: 90,  maxMineLevel: 90,  upgradeCost: 600_000 },
  { level: 10, maxMines: 100, maxMineLevel: 100, upgradeCost: 1_000_000 },
];

export function hqConfig(hqLevel) {
  return HQ_LEVELS[Math.min(Math.max(hqLevel, 1), HQ_MAX_LEVEL) - 1];
}

/** Cost to upgrade HQ from `currentLevel` to `currentLevel + 1`. */
export function hqUpgradeCost(currentLevel) {
  if (currentLevel >= HQ_MAX_LEVEL) return null;
  return HQ_LEVELS[currentLevel].upgradeCost; // index = next level - 1
}

// ─── Mine skin ────────────────────────────────────────────────────────────────

const MINE_EMOJIS = ['🏠','🏡','🏘️','🏗️','🏢','🏬','🏭','🏰','🌆','🌇'];

/** Emoji for a mine based on its level (1-100). */
export function getMineEmoji(level) {
  const tier = Math.min(Math.floor((level - 1) / 10), 9);
  return MINE_EMOJIS[tier];
}

// ─── Player level system ──────────────────────────────────────────────────────

/** XP required to go from level N to level N+1. */
export function xpForLevel(level) {
  return Math.floor(100 * Math.pow(level, 1.9));
}

/** Compute current level from total accumulated XP. */
export function calculateLevel(currentXp) {
  let level = 1;
  let totalXp = 0;
  while (totalXp + xpForLevel(level) <= currentXp) {
    totalXp += xpForLevel(level);
    level++;
  }
  return level;
}

/** Mine build radius in metres based on player level. */
export function getBuildRadius(level) {
  if (level >= 100) return 1500;
  if (level >= 50)  return 1000;
  if (level >= 30)  return 800;
  if (level >= 20)  return 700;
  if (level >= 10)  return 600;
  if (level >= 5)   return 550;
  return 500;
}

// ─── Allowed avatars ──────────────────────────────────────────────────────────

export const ALLOWED_AVATARS = [
  '🐱','🐯','🦁','🐻','🐼','🐨','🐶','🦊','🐺','🦝',
  '🐭','🐹','🐰','🦔','🐸','🐮','🐷','🐗','🦅','🦆',
  '🦉','🐧','🐦','🦚','🦜','🐤','🐲','🦋','🐠','🦈',
  '🐙','🦑','🦎','🐊','🐻‍❄️','🦦','🦥','🦘','🦙','🐑',
  '🐿️','🦫','🦬','🦣','🦩','🦤',
];
