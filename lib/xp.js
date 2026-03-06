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

const MIGRATION_HINT = `
⚠️  XP columns missing! Run this SQL in Supabase Dashboard → SQL Editor:
    ALTER TABLE players ADD COLUMN IF NOT EXISTS xp    integer DEFAULT 0;
    ALTER TABLE players ADD COLUMN IF NOT EXISTS level integer DEFAULT 1;
`;

export async function addXp(playerId, amount) {
  if (!amount || amount <= 0) return { newXp: 0, newLevel: 1, leveledUp: false };

  console.log('[xp] Adding', amount, 'XP to player:', playerId);

  const { data: player, error: fetchErr } = await supabase
    .from('players')
    .select('xp, level')
    .eq('id', playerId)
    .single();

  if (fetchErr) {
    const msg = fetchErr.message ?? '';
    if (msg.includes('xp') || msg.includes('level') || fetchErr.code === '42703') {
      console.error('[xp] COLUMN MISSING:', fetchErr.message, MIGRATION_HINT);
    } else {
      console.error('[xp] fetch error code=%s msg=%s', fetchErr.code, fetchErr.message);
    }
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
    console.error('[xp] update error code=%s msg=%s', updateErr.code, updateErr.message);
    return null;
  }

  const result = { xpGained: amount, newXp, newLevel, leveledUp };
  console.log('[xp] result:', JSON.stringify(result));
  return result;
}
