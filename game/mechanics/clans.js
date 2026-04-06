import { haversine } from '../../lib/haversine.js';
import { gameState } from '../state/GameState.js';

export const CLAN_LEVELS = [
  { level: 1,  radius: 75,  income: 5,  defense: 10, maxMembers: 20,  cost: 0,      boostCost: 100,  boostMul: 2.0 },
  { level: 2,  radius: 100, income: 8,  defense: 15, maxMembers: 23,  cost: 2000,   boostCost: 300,  boostMul: 2.2 },
  { level: 3,  radius: 125, income: 11, defense: 20, maxMembers: 27,  cost: 4000,   boostCost: 500,  boostMul: 2.5 },
  { level: 4,  radius: 150, income: 14, defense: 26, maxMembers: 30,  cost: 7000,   boostCost: 700,  boostMul: 2.8 },
  { level: 5,  radius: 175, income: 17, defense: 32, maxMembers: 33,  cost: 12000,  boostCost: 950,  boostMul: 3.2 },
  { level: 6,  radius: 200, income: 20, defense: 38, maxMembers: 37,  cost: 20000,  boostCost: 1150, boostMul: 3.6 },
  { level: 7,  radius: 225, income: 23, defense: 45, maxMembers: 40,  cost: 32000,  boostCost: 1400, boostMul: 4.0 },
  { level: 8,  radius: 250, income: 26, defense: 52, maxMembers: 43,  cost: 48000,  boostCost: 1600, boostMul: 4.5 },
  { level: 9,  radius: 275, income: 28, defense: 62, maxMembers: 47,  cost: 72000,  boostCost: 1800, boostMul: 5.0 },
  { level: 10, radius: 300, income: 30, defense: 75, maxMembers: 50,  cost: 103000, boostCost: 2000, boostMul: 5.5 },
];

export const CLAN_HQ_COST = 10000000;
export const CLAN_CREATE_COST = 0;
export const CLAN_LEAVE_COOLDOWN = 72 * 60 * 60 * 1000;
export const LEADER_INACTIVE_DAYS = 7;

export function getClanLevel(level) {
  return CLAN_LEVELS.find(l => l.level === level) || CLAN_LEVELS[0];
}

export function isInClanZone(playerLat, playerLng, hqLat, hqLng, clanLevel) {
  const config = getClanLevel(clanLevel);
  const dist = haversine(playerLat, playerLng, hqLat, hqLng);
  return dist <= config.radius;
}

export function getClanDefenseForMine(ownerId, mineLat, mineLng) {
  if (!ownerId || !gameState.loaded) return 1;
  const owner = gameState.getPlayerById(ownerId);
  if (!owner?.clan_id) return 1;
  const clan = gameState.clans.get(owner.clan_id);
  if (!clan?.level) return 1;
  const cfg = CLAN_LEVELS.find(c => c.level === clan.level);
  if (!cfg) return 1;
  for (const ch of gameState.clanHqs.values()) {
    if (ch.clan_id === owner.clan_id && haversine(mineLat, mineLng, ch.lat, ch.lng) <= cfg.radius) {
      return 1 + cfg.defense / 100;
    }
  }
  return 1;
}

export const ALLOWED_CLAN_COLORS = [
  '#FF1744', '#FF6D00', '#FFD700', '#00E676',
  '#00B0FF', '#2979FF', '#651FFF', '#D500F9',
  '#FF4081', '#FFFFFF', '#607D8B', '#795548',
];

/**
 * Calculate total income for a player's mines, applying clan bonuses if applicable.
 * @param {Array} playerMines - array of mine objects with .level, .lat, .lng
 * @param {Function} getMineIncome - income formula function
 * @param {string|null} clanId - player's clan_id (may be null)
 * @param {object} supabase - supabase client (used as fallback if gameState not loaded)
 * @returns {{ total: number, boostExpiresAt: string|null, boostMultiplier: number|null }}
 */
export async function calcTotalIncomeWithClanBonus(playerMines, getMineIncome, clanId, supabase) {
  let baseTotal = playerMines.reduce((sum, m) => sum + getMineIncome(m.level, m), 0);
  let boostExpiresAt = null;
  let boostMultiplier = null;

  if (!clanId) return { total: baseTotal, boostExpiresAt, boostMultiplier };

  // Try gameState first
  let clan = gameState.loaded ? gameState.getClanById(clanId) : null;

  // Fallback to DB if not in gameState
  if (!clan && supabase) {
    try {
      const { data } = await supabase.from('clans').select('id,level,boost_expires_at,boost_multiplier').eq('id', clanId).maybeSingle();
      clan = data;
    } catch (_) {}
  }

  if (!clan) return { total: baseTotal, boostExpiresAt, boostMultiplier };

  const clanCfg = getClanLevel(clan.level || 1);
  const incomeBonus = clanCfg.income || 0; // percent bonus e.g. 5 = +5%

  // Find ALL clan HQs to determine zones
  const clanHqList = [];
  if (gameState.loaded) {
    for (const ch of gameState.clanHqs.values()) {
      if (ch.clan_id === clanId) clanHqList.push(ch);
    }
  }

  let total = 0;
  for (const mine of playerMines) {
    let inc = getMineIncome(mine.level, mine);
    // Apply income_bonus if mine is in ANY clan HQ zone
    if (clanHqList.length > 0 && incomeBonus > 0) {
      const inZone = clanHqList.some(hq => haversine(mine.lat, mine.lng, hq.lat, hq.lng) <= clanCfg.radius);
      if (inZone) {
        inc = Math.round(inc * (1 + incomeBonus / 100));
      }
    }
    total += inc;
  }

  // Apply active boost multiplier
  const now = Date.now();
  if (clan.boost_expires_at && new Date(clan.boost_expires_at).getTime() > now) {
    const mul = clan.boost_multiplier || 1;
    total = Math.round(total * mul);
    boostExpiresAt = clan.boost_expires_at;
    boostMultiplier = mul;
  }

  return { total, boostExpiresAt, boostMultiplier };
}
