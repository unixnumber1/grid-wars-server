import { calculateLevel } from './formulas.js';
import { supabase } from './supabase.js';
import { gameState } from './gameState.js';

export const XP_REWARDS = {
  BUILD_MINE:            10,
  BUILD_HQ:              50,
  COLLECT_COINS:         null,
  UPGRADE_MINE:          (newLevel) => 5 * newLevel,
  UPGRADE_HQ:            200,
  BREAK_VASE:            50,
};

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
  const leveledUp = newLevel > (player.level ?? 1);

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

  return { xpGained: amount, newXp, newLevel, leveledUp };
}
