// ═══════════════════════════════════════════════════════
//  All game constants in one place
// ═══════════════════════════════════════════════════════

// ── Radii ──
export const SMALL_RADIUS = 200;       // meters — build, collect, vases
export const LARGE_RADIUS = 500;       // meters — attack bots, PvP, attack mines
export const MINE_BOOST_RADIUS = 20000; // meters — mine count boost radius (20km)
export const PIN_DURATION_MS = 60 * 60 * 1000; // 1 hour PIN session

// ── Admin ──
export const ADMIN_TG_ID = parseInt(process.env.ADMIN_TG_ID || '560013667', 10);

// ── H3 grid ──
export const H3_RESOLUTION = 10;       // ~65m hexes
export const MINE_DISK_K = 12;

// ── Mine limits ──
export const MINE_MAX_LEVEL = 200;
export const HQ_MAX_LEVEL = 10;

// ── Weapon cooldowns (ms) ──
export const WEAPON_COOLDOWNS = { sword: 500, axe: 700, none: 200 };

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
export const BOX_PRICES = { rare: 10, epic: 40, mythic: 150 };
export const ITEM_TYPES = ['sword', 'axe', 'shield'];
export const MAX_INVENTORY_SLOTS = 200;

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
export const ORE_MIN_DISTANCE = 500;                // min distance between ore nodes (was 200)
export const ORE_ZONE_RADIUS = 5000;                // 5km zone for clustering
export const VASE_MIN_DISTANCE = 100;               // min distance between vases (meters)

// Ore types (4 tiers)
export const ORE_TYPES = {
  hill:     { emoji: '⛰',  spawnWeight: 50, levels: [1, 2],  incomeMultiplier: 1,   hpBase: 1000, hpPerLevel: 500,  dualCurrency: false, canErupt: false },
  mountain: { emoji: '🏔', spawnWeight: 30, levels: [3, 5],  incomeMultiplier: 1.5, hpBase: 2000, hpPerLevel: 800,  dualCurrency: false, canErupt: false },
  peak:     { emoji: '🗻', spawnWeight: 15, levels: [6, 8],  incomeMultiplier: 2.5, hpBase: 3000, hpPerLevel: 1200, dualCurrency: true,  canErupt: false },
  volcano:  { emoji: '🌋', spawnWeight: 5,  levels: [9, 10], incomeMultiplier: 4,   hpBase: 5000, hpPerLevel: 2000, dualCurrency: true,  canErupt: true  },
};
export const VOLCANO_ERUPTION_MAX_CHANCE = 90;       // % per day at cap
export const VOLCANO_ERUPTION_RAMP_DAYS = 20;        // days from 0% to max chance
export const MIN_ORE_PER_CITY = 10;
export const ORE_PER_PLAYER = 8;
export const MAX_ORE_PER_CITY = 150;

// ── Collectors ──
export const COLLECTOR_COST_DIAMONDS = 25;
export const COLLECTOR_SELL_DIAMONDS = 37;
export const COLLECTOR_RADIUS = 200;               // meters
export const COLLECTOR_DELIVERY_COMMISSION = 0;      // 0% (commission disabled)
export const COLLECTOR_EXTINGUISH_COST = 5;          // diamonds to extinguish

// ── Barracks ──
export const BARRACKS_BUILD_COST = 50;               // diamonds
export const BARRACKS_MIN_HQ_LEVEL = 5;
export const BARRACKS_BASE_TRAIN_TIME_MS = 30 * 60 * 1000; // 30 min

export const BARRACKS_LEVELS = {
  1:  { hp: 3000,  upgradeCost: 0,   slots: 1 },
  2:  { hp: 4500,  upgradeCost: 80,  slots: 1 },
  3:  { hp: 6500,  upgradeCost: 100, slots: 2 },
  4:  { hp: 9000,  upgradeCost: 120, slots: 2 },
  5:  { hp: 12000, upgradeCost: 140, slots: 3 },
  6:  { hp: 16000, upgradeCost: 160, slots: 3 },
  7:  { hp: 21000, upgradeCost: 180, slots: 4 },
  8:  { hp: 27000, upgradeCost: 200, slots: 4 },
  9:  { hp: 34000, upgradeCost: 220, slots: 5 },
  10: { hp: 42000, upgradeCost: 250, slots: 5 },
};

// Scout unit
export const SCOUT_TRAIN_SPEED_MUL = [0, 1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]; // training time multiplier by scout level
export const SCOUT_TRAIN_COST =   [0, 500, 600, 800, 1000, 1300, 1600, 2000, 2300, 2600, 3000]; // crystals by level
export const SCOUT_UPGRADE_COST = [0, 0, 5000, 12000, 25000, 50000, 80000, 150000, 250000, 350000, 500000]; // ether by level
export const SCOUT_SPEED_KMH =    [0, 20, 22, 25, 28, 32, 36, 40, 45, 50, 55];
export const SCOUT_CAPTURE_MIN =   [0, 20, 18, 16, 14, 12, 10, 8, 6, 4, 2]; // minutes
export const SCOUT_HP =            [0, 200, 350, 550, 800, 1100, 1500, 2000, 2700, 3500, 5000];
export const SCOUT_MAX_RANGE_KM = 20;
export const SCOUT_KILL_REWARD_CRYSTALS = 50;

// Scout ore access: min level required per ore type
export const SCOUT_ORE_ACCESS = { hill: 1, mountain: 3, peak: 7, volcano: 10 };

// ── Monuments ──
export const MONUMENT_ATTACK_RADIUS = 500;
export const SHIELD_RESPAWN_HOURS = 168;            // 7 days (legacy fallback)
export const OPEN_PHASE_TIMEOUT_HOURS = 4;
export const WAVE_INTERVAL_SECONDS = 60;

// Dynamic respawn: index = current level, value = hours until respawn
// lv10 defeated → resets to lv1 with 24h respawn
export const MONUMENT_RESPAWN_HOURS_PER_LEVEL = [0, 24, 48, 72, 96, 120, 144, 168, 192, 216, 24];
// Days of inactivity (shield phase, not defeated) before monument decays to lv1
export const MONUMENT_DECAY_DAYS = 7;

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

// Monument items loot: pool = shared item pool for all participants, trophyBonus = extra for top-1 damage dealer
export const MONUMENT_ITEMS_LOOT = [
  null,
  { pool: [{ count: 5, rarity: 'rare' }],                                                                                    trophyBonus: { count: 1, rarity: 'rare' } },                    // lv1
  { pool: [{ count: 7, rarity: 'rare' }],                                                                                    trophyBonus: { count: 1, rarity: 'rare' } },                    // lv2
  { pool: [{ count: 6, rarity: 'rare' }, { count: 2, rarity: 'epic' }],                                                      trophyBonus: { count: 1, rarity: 'epic' } },                    // lv3
  { pool: [{ count: 5, rarity: 'rare' }, { count: 4, rarity: 'epic' }],                                                      trophyBonus: { count: 1, rarity: 'epic' } },                    // lv4
  { pool: [{ count: 5, rarity: 'rare' }, { count: 6, rarity: 'epic' }],                                                      trophyBonus: { count: 1, rarity: 'epic' } },                    // lv5
  { pool: [{ count: 2, rarity: 'rare' }, { count: 8, rarity: 'epic' }],                                                      trophyBonus: { count: 1, rarity: 'epic' } },                    // lv6
  { pool: [{ count: 9, rarity: 'epic' }],                                                                                    trophyBonus: { count: 1, rarity: 'mythic' } },                  // lv7
  { pool: [{ count: 9, rarity: 'epic' }, { count: 1, rarity: 'mythic' }],                                                    trophyBonus: { count: 1, rarity: 'mythic' } },                  // lv8
  { pool: [{ count: 10, rarity: 'epic' }, { count: 3, rarity: 'mythic' }],                                                   trophyBonus: { count: 1, rarity: 'mythic' } },                  // lv9
  { pool: [{ count: 13, rarity: 'epic' }, { count: 2, rarity: 'mythic' }, { count: 1, rarity: 'legendary', chance: 0.15 }],  trophyBonus: { count: 1, rarity: 'legendary', chance: 0.20 } }, // lv10
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
// Shield regen per second (requires sustained group DPS above this to break)
export const MONUMENT_SHIELD_REGEN_PER_SEC = [
  0, 500, 1000, 1500, 2000, 3000,
  4000, 7000, 10500, 15000, 17000,
];
export function getShieldRegen(level) {
  return MONUMENT_SHIELD_REGEN_PER_SEC[level] || 0;
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
export const PLAYER_RESPAWN_TIME = 10000;         // 10с
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
  { diamonds: 100,  stars: 119,  label: 'Стартовый', label_en: 'Starter' },
  { diamonds: 400,  stars: 459,  label: '🔥 Популярный', label_en: '🔥 Popular', badge: 'ПОПУЛЯРНЫЙ', badge_en: 'POPULAR' },
  { diamonds: 1200, stars: 1249, label: 'Премиум', label_en: 'Premium' },
  { diamonds: 3000, stars: 2999, label: 'Кит', label_en: 'Whale', badge: 'ВЫГОДНО 👑', badge_en: 'BEST VALUE 👑' },
];

// ── Core packs ──
export const CORE_PACKS = [
  { label: '💰 Бизнесмен', label_en: '💰 Businessman', cores: [
    { type: 'income', count: 3 },
    { type: 'capacity', count: 2 },
  ], ether: 5000, price: 1200 },
  { label: '🛡️ Защитник', label_en: '🛡️ Defender', cores: [
    { type: 'hp', count: 3 },
    { type: 'regen', count: 2 },
  ], ether: 5000, price: 900 },
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
export const INVENTORY_SLOT_PRICE = 5; // diamonds per extra slot
export const INVENTORY_MAX_SLOTS = 600;

// ── Clan HQ upgrade costs ──
export const CLAN_HQ_UPGRADE_COSTS = [0, 2000, 4000, 7000, 12000, 20000, 32000, 48000, 72000, 103000];
export const CLAN_MAX_MEMBERS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
export const CLAN_BOOST_PRICES = [100, 300, 500, 700, 950, 1150, 1400, 1600, 1800, 2000];

// ── Collector upgrade prices ──
export const COLLECTOR_UPGRADE_PRICES = [0, 25, 30, 35, 40, 50, 55, 65, 75, 100];

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

// ═══════════════════════════════════════════════════════
//  Walking rewards
// ═══════════════════════════════════════════════════════
export const WALK_SPEED_LIMIT_KMH = 25;
export const WALK_MIN_DISTANCE_M = 5;
export const WALK_MAX_DISTANCE_M = 2000;
export const WALK_DAILY_THRESHOLDS = [1000, 3000, 7000]; // meters
export const WALK_WEEKLY_THRESHOLDS = [15000, 30000, 50000]; // meters

export const WALK_DAILY_REWARD_POOLS = [
  { type: 'diamonds', values: [1, 2, 3] },
  { type: 'shards',   values: [50, 100, 150] },
  { type: 'ether',    values: [50, 100, 150] },
];

export const WALK_WEEKLY_REWARDS = [
  { diamonds: 5, shards: 200 },
  { diamonds: 8, ether: 300 },
  { boxes: ['rare'], cores: [{ level: 0 }] },
];

// ═══════════════════════════════════════════════════════
//  Antispoof
// ═══════════════════════════════════════════════════════
export const ANTISPOOF = {
  MAX_SPEED_KMH: 200,
  PIN_MAX_DISTANCE_KM: 20,
  PIN_GRACE_MS: 5000,                // grace window for PIN socket race condition
  MIN_UPDATE_INTERVAL_MS: 1000,
  POSITION_HISTORY_SIZE: 20,
  VIOLATION_THRESHOLD: 50,
  BAN_DAYS: 30,

  // Cross-session teleport
  SESSION_MAX_SPEED_KMH: 250,
  SESSION_GAP_MIN_MS: 60000,

  // Jamming detection
  JAMMING_ACCURACY_THRESHOLD: 300,   // meters
  JAMMING_JUMP_KM: 0.5,             // was 2km — lowered for Russian GPS jamming
  JAMMING_COOLDOWN_MS: 60000,        // base cooldown 60s
  JAMMING_MAX_COOLDOWN_MS: 300000,   // adaptive cap 5 min
  SNAP_BACK_RADIUS_M: 300,           // GPS recovery detection radius
  OSCILLATION_RADIUS_M: 500,         // bounce-back detection radius

  // GPS instability score (0-100)
  INSTABILITY_DECAY_PER_UPDATE: 2,
  INSTABILITY_MODERATE: 20,          // double speed threshold
  INSTABILITY_SEVERE: 40,            // suppress speed violations entirely

  // Joystick detection
  JITTER_THRESHOLD: 2,
  CONST_SPEED_WINDOW: 8,
  CONST_SPEED_TOLERANCE: 0.03,
  SUSPICIOUS_ACCURACY: 3,
  JOYSTICK_SCORE_THRESHOLD: 80,
};
