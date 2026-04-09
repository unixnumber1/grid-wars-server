// ═══════════════════════════════════════════════════════
//  Contest tickets — clan-locked event-based contest
//  Active clan is selected at runtime via app_settings.
// ═══════════════════════════════════════════════════════

import { CONTEST_RULES, CONTEST_SETTING_KEY, getContestIdForClan } from '../../config/constants.js';
import { gameState } from '../state/GameState.js';
import { supabase } from '../../lib/supabase.js';

/**
 * Returns the currently active contest clan id (UUID string) or null if disabled.
 */
export function getActiveContestClanId() {
  const v = gameState.appSettings.get(CONTEST_SETTING_KEY);
  return v ? String(v) : null;
}

/**
 * Returns the active contest_id derived from the clan, or null if disabled.
 */
export function getActiveContestId() {
  return getContestIdForClan(getActiveContestClanId());
}

/**
 * Check if a player (by telegram_id) is currently a member of the eligible clan.
 */
export function isInEligibleClan(telegramId) {
  const activeClanId = getActiveContestClanId();
  if (!activeClanId) return false;
  const tgId = Number(telegramId);
  if (!tgId) return false;
  const player = gameState.playersByTgId.get(tgId);
  if (!player || !player.clan_id) return false;
  if (String(player.clan_id) !== activeClanId) return false;
  // Confirm active membership row
  for (const m of gameState.clanMembers.values()) {
    if (String(m.clan_id) === activeClanId && m.player_id === player.id && !m.left_at) return true;
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
  const contestId = getActiveContestId();
  if (!contestId) return;
  try {
    await supabase.from('contest_tickets').insert({
      contest_id: contestId,
      player_id: Number(telegramId),
      reason,
      amount,
      meta,
    });
  } catch (e) {
    console.error('[contest] award failed', e?.message || e);
  }
}

export { CONTEST_RULES };
