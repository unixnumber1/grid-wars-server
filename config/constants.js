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
export const DRAIN_LIMITS = { spirit: 50, goblin: 150, werewolf: 400, demon: 1000, dragon: 3000, boss: 10000 };

// ── Game loop ──
export const TICK_INTERVAL = 5000;
export const PERSIST_INTERVAL = 30_000;

// ── PvP ──
export const PVP_SHIELD_DURATION_MS = 2 * 60 * 1000;     // 2 minutes after death
export const PVP_COOLDOWN_MS = 30 * 60 * 1000;           // 30 minutes
export const PVP_COIN_LOSS_PERCENT = 0.10;                // 10% coins lost
export const PVP_COIN_WINNER_SHARE = 0.50;                // 50% of lost goes to winner

// ── Player rename ──
export const RENAME_COST_DIAMONDS = 10;
export const USERNAME_RE = /^[a-zA-Zа-яА-ЯёЁ0-9_]+$/;

// ── Items ──
export const BOX_PRICES = { rare: 5, epic: 30 };
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
export const COLLECTOR_COST_DIAMONDS = 75;
export const COLLECTOR_SELL_DIAMONDS = 37;
export const COLLECTOR_RADIUS = 200;               // meters
export const COLLECTOR_DELIVERY_COMMISSION = 0.10;  // 10%

// ── Monuments ──
export const MONUMENT_ATTACK_RADIUS = 500;
export const SHIELD_RESPAWN_HOURS = 168;            // 7 days
export const OPEN_PHASE_TIMEOUT_HOURS = 4;
export const WAVE_INTERVAL_SECONDS = 60;

// ── Clans ──
export const CLAN_HQ_COST = 10_000_000;
export const CLAN_CREATE_COST = 0;
export const CLAN_LEAVE_COOLDOWN = 72 * 60 * 60 * 1000;
export const LEADER_INACTIVE_DAYS = 7;

// ── Vases ──
export const BREAK_RADIUS = 200;

// ── Defender movement ──
export const DEFENDER_SPEED = 20; // meters per tick (5s)
