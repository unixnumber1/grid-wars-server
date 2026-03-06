import { calculateLevel } from './formulas.js';
import { supabase } from './supabase.js';

export const XP_REWARDS = {
  BUILD_MINE:            20,
  BUILD_HQ:              50,
  COLLECT_PER_50_COINS:  1,
  UPGRADE_MINE: (newLevel) => 10 * newLevel,
  UPGRADE_HQ:            500,
  CAPTURE_MINE:          100,
};

export async function addXp(playerId, amount) {
  if (!amount || amount <= 0) return { newXp: 0, newLevel: 1, leveledUp: false };

  console.log('[xp] Adding', amount, 'XP to player:', playerId);

  const { data: player, error: fetchErr } = await supabase
    .from('players')
    .select('xp, level')
    .eq('id', playerId)
    .single();

  if (fetchErr) {
    console.error('[xp] fetch error:', fetchErr.message);
    return;
  }
  if (!player) {
    console.error('[xp] player not found:', playerId);
    return;
  }

  const newXp    = (player.xp ?? 0) + amount;
  const newLevel = calculateLevel(newXp);
  const leveledUp = newLevel > (player.level ?? 1);

  const { error: updateErr } = await supabase
    .from('players')
    .update({ xp: newXp, level: newLevel })
    .eq('id', playerId);

  if (updateErr) {
    console.error('[xp] update error:', updateErr.message);
    return;
  }

  const result = { newXp, newLevel, leveledUp };
  console.log('[xp] result:', result);
  return result;
}
