// ── Stat ranges by type and rarity ────────────────────────────────────────────

const SWORD_STATS = {
  common:    { attack: [8,  14],  crit: [1, 2]  },
  uncommon:  { attack: [15, 24],  crit: [2, 4]  },
  rare:      { attack: [25, 39],  crit: [4, 6]  },
  epic:      { attack: [40, 64],  crit: [6, 9]  },
  mythic:    { attack: [65, 99],  crit: [9, 12] },
  legendary: { attack: [100,160], crit: [12,15] },
};

const AXE_STATS = {
  common:    { attack: [12, 20]  },
  uncommon:  { attack: [21, 34]  },
  rare:      { attack: [35, 54]  },
  epic:      { attack: [55, 89]  },
  mythic:    { attack: [90, 139] },
  legendary: { attack: [140,224] },
};

const SHIELD_STATS = {
  common:    { defense: [20,  39]  },
  uncommon:  { defense: [40,  74]  },
  rare:      { defense: [75,  124] },
  epic:      { defense: [125, 199] },
  mythic:    { defense: [200, 309] },
  legendary: { defense: [310, 450] },
};

const ITEM_NAMES = {
  sword: {
    common: 'Ржавый меч', uncommon: 'Стальной меч',
    rare: 'Клинок теней', epic: 'Меч демона',
    mythic: 'Адский клинок', legendary: 'Экскалибур',
  },
  axe: {
    common: 'Каменный топор', uncommon: 'Железный топор',
    rare: 'Боевой топор', epic: 'Топор берсерка',
    mythic: 'Топор хаоса', legendary: 'Топор Тора',
  },
  shield: {
    common: 'Деревянный щит', uncommon: 'Железный щит',
    rare: 'Щит стражника', epic: 'Щит дракона',
    mythic: 'Щит титана', legendary: 'Щит богов',
  },
};

const ITEM_EMOJIS = { sword: '🗡️', axe: '🪓', shield: '🛡️' };

function randomInRange(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function generateItem(type, rarity) {
  let stats = {};

  if (type === 'sword') {
    const s = SWORD_STATS[rarity];
    stats.attack = randomInRange(s.attack[0], s.attack[1]);
    stats.crit_chance = randomInRange(s.crit[0], s.crit[1]);
    stats.stat_value = stats.attack;
  } else if (type === 'axe') {
    const s = AXE_STATS[rarity];
    stats.attack = randomInRange(s.attack[0], s.attack[1]);
    stats.crit_chance = 0;
    stats.stat_value = stats.attack;
  } else if (type === 'shield') {
    const s = SHIELD_STATS[rarity];
    stats.defense = randomInRange(s.defense[0], s.defense[1]);
    stats.stat_value = stats.defense;
  }

  return {
    type,
    rarity,
    name: ITEM_NAMES[type][rarity],
    emoji: ITEM_EMOJIS[type],
    ...stats,
  };
}

// ── Sell prices (diamonds) ────────────────────────────────────────────────────

export const ITEM_SELL_PRICE = {
  common:    1,
  uncommon:  1,
  rare:      2,
  epic:      4,
  mythic:    8,
  legendary: 20,
};

// ── Rarity system ────────────────────────────────────────────────────────────

export const RARITY_WEIGHTS = {
  common:    40,
  uncommon:  25,
  rare:      18,
  epic:      10,
  mythic:    5,
  legendary: 2,
};

export const RARITY_COLORS = {
  common:    '#888888',
  uncommon:  '#2979ff',
  rare:      '#00c853',
  epic:      '#ff00aa',
  mythic:    '#8b0000',
  legendary: 'linear-gradient(90deg, #FFD700, #FF8C00, #FFD700)',
};

export const RARITY_NAMES = {
  common:    'Обычный',
  uncommon:  'Необычный',
  rare:      'Редкий',
  epic:      'Эпический',
  mythic:    'Мифический',
  legendary: 'Легендарный',
};

export const RARITY_ORDER = {
  common:    1,
  uncommon:  2,
  rare:      3,
  epic:      4,
  mythic:    5,
  legendary: 6,
};

const ITEM_TYPES = ['sword', 'axe', 'shield'];

function rollRandomType() {
  return ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)];
}

export function rollRarity() {
  const total = Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0);
  let rand = Math.random() * total;
  for (const [rarity, weight] of Object.entries(RARITY_WEIGHTS)) {
    rand -= weight;
    if (rand <= 0) return rarity;
  }
  return 'common';
}

export function rollItem() {
  const type   = rollRandomType();
  const rarity = rollRarity();
  return generateItem(type, rarity);
}

const VASE_WEIGHTS = {
  common:    40,
  uncommon:  35,
  rare:      20,
  epic:      4,
  mythic:    1,
  legendary: 0.1,
};

export function rollVaseItem() {
  const type  = rollRandomType();
  const total = Object.values(VASE_WEIGHTS).reduce((a, b) => a + b, 0);
  let rand = Math.random() * total;
  let rarity = 'common';
  for (const [r, w] of Object.entries(VASE_WEIGHTS)) {
    rand -= w;
    if (rand <= 0) { rarity = r; break; }
  }
  return generateItem(type, rarity);
}
