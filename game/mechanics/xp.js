import { calculateLevel, getXpForLevel, getTotalXpForLevel } from '../../config/formulas.js';
import { supabase, sendTelegramNotification } from '../../lib/supabase.js';
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

// Drop chance on collect, 0.1–1% of coins
export function getCollectXp(coinsCollected, dropChance = 0.10) {
  if (Math.random() > dropChance) return 0;
  const pct = 0.001 + Math.random() * 0.009; // 0.1% – 1%
  return Math.floor(coinsCollected * pct);
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

  // Referral reward: when player reaches level 50, reward referrer 100 diamonds
  if (leveledUp && newLevel === 50) {
    try {
      const p = gameState.loaded ? gameState.getPlayerById(playerId) : null;
      const playerTgId = p?.telegram_id;
      if (playerTgId) {
        const { data: ref } = await supabase.from('referrals')
          .select('id, referrer_id')
          .eq('referred_id', playerTgId)
          .eq('level50_rewarded', false)
          .maybeSingle();
        if (ref) {
          await supabase.from('referrals').update({ level50_rewarded: true }).eq('id', ref.id);
          const referrer = gameState.loaded ? gameState.getPlayerByTgId(ref.referrer_id) : null;
          if (referrer) {
            referrer.diamonds = (referrer.diamonds ?? 0) + 100;
            gameState.markDirty('players', referrer.id);
            await supabase.from('players').update({ diamonds: referrer.diamonds }).eq('id', referrer.id);
          } else {
            const { data: refP } = await supabase.from('players').select('id, diamonds').eq('telegram_id', ref.referrer_id).maybeSingle();
            if (refP) await supabase.from('players').update({ diamonds: (refP.diamonds ?? 0) + 100 }).eq('id', refP.id);
          }
          sendTelegramNotification(ref.referrer_id, `🏆 Твой реферал достиг 50 уровня! +100 💎`);
          console.log(`[referral] Player ${playerTgId} reached lv50, referrer ${ref.referrer_id} rewarded 100 diamonds`);
        }
      }
    } catch (refErr) { console.error('[referral] lv50 check error:', refErr.message); }
  }

  return { xpGained: cappedAmount, newXp, newLevel, leveledUp, xpForNextLevel: getXpForLevel(newLevel) };
}
