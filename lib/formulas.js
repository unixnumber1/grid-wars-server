// ─── Mine formulas ────────────────────────────────────────────────────────────

export const MINE_MAX_LEVEL = 150;

const C0 = 100.0, I0 = 10.0;
const r1 = 1.08, r2 = 1.10, r3 = 1.12;
const a1 = 1.2,  a2 = 1.05, a3 = 0.95;

/** Cost to upgrade a mine TO `level`. Level 0→1 costs 100. */
export function getMineUpgradeCost(level) {
  if (level < 1) return 0;
  let c = C0;
  for (let lvl = 2; lvl <= level; lvl++) {
    if      (lvl - 1 < 50)  c *= r1;
    else if (lvl - 1 < 100) c *= r2;
    else                     c *= r3;
  }
  return Math.round(c);
}

/** Coins per second for a given mine level. Level 0 = 0. */
export function getMineIncome(level) {
  if (level <= 0) return 0;
  if (level <= 50)  return Math.round(I0 * Math.pow(level, a1));
  const A = Math.pow(50, a1 - a2);
  if (level <= 100) return Math.round(I0 * A * Math.pow(level, a2));
  const B = A * Math.pow(100, a2 - a3);
  return Math.round(I0 * B * Math.pow(level, a3));
}

/** Accumulated coins since last_collected ISO string. */
export function calcAccumulatedCoins(level, lastCollectedISO) {
  const elapsed = (Date.now() - new Date(lastCollectedISO).getTime()) / 1000;
  return Math.floor(getMineIncome(level) * Math.max(0, elapsed));
}

// Backward-compat aliases
export const mineRate         = getMineIncome;
export const mineUpgradeCost  = getMineUpgradeCost;

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
  { level: 1,  maxMines: 10,  maxMineLevel: 15,  upgradeCost: 0 },
  { level: 2,  maxMines: 20,  maxMineLevel: 30,  upgradeCost: 5_000 },
  { level: 3,  maxMines: 30,  maxMineLevel: 45,  upgradeCost: 15_000 },
  { level: 4,  maxMines: 40,  maxMineLevel: 60,  upgradeCost: 35_000 },
  { level: 5,  maxMines: 50,  maxMineLevel: 75,  upgradeCost: 70_000 },
  { level: 6,  maxMines: 60,  maxMineLevel: 90,  upgradeCost: 120_000 },
  { level: 7,  maxMines: 70,  maxMineLevel: 105, upgradeCost: 200_000 },
  { level: 8,  maxMines: 80,  maxMineLevel: 120, upgradeCost: 350_000 },
  { level: 9,  maxMines: 90,  maxMineLevel: 135, upgradeCost: 600_000 },
  { level: 10, maxMines: 100, maxMineLevel: 150, upgradeCost: 1_000_000 },
];

export function hqConfig(hqLevel) {
  return HQ_LEVELS[Math.min(Math.max(hqLevel, 1), HQ_MAX_LEVEL) - 1];
}

/** Cost to upgrade HQ from `currentLevel` to `currentLevel + 1`. */
export function hqUpgradeCost(currentLevel) {
  if (currentLevel >= HQ_MAX_LEVEL) return null;
  return HQ_LEVELS[currentLevel].upgradeCost; // index = next level - 1
}

// ─── Mine appearance ──────────────────────────────────────────────────────────

/**
 * Returns { emoji, name } for a mine at the given level (0-150).
 * Level 0 = inactive (not yet upgraded).
 * 15 active tiers, one tier every 10 levels.
 */
export function getMineAppearance(level) {
  if (level <= 0)   return { emoji: '🪨', name: 'Карьер' };
  if (level < 10)   return { emoji: '⛏️',  name: 'Шахта' };
  if (level < 20)   return { emoji: '🏚️',  name: 'Лачуга' };
  if (level < 30)   return { emoji: '🏠',  name: 'Домик' };
  if (level < 40)   return { emoji: '🏡',  name: 'Усадьба' };
  if (level < 50)   return { emoji: '🏘️',  name: 'Посёлок' };
  if (level < 60)   return { emoji: '🏗️',  name: 'Стройка' };
  if (level < 70)   return { emoji: '🏢',  name: 'Офис' };
  if (level < 80)   return { emoji: '🏬',  name: 'Торговый центр' };
  if (level < 90)   return { emoji: '🏭',  name: 'Завод' };
  if (level < 100)  return { emoji: '🏰',  name: 'Замок' };
  if (level < 110)  return { emoji: '🌆',  name: 'Мегаполис' };
  if (level < 120)  return { emoji: '🌇',  name: 'Небоскрёб' };
  if (level < 130)  return { emoji: '🌃',  name: 'Ночной город' };
  if (level < 140)  return { emoji: '🌉',  name: 'Цитадель' };
  if (level < 150)  return { emoji: '🏯',  name: 'Крепость' };
  return                    { emoji: '👑',  name: 'Трон Богов' };
}

/** @deprecated Use getMineAppearance(level).emoji */
export function getMineEmoji(level) {
  return getMineAppearance(level).emoji;
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

// ─── Combat formulas ──────────────────────────────────────────────────────────

/** Max HP for a player at the given level. */
export function getMaxHp(level) {
  return 100 + (level - 1) * 10;
}

/** Base attack damage for a player at the given level. */
export function getPlayerAttack(level) {
  return 10 + (level - 1) * 2;
}

/** HP regen: 1 HP per 10 seconds, capped at maxHp. */
export function calcHpRegen(currentHp, maxHp, lastRegenISO) {
  if (!lastRegenISO || currentHp >= maxHp) return Math.min(currentHp, maxHp);
  const elapsed = (Date.now() - new Date(lastRegenISO).getTime()) / 1000;
  const regen   = Math.floor(elapsed / 10);
  return Math.min(maxHp, currentHp + regen);
}
