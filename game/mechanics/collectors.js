import { gameState } from '../state/GameState.js';
import { haversine } from '../../lib/haversine.js';
import { getMineIncome, getMineUpgradeCost, getMineHp, getMineCapacity, getMineCountBoost, SMALL_RADIUS } from '../../config/formulas.js';
import { supabase } from '../../lib/supabase.js';
import {
  COLLECTOR_COST_DIAMONDS, COLLECTOR_RADIUS,
  COLLECTOR_DELIVERY_COMMISSION, COLLECTOR_EXTINGUISH_COST, COLLECTOR_SELL_REFUND_PCT,
  MINE_BOOST_RADIUS,
} from '../../config/constants.js';
import { getPlayerSkillEffects } from '../../config/skills.js';
import { getCoresTotalBoost } from './cores.js';
import { getClanLevel } from './clans.js';

// Re-export for backward compat (lib/collectors.js re-exports this file)
export { COLLECTOR_COST_DIAMONDS, COLLECTOR_RADIUS, COLLECTOR_DELIVERY_COMMISSION, COLLECTOR_EXTINGUISH_COST, COLLECTOR_SELL_REFUND_PCT };

// Owner-online window: matches GameState (3 min since last_seen).
// Read directly from player.last_seen — no server.js import to avoid circular deps with tests.
const OWNER_ONLINE_MS = 3 * 60 * 1000;
function isOwnerOnline(owner) {
  if (!owner?.last_seen) return false;
  return (Date.now() - new Date(owner.last_seen).getTime()) < OWNER_ONLINE_MS;
}

/**
 * Build the per-cycle context for a collector once: owner, skill effects,
 * clan config, clan HQ list, online flag. Used by autoCollect / getCollectorCapacity.
 */
function getOwnerContext(collector) {
  const owner = gameState.getPlayerById(collector.owner_id) || null;
  const skillRow = owner ? gameState.getPlayerSkills(Number(owner.telegram_id)) : null;
  const skillFx = skillRow ? getPlayerSkillEffects(skillRow) : {};
  let clanCfg = null;
  let clanHqList = [];
  let clanBoostMul = 1;
  if (owner?.clan_id) {
    const clan = gameState.clans.get(owner.clan_id);
    if (clan) {
      clanCfg = getClanLevel(clan.level || 1);
      for (const ch of gameState.clanHqs.values()) {
        if (ch.clan_id === owner.clan_id) clanHqList.push(ch);
      }
      if (clan.boost_expires_at && new Date(clan.boost_expires_at) > new Date()) {
        clanBoostMul = clan.boost_multiplier || 1;
      }
    }
  }
  return { owner, skillFx, clanCfg, clanHqList, clanBoostMul, ownerOnline: isOwnerOnline(owner) };
}

// Max mine level that collector can auto-upgrade to, by collector level
export const COLLECTOR_MAX_MINE_LEVEL = {
  1: 20, 2: 40, 3: 60, 4: 80, 5: 100,
  6: 120, 7: 140, 8: 160, 9: 180, 10: 200,
};

// Collection interval in ms per collector level (3× faster than before so online players see progress)
// lv1=20min, -2min per level, lv10=2min
export const COLLECTOR_INTERVAL_MS = {
  1: 20 * 60000, 2: 18 * 60000, 3: 16 * 60000, 4: 14 * 60000, 5: 12 * 60000,
  6: 10 * 60000, 7:  8 * 60000, 8:  6 * 60000, 9:  4 * 60000, 10: 2 * 60000,
};

export const COLLECTOR_LEVELS = {
  1:  { hp: 3000,  upgradeCost: 0 },
  2:  { hp: 5000,  upgradeCost: 500_000 },
  3:  { hp: 8000,  upgradeCost: 1_500_000 },
  4:  { hp: 12000, upgradeCost: 4_500_000 },
  5:  { hp: 18000, upgradeCost: 13_500_000 },
  6:  { hp: 26000, upgradeCost: 40_500_000 },
  7:  { hp: 36000, upgradeCost: 121_000_000 },
  8:  { hp: 50000, upgradeCost: 364_000_000 },
  9:  { hp: 68000, upgradeCost: 1_090_000_000 },
  10: { hp: 90000, upgradeCost: 3_280_000_000 },
};

/**
 * Capacity = sum of getMineCapacity for all owner's mines in radius.
 * Applies the same skill capacity bonus as the manual-collect path so the
 * collector "box" matches what each mine actually holds.
 */
export function getCollectorCapacity(collector, ctx) {
  const _ctx = ctx || getOwnerContext(collector);
  const mines = getCollectorMines(collector, _ctx);
  const skCapMul = 1 + (_ctx.skillFx.mine_capacity_bonus || 0);
  return mines.reduce((sum, m) => {
    const cores = m.cell_id ? gameState.getCoresForMine(m.cell_id) : [];
    const capBoost = cores.length > 0 ? getCoresTotalBoost(cores, 'capacity') : 1;
    return sum + Math.round(getMineCapacity(m.level) * capBoost * skCapMul);
  }, 0);
}

/**
 * Get all mines owned by the collector's owner within radius.
 */
export function getCollectorMines(collector, ctx) {
  const _ctx = ctx || getOwnerContext(collector);
  const radius = COLLECTOR_RADIUS * (1 + (_ctx.skillFx.collector_radius_bonus || 0));
  const mines = [];
  for (const m of gameState.mines.values()) {
    if (m.owner_id !== collector.owner_id) continue;
    if (m.status === 'destroyed' || m.status === 'burning') continue;
    if (haversine(collector.lat, collector.lng, m.lat, m.lng) <= radius) {
      mines.push(m);
    }
  }
  return mines;
}

/**
 * Perform auto-collection for a single collector.
 * Per-mine clock (mine.last_collected) — same source of truth as manual collect,
 * so the two paths cannot double-pay or eat each other's elapsed time.
 * Applies all bonuses that manual collect applies: skill income/capacity, landlord
 * (only while owner is online), clan zone income, clan boost multiplier.
 */
export function autoCollect(collector) {
  const ctx = getOwnerContext(collector);
  const minesInRange = getCollectorMines(collector, ctx);
  if (!minesInRange.length) return 0;

  const nowMs = Date.now();
  const nowISO = new Date(nowMs).toISOString();
  const capacity = getCollectorCapacity(collector, ctx);

  const skIncMul = 1 + (ctx.skillFx.mine_income_bonus || 0);
  const skCapMul = 1 + (ctx.skillFx.mine_capacity_bonus || 0);
  const landlordOn = !!ctx.skillFx.landlord_bonus && ctx.ownerOnline;
  const ownerLat = ctx.owner?.last_lat;
  const ownerLng = ctx.owner?.last_lng;

  // Per-mine cell-aggregate boost: each mine sums levels of nearby owner mines within 20km
  const allOwnerMines = [...gameState.mines.values()].filter(m => m.owner_id === collector.owner_id && m.status !== 'destroyed');
  const R_DEG = MINE_BOOST_RADIUS / 111320;
  const perMineBoost = new Map();
  for (const m of minesInRange) {
    let pts = 0;
    for (const other of allOwnerMines) {
      if (Math.abs(m.lat - other.lat) > R_DEG || Math.abs(m.lng - other.lng) > R_DEG * 1.8) continue;
      if (haversine(m.lat, m.lng, other.lat, other.lng) <= MINE_BOOST_RADIUS) {
        pts += (other.level || 1);
      }
    }
    perMineBoost.set(m.id, getMineCountBoost(pts));
  }

  let totalCollected = 0;
  const collectedMines = [];

  for (const mine of minesInRange) {
    const cores = mine.cell_id ? gameState.getCoresForMine(mine.cell_id) : [];
    const mineBoost = perMineBoost.get(mine.id) || 1;
    let incBoost = (cores.length > 0 ? getCoresTotalBoost(cores, 'income') : 1) * mineBoost;
    const capBoost = cores.length > 0 ? getCoresTotalBoost(cores, 'capacity') : 1;
    // Skill income bonus
    incBoost *= skIncMul;
    // Clan zone bonus + active boost
    if (ctx.clanCfg && ctx.clanHqList.length) {
      const inZone = ctx.clanHqList.some(h => haversine(mine.lat, mine.lng, h.lat, h.lng) <= ctx.clanCfg.radius);
      if (inZone) {
        incBoost *= (1 + (ctx.clanCfg.income || 0) / 100);
        if (ctx.clanBoostMul > 1) incBoost *= ctx.clanBoostMul;
      }
    }
    // Landlord ability — only while owner is online
    if (landlordOn && ownerLat != null && ownerLng != null) {
      if (haversine(ownerLat, ownerLng, mine.lat, mine.lng) <= SMALL_RADIUS) incBoost *= 1.15;
    }

    const income = getMineIncome(mine.level) * incBoost;
    const cap = Math.round(getMineCapacity(mine.level) * capBoost * skCapMul);

    // Per-mine elapsed (NOT collector clock): matches manual collect — no double pay, no lost time
    const lastCollectMs = mine.last_collected ? new Date(mine.last_collected).getTime() : nowMs;
    const elapsedSec = Math.max(0, (nowMs - lastCollectMs) / 1000);
    const fresh = Math.min(Math.floor(income * elapsedSec), cap);
    const banked = mine.coins || 0;
    const accumulated = fresh + banked;
    if (accumulated <= 0) continue;

    const room = capacity - collector.stored_coins - totalCollected;
    if (room <= 0) break;

    const taken = Math.min(accumulated, room);
    totalCollected += taken;
    collectedMines.push({ mine, taken, accumulated });
  }

  if (totalCollected > 0) {
    collector.stored_coins = (collector.stored_coins || 0) + totalCollected;
    // Only advance the interval gate when something was actually collected.
    // If the collector was full and nothing fit, retry on the next tick (60s) instead of waiting another full interval.
    collector.last_collected_at = nowISO;
    gameState.markDirty('collectors', collector.id);

    // For each mine that was paid, advance its clock and store any leftover.
    // Skipped mines (room ran out) keep their original mine.last_collected — no time is lost.
    for (const { mine, taken, accumulated } of collectedMines) {
      const leftover = Math.max(0, accumulated - taken);
      mine.last_collected = nowISO;
      mine.coins = leftover;
      gameState.markDirty('mines', mine.id);
    }
  }

  return totalCollected;
}

/**
 * Auto-upgrade weakest mines near a collector using its stored_coins.
 * Builds the candidate list ONCE — previous version called getCollectorMines on every
 * iteration, which scanned all gameState.mines (O(N²) per cycle on big servers).
 */
export function autoUpgradeMines(collector, ctx) {
  const _ctx = ctx || getOwnerContext(collector);
  const maxLevel = COLLECTOR_MAX_MINE_LEVEL[collector.level] || 20;
  // Snapshot eligible mines once. Mutations to mine.level update the same object refs,
  // so the next "find weakest" iteration sees fresh values without rescanning the world.
  const cands = getCollectorMines(collector, _ctx).filter(m => m.status === 'normal' && !m.upgrade_finish_at);
  let upgraded = 0;

  while (collector.stored_coins > 0 && cands.length) {
    // Find weakest eligible (linear over a small list, ~10-30 mines)
    let weakestIdx = -1;
    for (let i = 0; i < cands.length; i++) {
      const m = cands[i];
      if (m.level >= maxLevel) continue;
      if (weakestIdx === -1 || m.level < cands[weakestIdx].level) weakestIdx = i;
    }
    if (weakestIdx === -1) break;
    const mine = cands[weakestIdx];

    const cost = getMineUpgradeCost(mine.level);
    if (collector.stored_coins < cost) break;

    collector.stored_coins -= cost;
    mine.level += 1;
    mine.hp = getMineHp(mine.level);
    mine.max_hp = getMineHp(mine.level);
    mine.pending_level = null;
    mine.upgrade_finish_at = null;
    gameState.markDirty('mines', mine.id);
    upgraded++;

    // Drop the mine from candidates once it hits the collector's ceiling
    if (mine.level >= maxLevel) cands.splice(weakestIdx, 1);
  }

  if (upgraded > 0) {
    gameState.markDirty('collectors', collector.id);
    console.log(`[COLLECTORS] Collector ${collector.id} auto-upgraded ${upgraded} mines (${collector.stored_coins} coins left)`);
  }
  return upgraded;
}

/**
 * Run auto-collection + auto-upgrade for ALL collectors.
 * Called every 5 min; each collector has its own interval based on level.
 */
export function autoCollectAll() {
  const now = Date.now();
  let totalAll = 0;
  let totalUpgraded = 0;
  for (const collector of gameState.collectors.values()) {
    try {
      if (collector.hp <= 0) continue;
      if (collector.status === 'burning' || collector.status === 'destroyed') continue;

      // Check per-collector interval based on level
      const intervalMs = COLLECTOR_INTERVAL_MS[collector.level] || COLLECTOR_INTERVAL_MS[1];
      const lastAutoCollect = collector.last_collected_at ? new Date(collector.last_collected_at).getTime() : 0;
      if (now - lastAutoCollect < intervalMs) continue;

      // Build per-cycle context once and pass it through all helpers (skill effects,
      // clan, online status — avoids re-fetching per call from autoCollect/autoUpgradeMines).
      const ctx = getOwnerContext(collector);

      // Auto-upgrade FIRST to free up stored_coins capacity before collecting
      if (collector.auto_upgrade) {
        totalUpgraded += autoUpgradeMines(collector, ctx);
      }
      const collected = autoCollect(collector);
      totalAll += collected;
      // After collecting new coins, try upgrading again
      if (collector.auto_upgrade && collected > 0) {
        totalUpgraded += autoUpgradeMines(collector, ctx);
      }
    } catch (err) {
      console.error(`[COLLECTORS] Error processing collector ${collector.id} (owner=${collector.owner_id}):`, err.message);
    }
  }
  if (totalAll > 0 || totalUpgraded > 0) {
    console.log(`[COLLECTORS] Cycle: collected ${totalAll} coins, upgraded ${totalUpgraded} mines`);
  }
}
