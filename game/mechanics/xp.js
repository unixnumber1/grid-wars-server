import { calculateLevel, getXpForLevel, getTotalXpForLevel } from '../../config/formulas.js';
import { supabase } from '../../lib/supabase.js';
import { gameState } from '../state/GameState.js';
import { randomCoreType } from './cores.js';

export const XP_REWARDS = {
  BUILD_MINE:            10,
  BUILD_HQ:              50,
  COLLECT_COINS:         null,
  UPGRADE_MINE:          (newLevel) => 5 * newLevel,
  UPGRADE_HQ:            200,
  BREAK_VASE:            50,
};

// ─── New XP source functions ─────────────────────────────────────────────────

// 10% chance on collect, 1% of coins
export function getCollectXp(coinsCollected) {
  if (Math.random() > 0.10) return 0;
  return Math.floor(coinsCollected * 0.01);
}

// XP for building/upgrading mine
export function getBuildXp(mineLevel) {
  return mineLevel * 50;
}

// XP for opening monument loot box
export function getMonumentXp(monumentLevel) {
  return monumentLevel * 100000;
}

// ─── Level-up rewards ────────────────────────────────────────────────────────

export function getLevelUpRewards(level) {
  const rewards = { diamonds: 5, crystals: 0, core: false, core_type: null, core_level: 0 };
  if (level % 10 === 0) { rewards.diamonds += 50; rewards.core = true; rewards.core_type = randomCoreType(); rewards.core_level = 0; }
  if (level % 25 === 0) { rewards.diamonds += 200; rewards.crystals += 500; }
  if ([50, 100, 150, 200].includes(level)) { rewards.diamonds += 500; rewards.core = true; rewards.core_type = randomCoreType(); rewards.core_level = 5; }
  return rewards;
}

// Rewards are now granted via the manual claim system (api/routes/rewards.js)
async function grantLevelUpRewards(_playerId, _level) {
  return {};
}

// ─── Main addXp ──────────────────────────────────────────────────────────────

export async function addXp(playerId, amount) {
  if (!amount || amount <= 0) return { newXp: 0, newLevel: 1, leveledUp: false };

  const { data: player, error: fetchErr } = await supabase
    .from('players')
    .select('xp, level')
    .eq('id', playerId)
    .single();

  if (fetchErr) {
    console.error('[xp] fetch error:', fetchErr.message);
    return null;
  }
  if (!player) {
    console.error('[xp] player not found id=%s', playerId);
    return null;
  }

  const currentXp = player.xp ?? 0;
  const oldLevel  = player.level ?? 1;

  // Cap: max 1 level per addXp call — excess XP is discarded
  const xpToNextLevel = getTotalXpForLevel(oldLevel + 1) - currentXp;
  const cappedAmount  = Math.min(amount, Math.max(0, xpToNextLevel));

  const newXp     = currentXp + cappedAmount;
  const newLevel  = calculateLevel(newXp);
  const leveledUp = newLevel > oldLevel;

  const { error: updateErr } = await supabase
    .from('players')
    .update({ xp: newXp, level: newLevel })
    .eq('id', playerId);

  if (updateErr) {
    console.error('[xp] update error:', updateErr.message);
    return null;
  }

  // Update gameState
  if (gameState.loaded) {
    const p = gameState.getPlayerById(playerId);
    if (p) { p.xp = newXp; p.level = newLevel; gameState.markDirty('players', p.id); }
  }

  let rewards = null;
  if (leveledUp) {
    // Grant rewards for each level gained
    for (let lv = oldLevel + 1; lv <= newLevel; lv++) {
      rewards = await grantLevelUpRewards(playerId, lv);
    }
  }

  return { xpGained: cappedAmount, newXp, newLevel, leveledUp, xpForNextLevel: getXpForLevel(newLevel), rewards };
}
