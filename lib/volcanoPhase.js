// Pure helpers for volcano eruption probability — safe to import from tests.
import { VOLCANO_PHASE_THRESHOLDS } from '../config/constants.js';

export function getVolcanoPhase(daysOwned) {
  if (daysOwned < VOLCANO_PHASE_THRESHOLDS.active.minDays)   return { phase: 'dormant',  dailyChance: VOLCANO_PHASE_THRESHOLDS.dormant.dailyChance };
  if (daysOwned < VOLCANO_PHASE_THRESHOLDS.unstable.minDays) return { phase: 'active',   dailyChance: VOLCANO_PHASE_THRESHOLDS.active.dailyChance };
  if (daysOwned < VOLCANO_PHASE_THRESHOLDS.critical.minDays) return { phase: 'unstable', dailyChance: VOLCANO_PHASE_THRESHOLDS.unstable.dailyChance };
  return                                                          { phase: 'critical', dailyChance: VOLCANO_PHASE_THRESHOLDS.critical.dailyChance };
}

// Hourly chance = 1 − (1 − p_day)^(1/24)
export function getEruptionHourlyChance(daysOwned) {
  const { dailyChance } = getVolcanoPhase(daysOwned);
  if (dailyChance <= 0) return 0;
  return 1 - Math.pow(1 - dailyChance, 1 / 24);
}
