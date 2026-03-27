import { gameState } from '../state/GameState.js';
import { haversine } from '../../lib/haversine.js';
import { getMineIncome, getMineUpgradeCost, getMineHp, getMineCapacity } from '../../config/formulas.js';
import { supabase } from '../../lib/supabase.js';
import {
  COLLECTOR_COST_DIAMONDS, COLLECTOR_SELL_DIAMONDS, COLLECTOR_RADIUS,
  COLLECTOR_DELIVERY_COMMISSION, COLLECTOR_EXTINGUISH_COST,
} from '../../config/constants.js';
import { getPlayerSkillEffects } from '../../config/skills.js';

// Re-export for backward compat (lib/collectors.js re-exports this file)
export { COLLECTOR_COST_DIAMONDS, COLLECTOR_SELL_DIAMONDS, COLLECTOR_RADIUS, COLLECTOR_DELIVERY_COMMISSION, COLLECTOR_EXTINGUISH_COST };

// Max mine level that collector can auto-upgrade to, by collector level
export const COLLECTOR_MAX_MINE_LEVEL = {
  1: 20, 2: 40, 3: 60, 4: 80, 5: 100,
  6: 120, 7: 140, 8: 160, 9: 180, 10: 200,
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
 */
export function getCollectorCapacity(collector) {
  const mines = getCollectorMines(collector);
  return mines.reduce((sum, m) => sum + getMineCapacity(m.level), 0);
}

/**
 * Get all mines owned by the collector's owner within radius.
 */
export function getCollectorMines(collector) {
  const mines = [];
  const skillRow = gameState.getPlayerSkills(Number(gameState.players.get(collector.owner_id)?.telegram_id));
  const fx = skillRow ? getPlayerSkillEffects(skillRow) : {};
  const radius = COLLECTOR_RADIUS * (1 + (fx.collector_radius_bonus || 0));
  for (const m of gameState.mines.values()) {
    if (m.owner_id !== collector.owner_id) continue;
    if (m.status === 'destroyed') continue;
    if (haversine(collector.lat, collector.lng, m.lat, m.lng) <= radius) {
      mines.push(m);
    }
  }
  return mines;
}

/**
 * Perform auto-collection for a single collector.
 * Called every hour from game loop.
 * Returns coins collected this cycle.
 */
export function autoCollect(collector) {
  const minesInRange = getCollectorMines(collector);
  if (!minesInRange.length) return 0;

  const now = Date.now();
  const capacity = getCollectorCapacity(collector);
  // Use collector's own timestamp, NOT mine.last_collected (that belongs to manual collect)
  const lastAutoCollect = collector.last_collected_at ? new Date(collector.last_collected_at).getTime() : now;
  const elapsedSec = Math.max(0, (now - lastAutoCollect) / 1000);
  if (elapsedSec <= 0) return 0;

  let totalCollected = 0;

  for (const mine of minesInRange) {
    const income = getMineIncome(mine.level);
    const accumulated = Math.floor(income * elapsedSec);
    if (accumulated <= 0) continue;

    const room = capacity - collector.stored_coins - totalCollected;
    if (room <= 0) break;

    totalCollected += Math.min(accumulated, room);
    // Do NOT touch mine.last_collected — it belongs to manual player collect + XP
  }

  if (totalCollected > 0) {
    collector.stored_coins = (collector.stored_coins || 0) + totalCollected;
    collector.last_collected_at = new Date(now).toISOString();
    gameState.markDirty('collectors', collector.id);
  }

  return totalCollected;
}

/**
 * Auto-upgrade mines near a collector using its stored_coins.
 * Upgrades weakest mine first, one level per mine per cycle.
 */
export function autoUpgradeMines(collector) {
  const maxLevel = COLLECTOR_MAX_MINE_LEVEL[collector.level] || 20;
  const mines = getCollectorMines(collector)
    .filter(m => m.level < maxLevel && (!m.status || m.status === 'normal') && !m.upgrade_finish_at)
    .sort((a, b) => a.level - b.level);

  let upgraded = 0;
  for (const mine of mines) {
    if (mine.level >= maxLevel) continue;
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
  }

  if (upgraded > 0) {
    gameState.markDirty('collectors', collector.id);
    console.log(`[COLLECTORS] Collector ${collector.id} auto-upgraded ${upgraded} mines (${collector.stored_coins} coins left)`);
  }
  return upgraded;
}

/**
 * Run auto-collection + auto-upgrade for ALL collectors.
 * Called from game loop every hour.
 */
export function autoCollectAll() {
  let totalAll = 0;
  let totalUpgraded = 0;
  for (const collector of gameState.collectors.values()) {
    if (collector.hp <= 0) continue;
    if (collector.status === 'burning') continue;
    const collected = autoCollect(collector);
    totalAll += collected;
    // Auto-upgrade only in 'upgrade' mode (default is 'collect')
    if (collector.mode === 'upgrade') {
      const upgraded = autoUpgradeMines(collector);
      totalUpgraded += upgraded;
    }
  }
  if (totalAll > 0 || totalUpgraded > 0) {
    console.log(`[COLLECTORS] Cycle: collected ${totalAll} coins, upgraded ${totalUpgraded} mines`);
  }
}
