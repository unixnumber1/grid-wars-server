// ── Item stat tables (ranges per rarity+plus — each item rolls unique stats) ──

// Helper: get stat key for rarity+plus combo
function _sk(rarity, plus = 0) { return plus > 0 ? `${rarity}_${plus}` : rarity; }

const SWORD_STATS = {
  common:      { attack: [12, 24],    crit_chance: [2, 4]   },
  uncommon:    { attack: [35, 55],    crit_chance: [4, 7]   },
  rare:        { attack: [75, 115],   crit_chance: [6, 10]  },
  epic:        { attack: [145, 210],  crit_chance: [9, 12]  },
  epic_1:      { attack: [200, 280],  crit_chance: [10, 13] },
  epic_2:      { attack: [270, 365],  crit_chance: [11, 14] },
  mythic:      { attack: [380, 420],  crit_chance: [13, 16] },
  mythic_1:    { attack: [470, 520],  crit_chance: [14, 17] },
  mythic_2:    { attack: [570, 630],  crit_chance: [15, 18] },
  mythic_3:    { attack: [675, 745],  crit_chance: [16, 19] },
  legendary:   { attack: [775, 855],  crit_chance: [17, 20] },
  legendary_1: { attack: [890, 980],  crit_chance: [18, 21] },
  legendary_2: { attack: [1015, 1125],crit_chance: [19, 22] },
  legendary_3: { attack: [1165, 1285],crit_chance: [20, 24] },
};
const AXE_STATS = {
  common:      { attack: [17, 34]   },
  uncommon:    { attack: [49, 77]   },
  rare:        { attack: [105, 161] },
  epic:        { attack: [203, 294] },
  epic_1:      { attack: [280, 392] },
  epic_2:      { attack: [378, 511] },
  mythic:      { attack: [530, 590]  },
  mythic_1:    { attack: [660, 730]  },
  mythic_2:    { attack: [800, 880]  },
  mythic_3:    { attack: [945, 1045] },
  legendary:   { attack: [1085, 1200] },
  legendary_1: { attack: [1245, 1375] },
  legendary_2: { attack: [1425, 1575] },
  legendary_3: { attack: [1630, 1800] },
};
// Bow: ranged class. Damage ≈ sword × 0.6, no crit, slow distance falloff (100% → 50%).
// Identity is range stability, not burst — that's why crit is intentionally absent.
const BOW_STATS = {
  common:      { attack: [7, 14]    },
  uncommon:    { attack: [21, 33]   },
  rare:        { attack: [45, 69]   },
  epic:        { attack: [87, 126]  },
  epic_1:      { attack: [120, 168] },
  epic_2:      { attack: [162, 219] },
  mythic:      { attack: [228, 252] },
  mythic_1:    { attack: [282, 312] },
  mythic_2:    { attack: [342, 378] },
  mythic_3:    { attack: [405, 447] },
  legendary:   { attack: [465, 513] },
  legendary_1: { attack: [534, 588] },
  legendary_2: { attack: [609, 675] },
  legendary_3: { attack: [699, 771] },
};
const SHIELD_STATS = {
  common:      { defense: [90, 150]     },
  uncommon:    { defense: [240, 370]    },
  rare:        { defense: [510, 790]    },
  epic:        { defense: [1050, 1550]  },
  epic_1:      { defense: [1400, 2050]  },
  epic_2:      { defense: [1850, 2700]  },
  mythic:      { defense: [3750, 4150],  block_chance: [12, 20] },
  mythic_1:    { defense: [4200, 4650],  block_chance: [14, 22] },
  mythic_2:    { defense: [4700, 5200],  block_chance: [16, 24] },
  mythic_3:    { defense: [5250, 5800],  block_chance: [18, 26] },
  legendary:   { defense: [5850, 6450],  block_chance: [22, 30] },
  legendary_1: { defense: [6500, 7150],  block_chance: [24, 32] },
  legendary_2: { defense: [7200, 7900],  block_chance: [26, 34] },
  legendary_3: { defense: [7950, 8500],  block_chance: [28, 36] },
};

export const ITEM_STATS = { sword: SWORD_STATS, axe: AXE_STATS, shield: SHIELD_STATS, bow: BOW_STATS };
export const WEAPON_BASE_STATS = { sword: SWORD_STATS, axe: AXE_STATS, shield: SHIELD_STATS, bow: BOW_STATS };

export function getWeaponStatAtLevel(baseStat, level) {
  return Math.floor(baseStat * (1 + level * 0.09));
}

const ITEM_NAMES = {
  sword: { common:'Ржавый меч', uncommon:'Стальной меч', rare:'Клинок теней', epic:'Меч демона', mythic:'Адский клинок', legendary:'Экскалибур' },
  axe:   { common:'Каменный топор', uncommon:'Железный топор', rare:'Боевой топор', epic:'Топор берсерка', mythic:'Топор хаоса', legendary:'Топор Тора' },
  shield:{ common:'Деревянный щит', uncommon:'Железный щит', rare:'Щит стражника', epic:'Щит дракона', mythic:'Щит титана', legendary:'Щит богов' },
  bow:   { common:'Деревянный лук', uncommon:'Охотничий лук', rare:'Длинный лук', epic:'Лук эльфов', mythic:'Лук теней', legendary:'Лук Артемиды' },
};
const ITEM_EMOJIS = { sword: '\u{1F5E1}\uFE0F', axe: '\u{1FA93}', shield: '\u{1F6E1}\uFE0F', bow: '\u{1F3F9}' };

function randomInRange(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function generateItem(type, rarity, plus = 0) {
  const key = _sk(rarity, plus);
  let stats = {};
  if (type === 'sword') {
    const s = SWORD_STATS[key] || SWORD_STATS[rarity];
    stats.attack = randomInRange(s.attack[0], s.attack[1]);
    stats.crit_chance = randomInRange(s.crit_chance[0], s.crit_chance[1]);
    stats.stat_value = stats.attack;
  } else if (type === 'axe') {
    const s = AXE_STATS[key] || AXE_STATS[rarity];
    stats.attack = randomInRange(s.attack[0], s.attack[1]);
    stats.crit_chance = 0;
    stats.stat_value = stats.attack;
  } else if (type === 'shield') {
    const s = SHIELD_STATS[key] || SHIELD_STATS[rarity];
    stats.defense = randomInRange(s.defense[0], s.defense[1]);
    stats.block_chance = s.block_chance ? randomInRange(s.block_chance[0], s.block_chance[1]) : 0;
    stats.crit_chance = 0;
    stats.stat_value = stats.defense;
  } else if (type === 'bow') {
    const s = BOW_STATS[key] || BOW_STATS[rarity];
    stats.attack = randomInRange(s.attack[0], s.attack[1]);
    stats.crit_chance = 0;
    stats.stat_value = stats.attack;
  }
  return {
    type, rarity, plus, name: ITEM_NAMES[type][rarity], emoji: ITEM_EMOJIS[type],
    ...stats,
    base_attack: stats.attack || 0,
    base_crit_chance: stats.crit_chance || 0,
    base_defense: stats.defense || 0,
    upgrade_level: 0,
  };
}

// ── Upgrade system ──

// Max upgrade level grows with tier: each tier adds +10
const _MAX_UPGRADE = {
  common:      10,
  uncommon:    20,
  rare:        30,
  epic:        40,   epic_1:      50,   epic_2:      60,
  mythic:      70,   mythic_1:    80,   mythic_2:    90,   mythic_3:    100,
  legendary:   100,  legendary_1: 100,  legendary_2: 100,  legendary_3: 100,
};

export function getMaxUpgradeLevel(rarity, plus = 0) {
  return _MAX_UPGRADE[_sk(rarity, plus)] || 10;
}

export function getUpgradeCost(upgradeLevel) {
  if (upgradeLevel <= 10) return 200;
  if (upgradeLevel <= 20) return 400;
  if (upgradeLevel <= 30) return 800;
  if (upgradeLevel <= 40) return 1600;
  if (upgradeLevel <= 50) return 3000;
  if (upgradeLevel <= 60) return 5000;
  if (upgradeLevel <= 70) return 9000;
  if (upgradeLevel <= 80) return 15000;
  if (upgradeLevel <= 90) return 25000;
  return 40000;
}

export function getTotalUpgradeCost(level) {
  let total = 0;
  for (let i = 1; i <= level; i++) total += getUpgradeCost(i);
  return total;
}

export function getUpgradedStats(item) {
  const maxLvl = getMaxUpgradeLevel(item.rarity, item.plus || 0);
  const lvl = Math.min(Math.max(item.upgrade_level || 0, 0), maxLvl);
  const mul = 1 + lvl * 0.09;
  const result = { ...item };

  if (item.type === 'sword') {
    result.attack = Math.floor((item.base_attack || item.attack) * mul);
    result.crit_chance = item.base_crit_chance || item.crit_chance || 0;
    if (item.rarity === 'mythic') result.crit_multiplier = 1.5 + (lvl / 100) * 0.7;
    else if (item.rarity === 'legendary') result.crit_multiplier = 1.5 + (lvl / 100) * 1.5;
    else result.crit_multiplier = 1.5;
  }
  if (item.type === 'axe') {
    result.attack = Math.floor((item.base_attack || item.attack) * mul);
    if (item.rarity === 'mythic') result.execution_chance = Math.floor(7 + (lvl / 100) * 10);
    else if (item.rarity === 'legendary') result.execution_chance = Math.floor(13 + (lvl / 100) * 7);
    else result.execution_chance = 0;
  }
  if (item.type === 'shield') {
    result.defense = Math.floor((item.base_defense || item.defense) * mul);
    if ((item.rarity === 'mythic' || item.rarity === 'legendary') && item.block_chance) {
      const baseBlock = item.block_chance || 0;
      if (item.rarity === 'mythic') result.block_chance = Math.floor(baseBlock + (lvl / 100) * 5);
      else result.block_chance = Math.floor(baseBlock + (lvl / 100) * 6);
    }
  }
  if (item.type === 'bow') {
    result.attack = Math.floor((item.base_attack || item.attack) * mul);
    result.crit_chance = 0;
    // piercing_chance: % chance arrow ignores distance falloff entirely (100% damage at any range).
    // Mirrors axe execution_chance pattern: pure rarity+upgrade derived, never persisted.
    if (item.rarity === 'mythic') result.piercing_chance = Math.floor(8 + (lvl / 100) * 10);
    else if (item.rarity === 'legendary') result.piercing_chance = Math.floor(15 + (lvl / 100) * 13);
    else result.piercing_chance = 0;
  }
  return result;
}

export function getItemDescription(item) {
  const maxLvl = getMaxUpgradeLevel(item.rarity, item.plus || 0);
  const stats = getUpgradedStats(item);
  const desc = {
    upgrade_level: item.upgrade_level || 0,
    max_upgrade_level: maxLvl,
    plus: item.plus || 0,
    stats: [],
    features: [],
  };
  if (item.type === 'sword') {
    desc.stats.push({ label: '\u2694\uFE0F \u0410\u0442\u0430\u043A\u0430', value: stats.attack });
    desc.stats.push({ label: '\u{1F4A5} \u041A\u0440\u0438\u0442', value: stats.crit_chance?.toFixed(1) + '%' });
    if (stats.crit_multiplier > 1.5) desc.stats.push({ label: '\u2728 \u041A\u0440\u0438\u0442 \u0443\u0440\u043E\u043D', value: '\u00D7' + stats.crit_multiplier?.toFixed(2) });
  }
  if (item.type === 'axe') {
    desc.stats.push({ label: '\u2694\uFE0F \u0410\u0442\u0430\u043A\u0430', value: stats.attack });
    if (stats.execution_chance > 0) desc.stats.push({ label: '\u{1F480} \u041A\u0430\u0437\u043D\u044C', value: stats.execution_chance?.toFixed(1) + '%' });
  }
  if (item.type === 'shield') {
    desc.stats.push({ label: '\u{1F6E1}\uFE0F \u0417\u0430\u0449\u0438\u0442\u0430', value: '+' + stats.defense });
    if (stats.block_chance > 0) desc.stats.push({ label: '\u{1F530} \u0411\u043B\u043E\u043A', value: stats.block_chance?.toFixed(1) + '%' });
  }
  if (item.type === 'bow') {
    // 🏹 Атака  ·  🎯 Пробитие
    desc.stats.push({ label: '\u{1F3F9} \u0410\u0442\u0430\u043A\u0430', value: stats.attack });
    if (stats.piercing_chance > 0) desc.stats.push({ label: '\u{1F3AF} \u041F\u0440\u043E\u0431\u0438\u0442\u0438\u0435', value: stats.piercing_chance?.toFixed(1) + '%' });
  }
  if (item.upgrade_level < maxLvl) desc.next_upgrade_cost = getUpgradeCost(item.upgrade_level + 1);
  return desc;
}

// ── Craft system ──

// Craft recipe: given a target item, returns what's needed
export function getCraftRecipe(targetRarity, targetPlus = 0) {
  const p = targetPlus || 0;
  // Basic craft: 3 same type → next rarity
  if (p === 0 && (targetRarity === 'common' || targetRarity === 'uncommon' || targetRarity === 'rare')) {
    const NEXT = { common: 'uncommon', uncommon: 'rare', rare: 'epic' };
    return { mode: 'basic', materialCount: 2, materialRarity: targetRarity, materialPlus: 0, resultRarity: NEXT[targetRarity], resultPlus: 0 };
  }
  // Fusion: epic+ tiers
  if (targetRarity === 'epic' && p === 0) return { mode: 'fusion', materialCount: 1, materialRarity: 'epic', materialPlus: 0, resultRarity: 'epic', resultPlus: 1 };
  if (targetRarity === 'epic' && p === 1) return { mode: 'fusion', materialCount: 1, materialRarity: 'epic', materialPlus: 1, resultRarity: 'epic', resultPlus: 2 };
  if (targetRarity === 'epic' && p === 2) return { mode: 'fusion', materialCount: 1, materialRarity: 'epic', materialPlus: 2, resultRarity: 'mythic', resultPlus: 0 };
  if (targetRarity === 'mythic' && p === 0) return { mode: 'fusion', materialCount: 1, materialRarity: 'mythic', materialPlus: 0, resultRarity: 'mythic', resultPlus: 1 };
  if (targetRarity === 'mythic' && p === 1) return { mode: 'fusion', materialCount: 1, materialRarity: 'mythic', materialPlus: 1, resultRarity: 'mythic', resultPlus: 2 };
  if (targetRarity === 'mythic' && p === 2) return { mode: 'fusion', materialCount: 1, materialRarity: 'mythic', materialPlus: 2, resultRarity: 'mythic', resultPlus: 3 };
  // Legendary craft: special — needs 2× mythic+0 of exact same type
  if (targetRarity === 'mythic' && p === 3) return { mode: 'legendary', materialCount: 2, materialRarity: 'mythic', materialPlus: 0, resultRarity: 'legendary', resultPlus: 0 };
  if (targetRarity === 'legendary' && p === 0) return { mode: 'fusion', materialCount: 1, materialRarity: 'legendary', materialPlus: 0, resultRarity: 'legendary', resultPlus: 1 };
  if (targetRarity === 'legendary' && p === 1) return { mode: 'fusion', materialCount: 1, materialRarity: 'legendary', materialPlus: 1, resultRarity: 'legendary', resultPlus: 2 };
  if (targetRarity === 'legendary' && p === 2) return { mode: 'fusion', materialCount: 1, materialRarity: 'legendary', materialPlus: 2, resultRarity: 'legendary', resultPlus: 3 };
  return null; // legendary+3 — max, can't craft higher
}

// ── Inventory limit ──
import { INVENTORY_BASE_SLOTS, INVENTORY_MAX_SLOTS } from '../../config/constants.js';
export { INVENTORY_BASE_SLOTS, INVENTORY_MAX_SLOTS };

export function getPlayerMaxSlots(gameState, playerId) {
  const player = gameState.getPlayerById(playerId);
  const extra = player?.extra_slots || 0;
  return Math.min(INVENTORY_BASE_SLOTS + extra, INVENTORY_MAX_SLOTS);
}

export function getPlayerItemCount(gameState, playerId) {
  let count = 0;
  for (const i of gameState.items.values()) {
    if (i.owner_id === playerId && !i.on_market && !i.held_by_courier) count++;
  }
  return count;
}

export function hasInventorySpace(gameState, playerId, needed = 1) {
  return getPlayerItemCount(gameState, playerId) + needed <= getPlayerMaxSlots(gameState, playerId);
}

// ── Existing exports (keep as-is) ──
export const ITEM_SELL_PRICE = { common: 10, uncommon: 25, rare: 50, epic: 100, mythic: 200, legendary: 500 };

export function getItemSellPrice(rarity, upgradeLevel = 0) {
  const base = ITEM_SELL_PRICE[rarity] || 10;
  let invested = 0;
  for (let i = 1; i <= upgradeLevel; i++) invested += getUpgradeCost(i);
  return base + Math.floor(invested * 0.1);
}
export const RARITY_WEIGHTS = { common: 40, uncommon: 25, rare: 18, epic: 10, mythic: 5, legendary: 2 };
export const RARITY_COLORS = { common:'#888888', uncommon:'#2979ff', rare:'#00c853', epic:'#ff00aa', mythic:'#8b0000', legendary:'linear-gradient(90deg, #FFD700, #FF8C00, #FFD700)' };
export const RARITY_NAMES = { common:'Обычный', uncommon:'Необычный', rare:'Редкий', epic:'Эпический', mythic:'Мифический', legendary:'Легендарный' };
export const RARITY_ORDER = { common: 1, uncommon: 2, rare: 3, epic: 4, mythic: 5, legendary: 6 };

const ITEM_TYPES_ARR = ['sword', 'axe', 'shield', 'bow'];
export function rollRandomType() { return ITEM_TYPES_ARR[Math.floor(Math.random() * ITEM_TYPES_ARR.length)]; }

export const BOX_ODDS = {
  common: { common: 40, uncommon: 35, rare: 20, epic: 5 },
  rare: { rare: 75, epic: 20, mythic: 5 },
  epic: { rare: 30, epic: 50, mythic: 20 },
  mythic: { epic: 30, mythic: 65, legendary: 5 },
};

export function rollWeighted(weights) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let rand = Math.random() * total;
  for (const [key, weight] of Object.entries(weights)) {
    rand -= weight;
    if (rand <= 0) return key;
  }
  return Object.keys(weights)[0];
}

export function rollRarity() {
  const total = Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0);
  let rand = Math.random() * total;
  for (const [rarity, weight] of Object.entries(RARITY_WEIGHTS)) { rand -= weight; if (rand <= 0) return rarity; }
  return 'common';
}

export function rollItem() { return generateItem(rollRandomType(), rollRarity()); }

const VASE_WEIGHTS = { common: 40, uncommon: 35, rare: 20, epic: 4, mythic: 1, legendary: 0.05 };
export function rollVaseItem() {
  const type = rollRandomType();
  const total = Object.values(VASE_WEIGHTS).reduce((a, b) => a + b, 0);
  let rand = Math.random() * total, rarity = 'common';
  for (const [r, w] of Object.entries(VASE_WEIGHTS)) { rand -= w; if (rand <= 0) { rarity = r; break; } }
  return generateItem(type, rarity);
}
