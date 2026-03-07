// ─── Mine formulas ────────────────────────────────────────────────────────────

export const MINE_MAX_LEVEL = 150;

/** Cost to upgrade FROM `level` to `level+1`. Level 0 = activation (100 coins). */
export function getMineUpgradeCost(level) {
  if (level === 0) return 100; // активация
  const BASE_COST = 100;
  const r = 1.09;
  return Math.round(BASE_COST * Math.pow(r, level));
}

/** Coins per second at `level`. Level 0 = inactive = 0. */
export function getMineIncome(level) {
  if (level === 0) return 0;
  // Original: Math.round(10 * level^1.2) — divided by 100 for balance
  return Math.round(10 * Math.pow(level, 1.2)) / 100;
}

/** Max coins a mine can hold at `level` = 1 hour of income. */
export function getMineCapacity(level) {
  if (level === 0) return 0;
  return Math.floor(getMineIncome(level) * 3600);
}

/** Accumulated coins since last_collected ISO string, capped at 1-hour capacity. */
export function calcAccumulatedCoins(level, lastCollectedISO) {
  if (level === 0) return 0;
  const elapsed = (Date.now() - new Date(lastCollectedISO).getTime()) / 1000;
  const raw = Math.floor(getMineIncome(level) * Math.max(0, elapsed));
  return Math.min(raw, getMineCapacity(level));
}

/** Total cost to upgrade `count` levels starting from `currentLevel`. */
export function getMineUpgradeCostBulk(currentLevel, count) {
  let total = 0;
  for (let i = 0; i < count; i++) {
    total += getMineUpgradeCost(currentLevel + i);
  }
  return total;
}

/**
 * How many levels can be afforded (up to 10) within `balance`,
 * not exceeding `maxLevel`. Returns { count, totalCost }.
 */
export function getAffordableLevels(currentLevel, maxLevel, balance) {
  let total = 0;
  let count = 0;
  for (let i = 0; i < 10; i++) {
    const next = currentLevel + i + 1;
    if (next > maxLevel) break;
    const cost = getMineUpgradeCost(currentLevel + i);
    if (total + cost > balance) break;
    total += cost;
    count++;
  }
  return { count, totalCost: total };
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
  if (level < 10)  return { emoji: '🪨', name: 'Каменный алтарь' };
  if (level < 20)  return { emoji: '🔮', name: 'Магический колодец' };
  if (level < 30)  return { emoji: '🌿', name: 'Друидическая роща' };
  if (level < 40)  return { emoji: '🔥', name: 'Огненный маяк' };
  if (level < 50)  return { emoji: '⚗️', name: 'Алхимическая башня' };
  if (level < 60)  return { emoji: '🌀', name: 'Портал разлома' };
  if (level < 70)  return { emoji: '🏯', name: 'Тёмная цитадель' };
  if (level < 80)  return { emoji: '💎', name: 'Кристальный шпиль' };
  if (level < 90)  return { emoji: '🌙', name: 'Лунный обелиск' };
  if (level < 100) return { emoji: '⭐', name: 'Звёздный Nexus' };
  if (level < 110) return { emoji: '🌌', name: 'Астральный разлом' };
  if (level < 120) return { emoji: '👁️', name: 'Глаз Вечности' };
  if (level < 130) return { emoji: '🐉', name: 'Драконье гнездо' };
  if (level < 140) return { emoji: '☄️', name: 'Метеоритный кратер' };
  if (level < 150) return { emoji: '🌋', name: 'Вулканический трон' };
  return                   { emoji: '👑', name: 'Трон Богов' };
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
  let radius;
  if (level >= 100) radius = 750;
  else if (level >= 50)  radius = 500;
  else if (level >= 30)  radius = 400;
  else if (level >= 20)  radius = 350;
  else if (level >= 10)  radius = 300;
  else if (level >= 5)   radius = 275;
  else                   radius = 250;
  console.log('[getBuildRadius] level:', level, 'radius:', radius);
  return radius;
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
  const regen   = Math.floor(elapsed); // 1 HP per second
  return Math.min(maxHp, currentHp + regen);
}
