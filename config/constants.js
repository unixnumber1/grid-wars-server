// ═══════════════════════════════════════════════════════
//  All game constants in one place
// ═══════════════════════════════════════════════════════

// ── Radii ──
export const SMALL_RADIUS = 200;       // meters — build, collect, vases
export const LARGE_RADIUS = 500;       // meters — attack bots, PvP, attack mines

// ── Admin ──
export const ADMIN_TG_ID = 560013667;

// ── H3 grid ──
export const H3_RESOLUTION = 10;       // ~65m hexes
export const MINE_DISK_K = 12;

// ── Mine limits ──
export const MINE_MAX_LEVEL = 200;
export const HQ_MAX_LEVEL = 10;
export const HQ_COIN_LIMIT = 1_000_000;

// ── Weapon cooldowns (ms) — disabled ──
export const WEAPON_COOLDOWNS = { sword: 0, axe: 0, none: 0 };
export const ATTACK_COOLDOWN_SWORD = 0;
export const ATTACK_COOLDOWN_AXE = 0;

// ── Player base stats ──
export const BASE_PLAYER_ATTACK = 10;
export const BASE_PLAYER_HP = 1000;
export const ONLINE_MS = 3 * 60 * 1000; // 3 minutes

// ── Bots ──
export const BOTS_PER_ZONE = 10;
export const BOT_TTL_MS = 5 * 60 * 1000;
export const GLOBAL_BOT_CAP = 20;
export const BOT_SPEED_METERS = { slow: 15, medium: 30, fast: 55, very_fast: 90 };
export const DRAIN_LIMITS = { spirit: 50, goblin: 150, werewolf: 400, demon: 1000, dragon: 3000, boss: 10000 };

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
export function getShieldRegen(level) {
  return (MONUMENT_SHIELD_DPS_THRESHOLD[level] || 0) * 1.2;
}

// ── Clans ──
export const CLAN_HQ_COST = 10_000_000;
export const CLAN_CREATE_COST = 0;
export const CLAN_LEAVE_COOLDOWN = 72 * 60 * 60 * 1000;
export const LEADER_INACTIVE_DAYS = 7;

// ── Vases ──
export const BREAK_RADIUS = 200;

// ── Defender movement ──
export const DEFENDER_SPEED = 20; // meters per tick (5s)

// ── Gear direct purchase ──
export const GEAR_PRICES = {
  mythic_sword: 600,
  mythic_axe: 600,
  mythic_shield: 600,
  mythic_set: 1500,
};

// ── Star packs ──
export const STAR_PACKS = [
  { diamonds: 100,  stars: 75,   label: 'Стартовый' },
  { diamonds: 300,  stars: 200,  label: 'Базовый' },
  { diamonds: 700,  stars: 400,  label: '🔥 Популярный', badge: 'ПОПУЛЯРНЫЙ' },
  { diamonds: 1500, stars: 800,  label: 'Продвинутый' },
  { diamonds: 3500, stars: 1800, label: 'Премиум' },
  { diamonds: 8000, stars: 4000, label: 'Кит', badge: 'ВЫГОДНО 👑' },
];

// ── Core packs ──
export const CORE_PACKS = [
  { label: '🌀 Стартовый', cores: 3, core_level: 0, ether: 0, price: 300 },
  { label: '🌀 Боевой', cores: 5, core_level: 0, ether: 500, price: 750 },
  { label: '🌀 Продвинутый', cores: 3, core_level: 5, ether: 2000, price: 1500 },
  { label: '🌀 Элитный', cores: 5, core_level: 10, ether: 5000, price: 3000, badge: 'ТОП' },
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
