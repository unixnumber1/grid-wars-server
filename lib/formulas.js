// ─── Mine formulas ────────────────────────────────────────────────────────────

export const MINE_MAX_LEVEL = 250;

/**
 * Cost to upgrade FROM `level` to `level+1` (real coins).
 * Five exponential tiers; milestone x4 every 10 levels.
 */
export function getMineUpgradeCost(level) {
  function base(l) {
    if (l <= 50)  return 100 * Math.pow(1.21, l - 1);
    const e1 = 100 * Math.pow(1.21, 49);
    if (l <= 100) return e1 * 5 * Math.pow(1.15, l - 51);
    const e2 = e1 * 5 * Math.pow(1.15, 49);
    if (l <= 150) return e2 * 8 * Math.pow(1.13, l - 101);
    const e3 = e2 * 8 * Math.pow(1.13, 49);
    if (l <= 200) return e3 * 12 * Math.pow(1.12, l - 151);
    const e4 = e3 * 12 * Math.pow(1.12, 49);
    return e4 * 20 * Math.pow(1.11, l - 201);
  }
  let cost = base(level);
  // Каждые 10 уровней (смена иконки) — x4 (на 9, 19, 29...)
  if (level >= 9 && level % 10 === 9) cost *= 4;
  // Кап — не превышать BIGINT
  return Math.min(Math.round(cost), 9_000_000_000_000_000_000);
}

/** Real coins per hour at `level`. Level 0 = inactive = 0. */
export function getMineIncome(level) {
  if (level === 0) return 0;
  function getPayback(l) {
    if (l <= 50)  return 3600 * Math.pow(6, (l - 1) / 49);
    if (l <= 100) return 21600 * Math.pow(12, (l - 50) / 50);
    if (l <= 150) return 259200 * Math.pow(4.67, (l - 100) / 50);
    if (l <= 200) return 1209600 * Math.pow(4.29, (l - 150) / 50);
    return 5184000 * Math.pow(6.08, (l - 200) / 50);
  }
  const cost = getMineUpgradeCost(level);
  return Math.max(1, Math.round(cost / getPayback(level)));
}

/** Max real coins a mine can hold at `level` (3–6 days of income). */
export function getMineCapacity(level) {
  if (level === 0) return 0;
  const days = level <= 100 ? 6 : level <= 150 ? 5 : level <= 200 ? 4 : 3;
  return Math.round(getMineIncome(level) * days * 86400);
}

/**
 * Accumulated real coins since last_collected ISO string,
 * capped at capacity.
 */
export function calcAccumulatedCoins(level, lastCollectedISO) {
  if (level === 0) return 0;
  const elapsedSec = (Date.now() - new Date(lastCollectedISO).getTime()) / 1000;
  const raw = getMineIncome(level) * Math.max(0, elapsedSec);
  return Math.min(Math.round(raw), getMineCapacity(level));
}

/** Total real cost to upgrade `count` levels starting from `currentLevel`. */
export function getMineUpgradeCostBulk(currentLevel, count) {
  let total = 0;
  for (let i = 0; i < count; i++) {
    total += getMineUpgradeCost(currentLevel + i);
  }
  return total;
}

/**
 * How many levels can be afforded (up to 10) within `balance` (real),
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
export const mineRate        = getMineIncome;
export const mineUpgradeCost = getMineUpgradeCost;

// ─── Headquarters formulas ────────────────────────────────────────────────────

export const HQ_MAX_LEVEL  = 10;
export const HQ_COIN_LIMIT = 1_000_000; // kept for legacy imports (real, L1)

// Real coin caps per HQ level (powers of 10, 1M → ~1 quintillion)
const HQ_LIMITS = [
  1_000_000,           // L1:  1M
  10_000_000,          // L2:  10M
  100_000_000,         // L3:  100M
  1_000_000_000,       // L4:  1B
  10_000_000_000,      // L5:  10B
  100_000_000_000,     // L6:  100B
  1_000_000_000_000,   // L7:  1T
  10_000_000_000_000,  // L8:  10T
  100_000_000_000_000, // L9:  100T
  1e18,                // L10: effectively unlimited
];

/** Real coin cap for the HQ at a given level. */
export function getHQLimit(hqLevel) {
  return HQ_LIMITS[Math.min(Math.max(hqLevel, 1), HQ_MAX_LEVEL) - 1];
}

const HQ_LEVELS = [
  { level: 1,  maxMines: 10,  maxMineLevel: 25,  upgradeCost: 0 },
  { level: 2,  maxMines: 20,  maxMineLevel: 50,  upgradeCost: 5_000 },
  { level: 3,  maxMines: 30,  maxMineLevel: 75,  upgradeCost: 50_000 },
  { level: 4,  maxMines: 40,  maxMineLevel: 100, upgradeCost: 500_000 },
  { level: 5,  maxMines: 50,  maxMineLevel: 125, upgradeCost: 5_000_000 },
  { level: 6,  maxMines: 60,  maxMineLevel: 150, upgradeCost: 50_000_000 },
  { level: 7,  maxMines: 70,  maxMineLevel: 175, upgradeCost: 500_000_000 },
  { level: 8,  maxMines: 80,  maxMineLevel: 200, upgradeCost: 5_000_000_000 },
  { level: 9,  maxMines: 90,  maxMineLevel: 225, upgradeCost: 50_000_000_000 },
  { level: 10, maxMines: 100, maxMineLevel: 250, upgradeCost: 500_000_000_000 },
];

export function hqConfig(hqLevel) {
  return HQ_LEVELS[Math.min(Math.max(hqLevel, 1), HQ_MAX_LEVEL) - 1];
}

/** Real cost to upgrade HQ from `currentLevel` to `currentLevel + 1`. */
export function hqUpgradeCost(currentLevel) {
  if (currentLevel >= HQ_MAX_LEVEL) return null;
  return HQ_LEVELS[currentLevel].upgradeCost; // index = next level - 1
}

// ─── Mine appearance ──────────────────────────────────────────────────────────

/** Returns { emoji, name } for a mine at the given level (0-250). */
export function getMineAppearance(level) {
  if (level < 10)  return { emoji: '🌾', name: 'Поле' };
  if (level < 20)  return { emoji: '🪵', name: 'Лесопилка' };
  if (level < 30)  return { emoji: '🌳', name: 'Роща' };
  if (level < 40)  return { emoji: '🪨', name: 'Каменоломня' };
  if (level < 50)  return { emoji: '🧱', name: 'Кирпичный завод' };
  if (level < 60)  return { emoji: '🛖', name: 'Лачуга' };
  if (level < 70)  return { emoji: '🏚️', name: 'Развалюха' };
  if (level < 80)  return { emoji: '🏠', name: 'Дом' };
  if (level < 90)  return { emoji: '🏡', name: 'Усадьба' };
  if (level < 100) return { emoji: '🏘️', name: 'Квартал' };
  if (level < 110) return { emoji: '🏗️', name: 'Стройплощадка' };
  if (level < 120) return { emoji: '🏭', name: 'Завод' };
  if (level < 130) return { emoji: '🏢', name: 'Офисный центр' };
  if (level < 140) return { emoji: '🏦', name: 'Банк' };
  if (level < 150) return { emoji: '🏨', name: 'Отель' };
  if (level < 160) return { emoji: '🏛️', name: 'Дворец' };
  if (level < 170) return { emoji: '🗿', name: 'Монумент' };
  if (level < 180) return { emoji: '🛕', name: 'Храм' };
  if (level < 190) return { emoji: '🗼', name: 'Башня' };
  if (level < 200) return { emoji: '🏟️', name: 'Стадион' };
  if (level < 210) return { emoji: '🔭', name: 'Обсерватория' };
  if (level < 220) return { emoji: '🚀', name: 'Космодром' };
  if (level < 230) return { emoji: '🛸', name: 'Инопланетная база' };
  if (level < 240) return { emoji: '💫', name: 'Звёздный кластер' };
  if (level < 250) return { emoji: '🌎', name: 'Планетарий' };
  return                   { emoji: '🪐', name: 'Планетарная империя' };
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

/** Fixed radius constants (metres). */
export const SMALL_RADIUS = 200;   // build / collect / upgrade zone
export const LARGE_RADIUS = 500;   // combat / vase zone

/** @deprecated — radius is now fixed; kept for old callers. */
export function getBuildRadius(_level) {
  return SMALL_RADIUS;
}

// ─── Allowed avatars ──────────────────────────────────────────────────────────

export const ALLOWED_AVATARS = [
  '🐱','🐯','🦁','🐻','🐼','🐨','🐶','🦊','🐺','🦝',
  '🐭','🐹','🐰','🦔','🐸','🐮','🐷','🐗','🦅','🦆',
  '🦉','🐧','🐦','🦚','🦜','🐤','🐲','🦋','🐠','🦈',
  '🐙','🦑','🦎','🐊','🐻‍❄️','🦦','🦥','🦘','🦙','🐑',
  '🐿️','🦫','🦬','🦣','🦩','🦤',
  '👻','🤖','👾','🎭','🧙','⚔️','🛡️','💀','🌙','⭐',
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

/** HP regen: 1 HP per second, capped at maxHp. */
export function calcHpRegen(currentHp, maxHp, lastRegenISO) {
  if (!lastRegenISO || currentHp >= maxHp) return Math.min(currentHp, maxHp);
  const elapsed = (Date.now() - new Date(lastRegenISO).getTime()) / 1000;
  const regen   = Math.floor(elapsed); // 1 HP per second
  return Math.min(maxHp, currentHp + regen);
}
