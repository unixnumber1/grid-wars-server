import { gameState } from '../state/GameState.js';
import { haversine } from '../../lib/haversine.js';
import { getMineUpgradeCost } from '../../config/formulas.js';

// ── Constants ──
export const FIRETRUCK_BUILD_COST = 75;          // diamonds
export const FIRETRUCK_COOLDOWN_MS = 3_600_000;  // 1 hour
export const FIRETRUCK_EXTINGUISH_DURATION = 3000; // 3s animation at target
export const FIREFIGHTER_HP = 5000;
export const FIREFIGHTER_SPEED = 0.0002;          // ~20 km/h (same as pedestrian courier)
export const FIRETRUCK_MINE_COST_PERCENT = 0.05;  // 5% of mine total upgrade cost

// ── Level config ──
export const FIRETRUCK_LEVELS = {
  1:  { radius: 200,  hp: 2000,  upgradeCost: 0 },
  2:  { radius: 225,  hp: 3500,  upgradeCost: 50 },
  3:  { radius: 250,  hp: 5500,  upgradeCost: 100 },
  4:  { radius: 275,  hp: 8000,  upgradeCost: 200 },
  5:  { radius: 300,  hp: 12000, upgradeCost: 350 },
  6:  { radius: 350,  hp: 17000, upgradeCost: 550 },
  7:  { radius: 400,  hp: 24000, upgradeCost: 800 },
  8:  { radius: 450,  hp: 33000, upgradeCost: 1200 },
  9:  { radius: 500,  hp: 45000, upgradeCost: 1800 },
  10: { radius: 600,  hp: 60000, upgradeCost: 2800 },
};

/**
 * Max fire trucks allowed for given HQ level.
 * 0 if hqLevel < 5, 1 if >= 5, 2 if >= 10.
 */
export function getMaxFireTrucks(hqLevel) {
  if (hqLevel >= 10) return 2;
  if (hqLevel >= 5) return 1;
  return 0;
}

/**
 * Total gems spent to reach a given level (build cost + all upgrades).
 */
export function getTotalGemsCost(level) {
  let sum = FIRETRUCK_BUILD_COST;
  for (let i = 2; i <= level; i++) {
    sum += FIRETRUCK_LEVELS[i].upgradeCost;
  }
  return sum;
}

/**
 * Sell refund = 50% of total gems spent.
 */
export function getSellRefundDiamonds(level) {
  return Math.floor(getTotalGemsCost(level) * 0.5);
}

/**
 * Total coin cost to upgrade a mine to given level (sum of all upgrade costs).
 */
export function getTotalMineCost(level) {
  let sum = 0;
  for (let i = 0; i < level; i++) sum += getMineUpgradeCost(i);
  return sum;
}

/**
 * Get all burning buildings owned by truck owner within truck's radius.
 * Returns array of { type: 'mine'|'collector'|'fire_truck', id, lat, lng, level? }
 */
export function getBurningBuildingsInRadius(truck) {
  const radius = FIRETRUCK_LEVELS[truck.level]?.radius || 200;
  const result = [];

  // Burning mines
  for (const m of gameState.mines.values()) {
    if (m.owner_id !== truck.owner_id) continue;
    if (m.status !== 'burning') continue;
    if (haversine(truck.lat, truck.lng, m.lat, m.lng) <= radius) {
      result.push({ type: 'mine', id: m.id, lat: m.lat, lng: m.lng, level: m.level });
    }
  }

  // Burning collectors
  for (const c of gameState.collectors.values()) {
    if (c.owner_id !== truck.owner_id) continue;
    if (c.status !== 'burning') continue;
    if (haversine(truck.lat, truck.lng, c.lat, c.lng) <= radius) {
      result.push({ type: 'collector', id: c.id, lat: c.lat, lng: c.lng });
    }
  }

  // Burning fire trucks (other trucks, not self)
  for (const ft of gameState.fireTrucks.values()) {
    if (ft.owner_id !== truck.owner_id) continue;
    if (ft.id === truck.id) continue;
    if (ft.status !== 'burning') continue;
    if (haversine(truck.lat, truck.lng, ft.lat, ft.lng) <= radius) {
      result.push({ type: 'fire_truck', id: ft.id, lat: ft.lat, lng: ft.lng });
    }
  }

  return result;
}

/**
 * Calculate total coin cost to extinguish given burning buildings.
 * Mines: 5% of total upgrade cost. Collectors & fire trucks: free.
 */
export function getExtinguishCost(burningBuildings) {
  let totalCoins = 0;
  for (const b of burningBuildings) {
    if (b.type === 'mine' && b.level) {
      totalCoins += Math.floor(getTotalMineCost(b.level) * FIRETRUCK_MINE_COST_PERCENT);
    }
    // collectors and fire_trucks are free
  }
  return totalCoins;
}

/**
 * Get the radius for a fire truck at given level.
 */
export function getFireTruckRadius(level) {
  return FIRETRUCK_LEVELS[level]?.radius || 200;
}
