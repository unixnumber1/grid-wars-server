export const ITEMS = {
  sword: [
    { rarity: 'common',    name: 'Ржавый клинок',  emoji: '🗡️', stat: 8   },
    { rarity: 'rare',      name: 'Стальной меч',   emoji: '🗡️', stat: 20  },
    { rarity: 'uncommon',  name: 'Клинок теней',   emoji: '🗡️', stat: 38  },
    { rarity: 'epic',      name: 'Меч демона',     emoji: '🗡️', stat: 65  },
    { rarity: 'mythic',    name: 'Адский клинок',  emoji: '🗡️', stat: 100 },
    { rarity: 'legendary', name: 'Экскалибур',     emoji: '🗡️', stat: 160 },
  ],
  shield: [
    { rarity: 'common',    name: 'Деревянный щит', emoji: '🛡️', stat: 25  },
    { rarity: 'rare',      name: 'Железный щит',   emoji: '🛡️', stat: 60  },
    { rarity: 'uncommon',  name: 'Щит стражника',  emoji: '🛡️', stat: 110 },
    { rarity: 'epic',      name: 'Щит дракона',    emoji: '🛡️', stat: 180 },
    { rarity: 'mythic',    name: 'Щит титана',     emoji: '🛡️', stat: 270 },
    { rarity: 'legendary', name: 'Щит богов',      emoji: '🛡️', stat: 400 },
  ],
};

export const RARITY_WEIGHTS = {
  common:    40,
  rare:      25,
  uncommon:  18,
  epic:      10,
  mythic:    5,
  legendary: 2,
};

export const RARITY_COLORS = {
  common:    '#888888',
  rare:      '#00c853',
  uncommon:  '#2979ff',
  epic:      '#f50057',
  mythic:    '#d50000',
  legendary: 'linear-gradient(90deg, #FFD700, #FF8C00, #FFD700)',
};

export const RARITY_NAMES = {
  common:    'Обычный',
  rare:      'Редкий',
  uncommon:  'Необычный',
  epic:      'Эпический',
  mythic:    'Мифический',
  legendary: 'Легендарный',
};

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
  const type   = Math.random() < 0.5 ? 'sword' : 'shield';
  const rarity = rollRarity();
  const found  = ITEMS[type].find(i => i.rarity === rarity);
  return { type, ...(found || ITEMS[type][0]) };
}
