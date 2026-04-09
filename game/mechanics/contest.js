// ═══════════════════════════════════════════════════════
//  Contest tickets — clan-locked event-based contest
// ═══════════════════════════════════════════════════════

import { ACTIVE_CONTEST } from '../../config/constants.js';
import { gameState } from '../state/GameState.js';
import { supabase } from '../../lib/supabase.js';

/**
 * Check if a player (by telegram_id) is currently a member of the eligible clan.
 */
export function isInEligibleClan(telegramId) {
  if (!ACTIVE_CONTEST.enabled) return false;
  const tgId = Number(telegramId);
  if (!tgId) return false;
  const player = gameState.playersByTgId.get(tgId);
  if (!player || !player.clan_id) return false;
  const clan = gameState.clans.get(player.clan_id);
  if (!clan || clan.name !== ACTIVE_CONTEST.clanName) return false;
  // Confirm active membership row
  for (const m of gameState.clanMembers.values()) {
    if (m.clan_id === clan.id && m.player_id === player.id && !m.left_at) return true;
  }
  return false;
}

/**
 * Award contest tickets to a player. Fire-and-forget.
 *
 * @param {number} telegramId - player telegram_id
 * @param {string} reason - 'mine_destroy' | 'ore_capture' | 'monument_kill'
 * @param {number} amount - number of tickets
 * @param {object} meta - extra data for audit
 */
export async function awardContestTickets(telegramId, reason, amount, meta = {}) {
  if (!isInEligibleClan(telegramId)) return;
  if (!amount || amount <= 0) return;
  try {
    await supabase.from('contest_tickets').insert({
      contest_id: ACTIVE_CONTEST.id,
      player_id: Number(telegramId),
      reason,
      amount,
      meta,
    });
  } catch (e) {
    console.error('[contest] award failed', e?.message || e);
  }
}
