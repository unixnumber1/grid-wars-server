import { calculateLevel } from './formulas.js';
import { supabase } from './supabase.js';

export const XP_REWARDS = {
  BUILD_MINE:            10,
  BUILD_HQ:              50,
  COLLECT_COINS:         null,   // dynamic: Math.max(1, floor(amount * 0.001))
  UPGRADE_MINE:          (fromLevel, toLevel) => {
    if (toLevel - fromLevel === 1) return toLevel * 5;
    let sum = 0;
    for (let lvl = fromLevel + 1; lvl <= toLevel; lvl++) sum += lvl * 5;
    return Math.floor(sum / 2);
  },
  UPGRADE_HQ:            200,
  BREAK_VASE:            50,
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
