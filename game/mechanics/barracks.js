import { gameState } from '../state/GameState.js';
import { haversine } from '../../lib/haversine.js';
import {
  BARRACKS_BUILD_COST, BARRACKS_MIN_HQ_LEVEL, BARRACKS_BASE_TRAIN_TIME_MS,
  BARRACKS_LEVELS,
  SCOUT_TRAIN_COST, SCOUT_UPGRADE_COST, SCOUT_SPEED_KMH,
  SCOUT_CAPTURE_MIN, SCOUT_HP, SCOUT_MAX_RANGE_KM, SCOUT_ORE_ACCESS,
  SCOUT_KILL_REWARD_CRYSTALS,
  SMALL_RADIUS,
} from '../../config/constants.js';

// ── Barracks helpers ──

export function getPlayerBarracks(telegramId) {
  for (const b of gameState.barracks.values()) {
    if (Number(b.owner_id) === Number(telegramId)) return b;
  }
  return null;
}

export function getBarracksLevel(barracks) {
  return BARRACKS_LEVELS[barracks.level] || BARRACKS_LEVELS[1];
}

export function getTrainTimeMs(barracksLevel) {
  const cfg = BARRACKS_LEVELS[barracksLevel] || BARRACKS_LEVELS[1];
  return Math.round(BARRACKS_BASE_TRAIN_TIME_MS * cfg.trainSpeedMul);
}

export function getQueueSlots(barracksLevel) {
  const cfg = BARRACKS_LEVELS[barracksLevel] || BARRACKS_LEVELS[1];
  return cfg.slots;
}

export function getMaxUnitLevel(barracksLevel) {
  const cfg = BARRACKS_LEVELS[barracksLevel] || BARRACKS_LEVELS[1];
  return cfg.maxUnitLevel;
}

// ── Scout helpers ──

export function getScoutTrainCost(scoutLevel) {
  return SCOUT_TRAIN_COST[scoutLevel] || SCOUT_TRAIN_COST[1];
}

export function getScoutUpgradeCost(toLevel) {
  return SCOUT_UPGRADE_COST[toLevel] || 0;
}

export function getScoutSpeedKmh(scoutLevel) {
  return SCOUT_SPEED_KMH[scoutLevel] || SCOUT_SPEED_KMH[1];
}

export function getScoutCaptureMs(scoutLevel) {
  const minutes = SCOUT_CAPTURE_MIN[scoutLevel] || SCOUT_CAPTURE_MIN[1];
  return minutes * 60 * 1000;
}

export function getScoutHp(scoutLevel) {
  return SCOUT_HP[scoutLevel] || SCOUT_HP[1];
}

export function canScoutCaptureOre(scoutLevel, oreType) {
  const required = SCOUT_ORE_ACCESS[oreType];
  if (!required) return false;
  return scoutLevel >= required;
}

export function getPlayerScoutLevel(telegramId) {
  const upgrade = gameState.unitUpgrades.get(`${telegramId}_scout`);
  return upgrade ? upgrade.level : 1;
}

export function getPlayerScoutCount(telegramId) {
  let count = 0;
  for (const u of gameState.unitBag.values()) {
    if (Number(u.owner_id) === Number(telegramId) && u.unit_type === 'scout') count++;
  }
  return count;
}

// Get training queue for a barracks
export function getTrainingQueue(barracksId) {
  const queue = [];
  for (const t of gameState.trainingQueue.values()) {
    if (t.barracks_id === barracksId && !t.collected) queue.push(t);
  }
  queue.sort((a, b) => new Date(a.finish_at) - new Date(b.finish_at));
  return queue;
}

// Count active (not collected) items in queue
export function getActiveQueueCount(barracksId) {
  let count = 0;
  for (const t of gameState.trainingQueue.values()) {
    if (t.barracks_id === barracksId && !t.collected) count++;
  }
  return count;
}

// Get scouts in bag for a player
export function getPlayerBag(telegramId) {
  const bag = [];
  for (const u of gameState.unitBag.values()) {
    if (Number(u.owner_id) === Number(telegramId)) bag.push(u);
  }
  return bag;
}

// Get active scouts on map for a player
export function getPlayerActiveScouts(telegramId) {
  const scouts = [];
  for (const s of gameState.activeScouts.values()) {
    if (Number(s.owner_id) === Number(telegramId)) scouts.push(s);
  }
  return scouts;
}

// ── Sell refund ──
export function getBarracksSellRefund(level) {
  let total = BARRACKS_BUILD_COST;
  for (let i = 2; i <= level; i++) {
    total += (BARRACKS_LEVELS[i]?.upgradeCost || 0);
  }
  return Math.floor(total * 0.5);
}
