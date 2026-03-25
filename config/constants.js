// ═══════════════════════════════════════════════════════
//  All game constants in one place
// ═══════════════════════════════════════════════════════

// ── Radii ──
export const SMALL_RADIUS = 200;       // meters — build, collect, vases
export const LARGE_RADIUS = 500;       // meters — attack bots, PvP, attack mines
export const MINE_BOOST_RADIUS = 20000; // meters — mine count boost radius (20km)
export const PIN_DURATION_MS = 60 * 60 * 1000; // 1 hour PIN session

// ── Admin ──
export const ADMIN_TG_ID = 560013667;

// ── H3 grid ──
export const H3_RESOLUTION = 10;       // ~65m hexes
export const MINE_DISK_K = 12;

// ── Mine limits ──
export const MINE_MAX_LEVEL = 200;
export const HQ_MAX_LEVEL = 10;
export const HQ_COIN_LIMIT = 1_000_000;

// ── Weapon cooldowns (ms) ──
export const WEAPON_COOLDOWNS = { sword: 500, axe: 700, none: 200 };
export const ATTACK_COOLDOWN_SWORD = 500;
export const ATTACK_COOLDOWN_AXE = 700;

// ── Player base stats ──
export const BASE_PLAYER_ATTACK = 10;
export const BASE_PLAYER_HP = 1000;
export const ONLINE_MS = 3 * 60 * 1000; // 3 minutes

// ── Bots ──
export const BOTS_PER_ZONE = 10;
export const BOT_TTL_MS = 5 * 60 * 1000;
export const GLOBAL_BOT_CAP = 20;
export const BOT_SPEED_METERS = { slow: 15, medium: 30, fast: 55, very_fast: 90 };
export const DRAIN_LIMITS = { spirit: 50, goblin: 50000, werewolf: 400, demon: 1000, dragon: 3000, boss: 10000 };

// ── Game loop ──
export const TICK_INTERVAL = 5000;
export const PERSIST_INTERVAL = 30_000;

// ── PvP ──
export const PVP_SHIELD_DURATION_MS = 0;                   // disabled
export const PVP_COOLDOWN_MS = 0;                          // disabled
export const PVP_COIN_LOSS_PERCENT = 0.10;                // 10% coins lost
export const PVP_COIN_WINNER_SHARE = 0.50;                // 50% of lost goes to winner

// ── Player rename ──
export const RENAME_COST_DIAMONDS = 10;
export const USERNAME_RE = /^[a-zA-Zа-яА-ЯёЁ0-9_]+$/;

// ── Items ──
export const BOX_PRICES = { common: 3, rare: 8, epic: 35, mythic: 150 };
export const ITEM_TYPES = ['sword', 'axe', 'shield'];

// ── Market ──
export const MARKET_PAGE_SIZE = 20;
export const MAX_ACTIVE_LISTINGS = 10;
export const LISTING_TTL_HOURS = 48;
export const MARKET_COMMISSION = 0.10;             // 10%
export const COURIER_KILL_XP = 50;
export const COURIER_HP = 5000;
export const COURIER_SPEED_SELLER = 0.0002;        // ~20 km/h
export const COURIER_SPEED_DELIVERY = 0.0015;      // ~150 km/h
export const COURIER_SPEED_PLAYER = 0.0002;        // ~20 km/h

// ── Ore nodes ──
export const ORE_CAPTURE_RADIUS = 200;
export const ORE_TTL_DAYS = 30;
export const ORE_MIN_DISTANCE = 200;
export const ORE_ZONE_RADIUS = 5000;               // 5km zone for clustering

// ── Collectors ──
export const COLLECTOR_COST_DIAMONDS = 50;
export const COLLECTOR_SELL_DIAMONDS = 37;
export const COLLECTOR_RADIUS = 200;               // meters
export const COLLECTOR_DELIVERY_COMMISSION = 0.10;  // 10%

// ── Monuments ──
export const MONUMENT_ATTACK_RADIUS = 500;
export const SHIELD_RESPAWN_HOURS = 168;            // 7 days
export const OPEN_PHASE_TIMEOUT_HOURS = 4;
export const WAVE_INTERVAL_SECONDS = 60;

// Monument HP/Shield arrays by level (index 0 unused)
export const MONUMENT_HP = [
  0, 50000, 120000, 280000, 600000, 1200000,
  2500000, 5000000, 10000000, 22000000, 40000000,
];
export const MONUMENT_SHIELD_HP = [
  0, 8000, 20000, 50000, 120000, 300000,
  700000, 1500000, 3500000, 6000000, 10000000,
];
export const MONUMENT_SHIELD_DPS_THRESHOLD = [
  0, 400, 900, 1800, 3500, 7000,
  12000, 20000, 30000, 38000, 40000,
];
export const MONUMENT_DPS_WINDOW_MS = 3000;

// Monument gems loot by level
export const MONUMENT_GEMS_LOOT = [
  null,
  { min: 2,   max: 8    }, // lv1
  { min: 5,   max: 15   }, // lv2
  { min: 10,  max: 25   }, // lv3
  { min: 20,  max: 50   }, // lv4
  { min: 40,  max: 90   }, // lv5
  { min: 70,  max: 150  }, // lv6
  { min: 120, max: 250  }, // lv7
  { min: 200, max: 400  }, // lv8
  { min: 300, max: 600  }, // lv9
  { min: 500, max: 1000 }, // lv10
];

// Monument items loot: trophy = top damage, gift = others
export const MONUMENT_ITEMS_LOOT = [
  null,
  { trophy: [{ count: 3, rarity: 'rare' }], gift: [{ count: 1, rarity: 'rare' }] },
  { trophy: [{ count: 4, rarity: 'rare' }], gift: [{ count: 2, rarity: 'rare' }] },
  { trophy: [{ count: 3, rarity: 'rare' }, { count: 1, rarity: 'epic' }], gift: [{ count: 2, rarity: 'rare' }, { count: 1, rarity: 'epic' }] },
  { trophy: [{ count: 4, rarity: 'rare' }, { count: 1, rarity: 'epic' }], gift: [{ count: 3, rarity: 'rare' }, { count: 1, rarity: 'epic' }] },
  { trophy: [{ count: 3, rarity: 'epic' }, { count: 2, rarity: 'rare' }], gift: [{ count: 2, rarity: 'epic' }, { count: 2, rarity: 'rare' }] },
  { trophy: [{ count: 4, rarity: 'epic' }, { count: 1, rarity: 'rare' }], gift: [{ count: 3, rarity: 'epic' }, { count: 1, rarity: 'rare' }] },
  { trophy: [{ count: 5, rarity: 'epic' }], gift: [{ count: 3, rarity: 'epic' }, { count: 2, rarity: 'rare' }] },
  { trophy: [{ count: 4, rarity: 'epic' }, { count: 1, rarity: 'mythic' }], gift: [{ count: 4, rarity: 'epic' }] },
  { trophy: [{ count: 5, rarity: 'epic' }, { count: 1, rarity: 'mythic' }], gift: [{ count: 4, rarity: 'epic' }, { count: 1, rarity: 'mythic' }] },
  { trophy: [{ count: 6, rarity: 'epic' }, { count: 1, rarity: 'mythic' }, { count: 1, rarity: 'legendary', chance: 0.15 }], gift: [{ count: 5, rarity: 'epic' }, { count: 1, rarity: 'mythic', chance: 0.10 }, { count: 1, rarity: 'legendary', chance: 0.05 }] },
];

// Monument core drop table: chance (0-1), min/max cores per raid
export const MONUMENT_CORES_LOOT = [
  null,
  { chance: 0.10, min: 1, max: 1 }, // lv1
  { chance: 0.15, min: 1, max: 1 }, // lv2
  { chance: 0.25, min: 1, max: 2 }, // lv3
  { chance: 0.35, min: 1, max: 2 }, // lv4
  { chance: 0.45, min: 1, max: 3 }, // lv5
  { chance: 0.55, min: 2, max: 3 }, // lv6
  { chance: 0.65, min: 2, max: 4 }, // lv7
  { chance: 0.75, min: 2, max: 4 }, // lv8
  { chance: 0.85, min: 3, max: 5 }, // lv9
  { chance: 0.95, min: 3, max: 5 }, // lv10
];
export function getShieldRegen(level) {
  return (MONUMENT_SHIELD_DPS_THRESHOLD[level] || 0) * 1.2;
}

// ── Monument wave system ──
export const MONUMENT_WAVE_COUNTS = {
  1:[5,7,10], 2:[5,8,11], 3:[6,9,13], 4:[7,10,15], 5:[8,12,18],
  6:[9,14,21], 7:[10,16,25], 8:[12,19,30], 9:[13,22,35], 10:[15,25,40],
};
export const MONUMENT_DEFENDER_HP = {
  1:200, 2:400, 3:800, 4:1500, 5:3000,
  6:5000, 7:8000, 8:12000, 9:15000, 10:17500,
};
export const MONUMENT_DEFENDER_DAMAGE = 100;
export const MONUMENT_DEFENDER_ATTACK_CD = 1000;
export const MONUMENT_DEFENDER_SPEED = 14;       // м/с (~50 км/ч)
export const MONUMENT_WAVE_REGEN_PERCENT = 0.01; // 1%/сек
export const MONUMENT_WAVE_TRIGGERS = [75, 50, 25];
export const PLAYER_RESPAWN_TIME = 30000;         // 30с
export const WAVE_EMOJIS = {
  1: ['🧟','🧟‍♂️','🧟‍♀️','👻','💀'],
  2: ['👹','😡','🧌','👿','☠️'],
  3: ['☠️','💀','🧛🏻‍♂️','🐲','👾'],
};

// ── Clans ──
export const CLAN_HQ_COST = 10_000_000;
export const CLAN_CREATE_COST = 0;
export const CLAN_LEAVE_COOLDOWN = 72 * 60 * 60 * 1000;
export const LEADER_INACTIVE_DAYS = 7;

// ── Vases ──
export const BREAK_RADIUS = 200;

// ── Gear direct purchase ──
export const GEAR_PRICES = {
  mythic_sword: 600,
  mythic_axe: 600,
  mythic_shield: 600,
  mythic_set: 1500,
};

// ── Star packs ──
export const STAR_PACKS = [
  { diamonds: 100,  stars: 1,    label: 'Стартовый', label_en: 'Starter' },
  { diamonds: 300,  stars: 200,  label: 'Базовый', label_en: 'Basic' },
  { diamonds: 700,  stars: 400,  label: '🔥 Популярный', label_en: '🔥 Popular', badge: 'ПОПУЛЯРНЫЙ', badge_en: 'POPULAR' },
  { diamonds: 1500, stars: 800,  label: 'Продвинутый', label_en: 'Advanced' },
  { diamonds: 3500, stars: 1800, label: 'Премиум', label_en: 'Premium' },
  { diamonds: 8000, stars: 4000, label: 'Кит', label_en: 'Whale', badge: 'ВЫГОДНО 👑', badge_en: 'BEST VALUE 👑' },
];

// ── Core packs ──
export const CORE_PACKS = [
  { label: '🌀 Стартовый', label_en: '🌀 Starter', cores: 3, core_level: 0, ether: 0, price: 300 },
  { label: '🌀 Боевой', label_en: '🌀 Combat', cores: 5, core_level: 0, ether: 500, price: 750 },
  { label: '🌀 Продвинутый', label_en: '🌀 Advanced', cores: 3, core_level: 5, ether: 2000, price: 1500 },
  { label: '🌀 Элитный', label_en: '🌀 Elite', cores: 5, core_level: 10, ether: 5000, price: 3000, badge: 'ТОП', badge_en: 'TOP' },
];

// ── Cosmetic prices ──
export const COSMETIC_PRICES = {
  rename_player: 50,
  reavatar_player: 50,
  rename_clan: 150,
  reavatar_clan: 150,
};

// ── Inventory slots ──
export const INVENTORY_BASE_SLOTS = 200;
export const INVENTORY_SLOT_PACKS = [
  { slots: 10,  price: 20 },
  { slots: 50,  price: 80 },
  { slots: 100, price: 140 },
  { slots: 200, price: 250 },
];
export const INVENTORY_MAX_SLOTS = 600;

// ── Clan HQ upgrade costs ──
export const CLAN_HQ_UPGRADE_COSTS = [0, 2000, 4000, 8000, 14000, 24000, 40000, 66000, 108000, 234000];
export const CLAN_MAX_MEMBERS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
export const CLAN_BOOST_PRICES = [250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500];

// ── Collector upgrade prices ──
export const COLLECTOR_UPGRADE_PRICES = [0, 30, 50, 75, 100, 130, 160, 200, 250, 300];

// ═══════════════════════════════════════════════════════
//  Zombie Hordes
// ═══════════════════════════════════════════════════════

export const ZOMBIE_WAVE_COUNTS = [
  0, 5, 10, 15, 25, 40, 55, 70, 90, 120, 150,
];

export function getZombieCount(wave) {
  if (wave <= 10) return ZOMBIE_WAVE_COUNTS[wave] || 5;
  return 150 + (wave - 10) * 20;
}

export function getZombieBossCount(wave) {
  if (wave % 5 !== 0) return 0;
  return wave / 5;
}

export const ZOMBIE_FORMATIONS = {
  1: 'cluster', 2: 'cluster', 3: 'line', 4: 'two_sides', 5: 'cluster',
  6: 'three_sides', 7: 'surround', 8: 'chaos', 9: 'surround', 10: 'chaos',
};

export function getZombieFormation(wave) {
  if (wave <= 10) return ZOMBIE_FORMATIONS[wave] || 'chaos';
  return wave % 2 === 0 ? 'surround' : 'chaos';
}

export const ZOMBIE_SCOUT_HP = 30;
export const ZOMBIE_SCOUT_SPEED = 1.5;
export const ZOMBIE_SCOUT_EMOJI = '🧟';

export const ZOMBIE_NORMAL_SPEED = 15;  // m/s — fast
export const ZOMBIE_NORMAL_DAMAGE = 80;
export const ZOMBIE_BOSS_SPEED = 10;
export const ZOMBIE_BOSS_DAMAGE_MULTIPLIER = 3;
export const ZOMBIE_BOSS_EMOJI = '💀';
export const ZOMBIE_SPAWN_RADIUS = 700; // meters from player
export const ZOMBIE_ATTACK_RANGE = 450; // meters — ranged attack like defenders
export const ZOMBIE_ATTACK_INTERVAL = 1000; // 1 second

// HP scales with wave
export function getZombieHp(wave) { return 100 + (wave - 1) * 500; }
export function getZombieBossHp(wave) { return Math.floor(wave / 5) * 5000; }

export const ZOMBIE_EMOJIS = ['🧟', '🧟‍♂️', '🧟‍♀️'];

export function getZombieXp(playerLevel) {
  const min = playerLevel * 1;
  const max = playerLevel * 10;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function getZombieBossXp(playerLevel) {
  const min = playerLevel * 100;
  const max = playerLevel * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function getZombieLoot() {
  const count = Math.floor(Math.random() * 4);
  if (count === 0) return null;
  const currency = Math.random() < 0.5 ? 'shards' : 'ether';
  return { count, currency };
}

export function getZombieBossLoot() {
  const count = Math.floor(Math.random() * 151) + 50;
  const currency = Math.random() < 0.5 ? 'shards' : 'ether';
  return { count, currency };
}

export const ZOMBIE_HORDE_TIMEOUT = 300000; // 5 minutes
