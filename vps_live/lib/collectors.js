import { gameState } from './gameState.js';
import { haversine } from './haversine.js';
import { getMineIncome } from './formulas.js';
import { supabase } from './supabase.js';

export const COLLECTOR_COST_DIAMONDS = 75;
export const COLLECTOR_SELL_DIAMONDS = 37;
export const COLLECTOR_RADIUS = 200; // meters
export const COLLECTOR_DELIVERY_COMMISSION = 0.10; // 10%

export const COLLECTOR_LEVELS = {
  1:  { capacity_hours: 6,  hp: 3000,  upgradeCost: 0 },
  2:  { capacity_hours: 8,  hp: 5000,  upgradeCost: 500_000 },
  3:  { capacity_hours: 10, hp: 8000,  upgradeCost: 1_500_000 },
  4:  { capacity_hours: 12, hp: 12000, upgradeCost: 4_500_000 },
  5:  { capacity_hours: 16, hp: 18000, upgradeCost: 13_500_000 },
  6:  { capacity_hours: 20, hp: 26000, upgradeCost: 40_500_000 },
  7:  { capacity_hours: 24, hp: 36000, upgradeCost: 121_000_000 },
  8:  { capacity_hours: 30, hp: 50000, upgradeCost: 364_000_000 },
  9:  { capacity_hours: 36, hp: 68000, upgradeCost: 1_090_000_000 },
  10: { capacity_hours: 48, hp: 90000, upgradeCost: 3_280_000_000 },
};

/**
 * Calculate capacity for a collector based on its level and nearby mines income.
 */
export function getCollectorCapacity(collector) {
  const cfg = COLLECTOR_LEVELS[collector.level] || COLLECTOR_LEVELS[1];
  const minesInRange = getCollectorMines(collector);
  const totalIncomePerSec = minesInRange.reduce((sum, m) => sum + getMineIncome(m.level), 0);
  const totalIncomePerHour = totalIncomePerSec * 3600;
  return Math.floor(totalIncomePerHour * cfg.capacity_hours);
}

/**
 * Get all mines owned by the collector's owner within radius.
 */
export function getCollectorMines(collector) {
  const mines = [];
  for (const m of gameState.mines.values()) {
    if (m.owner_id !== collector.owner_id) continue;
    if (m.status === 'destroyed') continue;
    if (haversine(collector.lat, collector.lng, m.lat, m.lng) <= COLLECTOR_RADIUS) {
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
  let totalCollected = 0;

  for (const mine of minesInRange) {
    // Calculate accumulated coins since last_collected
    const lastCollected = mine.last_collected ? new Date(mine.last_collected).getTime() : now;
    const elapsedSec = Math.max(0, (now - lastCollected) / 1000);
    const income = getMineIncome(mine.level);
    const accumulated = Math.floor(income * elapsedSec);
    if (accumulated <= 0) continue;

    // How much room in the collector
    const room = capacity - collector.stored_coins - totalCollected;
    if (room <= 0) break;

    const toCollect = Math.min(accumulated, room);
    totalCollected += toCollect;

    // Reset mine's last_collected
    mine.last_collected = new Date(now).toISOString();
    gameState.markDirty('mines', mine.id);
  }

  if (totalCollected > 0) {
    collector.stored_coins = (collector.stored_coins || 0) + totalCollected;
    collector.last_collected_at = new Date(now).toISOString();
    gameState.markDirty('collectors', collector.id);
  }

  return totalCollected;
}

/**
 * Run auto-collection for ALL collectors.
 * Called from game loop every hour.
 */
export function autoCollectAll() {
  let totalAll = 0;
  for (const collector of gameState.collectors.values()) {
    if (collector.hp <= 0) continue;
    const collected = autoCollect(collector);
    totalAll += collected;
  }
  if (totalAll > 0) {
    console.log(`[COLLECTORS] Auto-collected ${totalAll} coins across ${gameState.collectors.size} collectors`);
  }
}
