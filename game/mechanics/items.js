// ── Item stat tables (fixed values, rebalanced) ──
const SWORD_STATS = {
  common:    { attack: 20,  crit_chance: 3  },
  uncommon:  { attack: 50,  crit_chance: 5  },
  rare:      { attack: 110, crit_chance: 8  },
  epic:      { attack: 220, crit_chance: 12 },
  mythic:    { attack: 380, crit_chance: 16 },
  legendary: { attack: 580, crit_chance: 20 },
};
const AXE_STATS = {
  common:    { attack: 28  },
  uncommon:  { attack: 70  },
  rare:      { attack: 150 },
  epic:      { attack: 300 },
  mythic:    { attack: 520 },
  legendary: { attack: 800 },
};
const SHIELD_STATS = {
  common:    { defense: 100  },
  uncommon:  { defense: 250  },
  rare:      { defense: 550  },
  epic:      { defense: 1100 },
  mythic:    { defense: 3800, block_chance: [10,20] },
  legendary: { defense: 5800, block_chance: [20,35] },
};

export const ITEM_STATS = { sword: SWORD_STATS, axe: AXE_STATS, shield: SHIELD_STATS };
export const WEAPON_BASE_STATS = { sword: SWORD_STATS, axe: AXE_STATS, shield: SHIELD_STATS };

export function getWeaponStatAtLevel(baseStat, level) {
  return Math.floor(baseStat * (1 + level * 0.09));
}

const ITEM_NAMES = {
  sword: { common:'Ржавый меч', uncommon:'Стальной меч', rare:'Клинок теней', epic:'Меч демона', mythic:'Адский клинок', legendary:'Экскалибур' },
  axe:   { common:'Каменный топор', uncommon:'Железный топор', rare:'Боевой топор', epic:'Топор берсерка', mythic:'Топор хаоса', legendary:'Топор Тора' },
  shield:{ common:'Деревянный щит', uncommon:'Железный щит', rare:'Щит стражника', epic:'Щит дракона', mythic:'Щит титана', legendary:'Щит богов' },
};
const ITEM_EMOJIS = { sword: '\u{1F5E1}\uFE0F', axe: '\u{1FA93}', shield: '\u{1F6E1}\uFE0F' };

function randomInRange(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function generateItem(type, rarity) {
  let stats = {};
  if (type === 'sword') {
    const s = SWORD_STATS[rarity];
    stats.attack = s.attack;
    stats.crit_chance = s.crit_chance;
    stats.stat_value = stats.attack;
  } else if (type === 'axe') {
    const s = AXE_STATS[rarity];
    stats.attack = s.attack;
    stats.crit_chance = 0;
    stats.stat_value = stats.attack;
  } else if (type === 'shield') {
    const s = SHIELD_STATS[rarity];
    stats.defense = s.defense;
    stats.block_chance = s.block_chance ? randomInRange(s.block_chance[0], s.block_chance[1]) : 0;
    stats.crit_chance = 0;
    stats.stat_value = stats.defense;
  }
  return {
    type, rarity, name: ITEM_NAMES[type][rarity], emoji: ITEM_EMOJIS[type],
    ...stats,
    base_attack: stats.attack || 0,
    base_crit_chance: stats.crit_chance || 0,
    base_defense: stats.defense || 0,
    upgrade_level: 0,
  };
}

// ── Upgrade system ──
export function getMaxUpgradeLevel(rarity) {
  return { common:10, uncommon:25, rare:50, epic:75, mythic:90, legendary:100 }[rarity] || 10;
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
  const maxLvl = getMaxUpgradeLevel(item.rarity);
  const lvl = Math.min(Math.max(item.upgrade_level || 0, 0), maxLvl);
  const mul = 1 + lvl * 0.09;
  const result = { ...item };

  if (item.type === 'sword') {
    result.attack = Math.floor((item.base_attack || item.attack) * mul);
    result.crit_chance = item.base_crit_chance || item.crit_chance || 0;
    if (item.rarity === 'mythic') result.crit_multiplier = 1.5 + (lvl / 90) * 0.7;
    else if (item.rarity === 'legendary') result.crit_multiplier = 1.5 + (lvl / 100) * 1.5;
    else result.crit_multiplier = 1.5;
  }
  if (item.type === 'axe') {
    result.attack = Math.floor((item.base_attack || item.attack) * mul);
    if (item.rarity === 'mythic') result.execution_chance = Math.floor(7 + (lvl / 90) * 10);
    else if (item.rarity === 'legendary') result.execution_chance = Math.floor(13 + (lvl / 100) * 7);
    else result.execution_chance = 0;
  }
  if (item.type === 'shield') {
    result.defense = Math.floor((item.base_defense || item.defense) * mul);
    if ((item.rarity === 'mythic' || item.rarity === 'legendary') && item.block_chance) {
      const baseBlock = item.block_chance || 0;
      if (item.rarity === 'mythic') result.block_chance = Math.floor(baseBlock + (lvl / 90) * 5);
      else result.block_chance = Math.floor(baseBlock + (lvl / 100) * 6);
    }
  }
  return result;
}

export function getItemDescription(item) {
  const maxLvl = getMaxUpgradeLevel(item.rarity);
  const stats = getUpgradedStats(item);
  const desc = {
    upgrade_level: item.upgrade_level || 0,
    max_upgrade_level: maxLvl,
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
  if (item.upgrade_level < maxLvl) desc.next_upgrade_cost = getUpgradeCost(item.upgrade_level + 1);
  return desc;
}

// ── Inventory limit ──
import { MAX_INVENTORY_SLOTS } from '../../config/constants.js';
export { MAX_INVENTORY_SLOTS };

export function getPlayerItemCount(gameState, playerId) {
  let count = 0;
  for (const i of gameState.items.values()) {
    if (i.owner_id === playerId && !i.on_market) count++;
  }
  return count;
}

export function hasInventorySpace(gameState, playerId, needed = 1) {
  return getPlayerItemCount(gameState, playerId) + needed <= MAX_INVENTORY_SLOTS;
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
export const RARITY_NAMES = { common:'\u041E\u0431\u044B\u0447\u043D\u044B\u0439', uncommon:'\u041D\u0435\u043E\u0431\u044B\u0447\u043D\u044B\u0439', rare:'\u0420\u0435\u0434\u043A\u0438\u0439', epic:'\u042D\u043F\u0438\u0447\u0435\u0441\u043A\u0438\u0439', mythic:'\u041C\u0438\u0444\u0438\u0447\u0435\u0441\u043A\u0438\u0439', legendary:'\u041B\u0435\u0433\u0435\u043D\u0434\u0430\u0440\u043D\u044B\u0439' };
export const RARITY_ORDER = { common: 1, uncommon: 2, rare: 3, epic: 4, mythic: 5, legendary: 6 };

const ITEM_TYPES_ARR = ['sword', 'axe', 'shield'];
export function rollRandomType() { return ITEM_TYPES_ARR[Math.floor(Math.random() * ITEM_TYPES_ARR.length)]; }

export const BOX_ODDS = {
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

const VASE_WEIGHTS = { common: 40, uncommon: 35, rare: 20, epic: 4, mythic: 1, legendary: 0.1 };
export function rollVaseItem() {
  const type = rollRandomType();
  const total = Object.values(VASE_WEIGHTS).reduce((a, b) => a + b, 0);
  let rand = Math.random() * total, rarity = 'common';
  for (const [r, w] of Object.entries(VASE_WEIGHTS)) { rand -= w; if (rand <= 0) { rarity = r; break; } }
  return generateItem(type, rarity);
}
