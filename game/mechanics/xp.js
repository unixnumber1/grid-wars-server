import { calculateLevel, getXpForLevel } from '../../config/formulas.js';
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

async function grantLevelUpRewards(playerId, level) {
  const rewards = getLevelUpRewards(level);

  // Grant diamonds and crystals
  const updates = {};
  if (rewards.diamonds > 0) updates.diamonds = (gameState.getPlayerById(playerId)?.diamonds ?? 0) + rewards.diamonds;
  if (rewards.crystals > 0) updates.crystals = (gameState.getPlayerById(playerId)?.crystals ?? 0) + rewards.crystals;

  if (Object.keys(updates).length > 0) {
    await supabase.from('players').update(updates).eq('id', playerId);
    const p = gameState.getPlayerById(playerId);
    if (p) {
      if (updates.diamonds != null) p.diamonds = updates.diamonds;
      if (updates.crystals != null) p.crystals = updates.crystals;
      gameState.markDirty('players', p.id);
    }
  }

  // Grant core if earned
  if (rewards.core) {
    const coreRow = {
      owner_id: Number((gameState.getPlayerById(playerId))?.telegram_id || playerId),
      mine_cell_id: null,
      slot_index: null,
      core_type: rewards.core_type,
      level: rewards.core_level,
    };
    const { data: inserted } = await supabase.from('cores').insert(coreRow).select().single();
    if (inserted) gameState.upsertCore(inserted);
  }

  return rewards;
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

  const newXp     = (player.xp ?? 0) + amount;
  const newLevel  = calculateLevel(newXp);
  const oldLevel  = player.level ?? 1;
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

  return { xpGained: amount, newXp, newLevel, leveledUp, xpForNextLevel: getXpForLevel(newLevel), rewards };
}
