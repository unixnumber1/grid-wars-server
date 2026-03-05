/**
 * Coins per second for each mine level (1-based index, level 1 = index 0).
 */
export const RATE_PER_LEVEL = [1, 2, 4, 7, 11, 16, 22, 29, 37, 46];

/**
 * Upgrade cost to reach a given level (cost to go from level N-1 to level N).
 * Level 1 is free (initial placement).
 */
export const UPGRADE_COST = [0, 50, 150, 300, 500, 800, 1200, 1800, 2500, 3500];

export const MAX_LEVEL = 10;
export const HQ_COIN_LIMIT = 10000;

/**
 * Calculate how many coins a mine has accumulated since last_collected.
 */
export function calcAccumulatedCoins(level, lastCollectedISO) {
  const rate = RATE_PER_LEVEL[level - 1];
  const elapsedSeconds = (Date.now() - new Date(lastCollectedISO).getTime()) / 1000;
  return Math.floor(rate * Math.max(0, elapsedSeconds));
}
