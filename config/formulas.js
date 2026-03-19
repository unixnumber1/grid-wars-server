import { MINE_MAX_LEVEL, HQ_MAX_LEVEL, HQ_COIN_LIMIT, SMALL_RADIUS, LARGE_RADIUS, BASE_PLAYER_ATTACK, BASE_PLAYER_HP } from './constants.js';

// Re-export constants for backward compatibility
export { MINE_MAX_LEVEL, HQ_MAX_LEVEL, HQ_COIN_LIMIT, SMALL_RADIUS, LARGE_RADIUS, BASE_PLAYER_ATTACK, BASE_PLAYER_HP };

// ─── Mine formulas ────────────────────────────────────────────────────────────

export function getMineUpgradeCost(level) {
  if (level <= 0) return 0;
  // lv1-100: 998 * 1.13^(l-1) → lv10=3K, lv50=400K, lv100=200M
  if (level <= 100) return Math.floor(998 * Math.pow(1.1301, level - 1));
  // lv101-200: 200M * 1.1857^(l-100) → lv150=1T, lv200=5Q
  const base100 = Math.floor(998 * Math.pow(1.1301, 99));
  return Math.floor(base100 * Math.pow(1.1857, level - 100));
}

export function getMineIncome(level) {
  if (level <= 0) return 0;
  // Returns coins per SECOND. Per hour: 50 * level^2
  // lv1=50/h, lv10=5K/h, lv100=500K/h, lv200=2M/h
  return 50 * Math.pow(level, 2.0) / 3600;
}

export function getMineCapacity(level) {
  if (level <= 0) return 0;
  // Use per-hour income for capacity calculation
  const incomePerHour = Math.floor(50 * Math.pow(level, 2.0));
  let hours;
  if (level < 50)       hours = 6;
  else if (level < 100) hours = 168;
  else if (level < 110) hours = 240;
  else if (level < 120) hours = 264;
  else if (level < 130) hours = 288;
  else if (level < 140) hours = 312;
  else if (level < 150) hours = 336;
  else if (level < 160) hours = 360;
  else if (level < 170) hours = 384;
  else if (level < 180) hours = 408;
  else if (level < 190) hours = 432;
  else if (level < 200) hours = 456;
  else                  hours = 480;
  return Math.floor(incomePerHour * hours);
}

// Boost from mine count: +0.1% per mine
// 100 mines = +10%, 1000 mines = +100% (x2), 2000 mines = +200% (x3)
export function getMineCountBoost(mineCount) {
  return 1 + (mineCount * 0.001);
}

export function calcAccumulatedCoins(level, lastCollectedISO, incomeBoost = 1, capacityBoost = 1) {
  if (level <= 0) return 0;
  const elapsedSec = (Date.now() - new Date(lastCollectedISO).getTime()) / 1000;
  const raw = getMineIncome(level) * incomeBoost * Math.max(0, elapsedSec);
  return Math.min(Math.round(raw), Math.round(getMineCapacity(level) * capacityBoost));
}

export function getMineUpgradeCostBulk(currentLevel, count) {
  let total = 0;
  for (let i = 0; i < count; i++) {
    total += getMineUpgradeCost(currentLevel + i);
  }
  return total;
}

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

export const mineRate        = getMineIncome;
export const mineUpgradeCost = getMineUpgradeCost;

// ─── Headquarters formulas ────────────────────────────────────────────────────

const HQ_LIMITS = [
  1_000_000, 10_000_000, 100_000_000, 1_000_000_000, 10_000_000_000,
  100_000_000_000, 1_000_000_000_000, 10_000_000_000_000, 100_000_000_000_000, 1e18,
];

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
  { level: 9,  maxMines: 90,  maxMineLevel: 200, upgradeCost: 50_000_000_000 },
  { level: 10, maxMines: 100, maxMineLevel: 200, upgradeCost: 500_000_000_000 },
];

export function hqConfig(hqLevel) {
  return HQ_LEVELS[Math.min(Math.max(hqLevel, 1), HQ_MAX_LEVEL) - 1];
}

export function hqUpgradeCost(currentLevel) {
  if (currentLevel >= HQ_MAX_LEVEL) return null;
  return HQ_LEVELS[currentLevel].upgradeCost;
}

// ─── Mine appearance ──────────────────────────────────────────────────────────

export function getMineAppearance(level) {
  if (level < 10)  return { emoji: '\u{1F33E}', name: '\u041F\u043E\u043B\u0435' };
  if (level < 20)  return { emoji: '\u{1FAB5}', name: '\u041B\u0435\u0441\u043E\u043F\u0438\u043B\u043A\u0430' };
  if (level < 30)  return { emoji: '\u{1F333}', name: '\u0420\u043E\u0449\u0430' };
  if (level < 40)  return { emoji: '\u{1FAA8}', name: '\u041A\u0430\u043C\u0435\u043D\u043E\u043B\u043E\u043C\u043D\u044F' };
  if (level < 50)  return { emoji: '\u{1F9F1}', name: '\u041A\u0438\u0440\u043F\u0438\u0447\u043D\u044B\u0439 \u0437\u0430\u0432\u043E\u0434' };
  if (level < 60)  return { emoji: '\u{1F6D6}', name: '\u041B\u0430\u0447\u0443\u0433\u0430' };
  if (level < 70)  return { emoji: '\u{1F3DA}\uFE0F', name: '\u0420\u0430\u0437\u0432\u0430\u043B\u044E\u0445\u0430' };
  if (level < 80)  return { emoji: '\u{1F3E0}', name: '\u0414\u043E\u043C' };
  if (level < 90)  return { emoji: '\u{1F3E1}', name: '\u0423\u0441\u0430\u0434\u044C\u0431\u0430' };
  if (level < 100) return { emoji: '\u{1F3D8}\uFE0F', name: '\u041A\u0432\u0430\u0440\u0442\u0430\u043B' };
  if (level < 110) return { emoji: '\u{1F3D7}\uFE0F', name: '\u0421\u0442\u0440\u043E\u0439\u043F\u043B\u043E\u0449\u0430\u0434\u043A\u0430' };
  if (level < 120) return { emoji: '\u{1F3ED}', name: '\u0417\u0430\u0432\u043E\u0434' };
  if (level < 130) return { emoji: '\u{1F3E2}', name: '\u041E\u0444\u0438\u0441\u043D\u044B\u0439 \u0446\u0435\u043D\u0442\u0440' };
  if (level < 140) return { emoji: '\u{1F3E6}', name: '\u0411\u0430\u043D\u043A' };
  if (level < 150) return { emoji: '\u{1F3E8}', name: '\u041E\u0442\u0435\u043B\u044C' };
  if (level < 160) return { emoji: '\u{1F3DB}\uFE0F', name: '\u0414\u0432\u043E\u0440\u0435\u0446' };
  if (level < 170) return { emoji: '\u{1F5FF}', name: '\u041C\u043E\u043D\u0443\u043C\u0435\u043D\u0442' };
  if (level < 180) return { emoji: '\u{1F6D5}', name: '\u0425\u0440\u0430\u043C' };
  if (level < 190) return { emoji: '\u{1F5FC}', name: '\u0411\u0430\u0448\u043D\u044F' };
  if (level < 200) return { emoji: '\u{1F3DF}\uFE0F', name: '\u0421\u0442\u0430\u0434\u0438\u043E\u043D' };
  if (level < 210) return { emoji: '\u{1F52D}', name: '\u041E\u0431\u0441\u0435\u0440\u0432\u0430\u0442\u043E\u0440\u0438\u044F' };
  if (level < 220) return { emoji: '\u{1F680}', name: '\u041A\u043E\u0441\u043C\u043E\u0434\u0440\u043E\u043C' };
  if (level < 230) return { emoji: '\u{1F6F8}', name: '\u0418\u043D\u043E\u043F\u043B\u0430\u043D\u0435\u0442\u043D\u0430\u044F \u0431\u0430\u0437\u0430' };
  if (level < 240) return { emoji: '\u{1F4AB}', name: '\u0417\u0432\u0451\u0437\u0434\u043D\u044B\u0439 \u043A\u043B\u0430\u0441\u0442\u0435\u0440' };
  if (level < 250) return { emoji: '\u{1F30E}', name: '\u041F\u043B\u0430\u043D\u0435\u0442\u0430\u0440\u0438\u0439' };
  return                   { emoji: '\u{1FA90}', name: '\u041F\u043B\u0430\u043D\u0435\u0442\u0430\u0440\u043D\u0430\u044F \u0438\u043C\u043F\u0435\u0440\u0438\u044F' };
}

export function getMineEmoji(level) {
  return getMineAppearance(level).emoji;
}

// ─── Player level system ──────────────────────────────────────────────────────

// Phase-based XP curve: 800 * 15^phase * n^2.15, x5 barrier every 100 levels
export function getXpForLevel(level) {
  if (level <= 0) return 0;
  const phase = Math.floor((level - 1) / 100);
  const levelInPhase = ((level - 1) % 100) + 1;
  const base = 800 * Math.pow(15, phase);
  let xp = Math.floor(base * Math.pow(levelInPhase, 2.15));
  if (level % 100 === 0) xp *= 5;
  return xp;
}

export function getTotalXpForLevel(level) {
  let total = 0;
  for (let i = 1; i < level; i++) total += getXpForLevel(i);
  return total;
}

export function getLevelFromXp(totalXp) {
  let level = 1;
  let accumulated = 0;
  while (accumulated + getXpForLevel(level) <= totalXp) {
    accumulated += getXpForLevel(level);
    level++;
    if (level > 10000) break;
  }
  return { level, xpIntoLevel: totalXp - accumulated };
}

// Backward compat aliases
export const xpForLevel = getXpForLevel;
export function calculateLevel(currentXp) {
  return getLevelFromXp(currentXp).level;
}

export function getBuildRadius(_level) {
  return SMALL_RADIUS;
}

// ─── Allowed avatars ──────────────────────────────────────────────────────────

export const ALLOWED_AVATARS = [
  '\u{1F431}','\u{1F42F}','\u{1F981}','\u{1F43B}','\u{1F43C}','\u{1F428}','\u{1F436}','\u{1F98A}','\u{1F43A}','\u{1F99D}',
  '\u{1F42D}','\u{1F439}','\u{1F430}','\u{1F994}','\u{1F438}','\u{1F42E}','\u{1F437}','\u{1F417}','\u{1F985}','\u{1F986}',
  '\u{1F989}','\u{1F427}','\u{1F426}','\u{1F99A}','\u{1F99C}','\u{1F424}','\u{1F432}','\u{1F98B}','\u{1F420}','\u{1F988}',
  '\u{1F419}','\u{1F991}','\u{1F98E}','\u{1F40A}','\u{1F43B}\u200D\u2744\uFE0F','\u{1F9A6}','\u{1F9A5}','\u{1F998}','\u{1F999}','\u{1F411}',
  '\u{1F43F}\uFE0F','\u{1F9AB}','\u{1F9AC}','\u{1F9A3}','\u{1F9A9}','\u{1F9A4}',
  '\u{1F47B}','\u{1F916}','\u{1F47E}','\u{1F3AD}','\u{1F9D9}','\u2694\uFE0F','\u{1F6E1}\uFE0F','\u{1F480}','\u{1F319}','\u2B50',
];

// ─── Combat formulas ──────────────────────────────────────────────────────────

export function getMaxHp(_level) {
  return BASE_PLAYER_HP;
}

export function getPlayerAttack(_level) {
  return BASE_PLAYER_ATTACK;
}

// ─── Mine HP ──────────────────────────────────────────────────────────────────

export function getMineHp(level) {
  if (level <= 0) return 0;
  return Math.floor(500 * Math.pow(level, 1.3));
}

export function getMineHpRegen(level) {
  if (level <= 0) return 0;
  return Math.max(1, Math.floor(getMineHp(level) * 0.25));
}

export function calcMineHpRegen(currentHp, maxHp, regenPerHour, lastHpUpdateISO) {
  if (!lastHpUpdateISO || currentHp >= maxHp) return Math.min(currentHp, maxHp);
  const elapsedSec = (Date.now() - new Date(lastHpUpdateISO).getTime()) / 1000;
  const regenPerSec = regenPerHour / 3600;
  const healed = Math.floor(regenPerSec * elapsedSec);
  return Math.min(maxHp, currentHp + healed);
}

export function calcHpRegen(currentHp, maxHp, lastRegenISO) {
  if (!lastRegenISO || currentHp >= maxHp) return Math.min(currentHp, maxHp);
  const elapsed = (Date.now() - new Date(lastRegenISO).getTime()) / 1000;
  const regen   = Math.floor(elapsed * 10); // 10 HP per second
  return Math.min(maxHp, currentHp + regen);
}
