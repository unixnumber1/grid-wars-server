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

/**
 * Award tickets for clan-treasury donation. Cumulative: every N gems = 1 ticket
 * (N = CONTEST_RULES.clanDonatePerTicket). Tracks total donated per player so
 * leftover gems carry over to the next donation.
 *
 * @param {number} telegramId
 * @param {number} donateAmount - gems donated in this donation
 * @param {string} clanId - the clan being donated to
 */
export async function awardClanDonationTickets(telegramId, donateAmount, clanId) {
  if (!isInEligibleClan(telegramId)) return;
  if (!donateAmount || donateAmount <= 0) return;
  const activeClanId = getActiveContestClanId();
  if (String(clanId) !== activeClanId) return;
  const contestId = getActiveContestId();
  if (!contestId) return;
  const perTicket = CONTEST_RULES.clanDonatePerTicket;
  if (!perTicket || perTicket <= 0) return;

  try {
    // Sum prior donation rows for this player+contest
    const { data: prior } = await supabase
      .from('contest_tickets')
      .select('meta')
      .eq('contest_id', contestId)
      .eq('player_id', Number(telegramId))
      .eq('reason', 'clan_donate');

    let prevDonated = 0;
    for (const r of prior || []) {
      const d = Number(r.meta?.donated || 0);
      if (d > 0) prevDonated += d;
    }
    const newTotal = prevDonated + donateAmount;
    const prevTickets = Math.floor(prevDonated / perTicket);
    const newTickets = Math.floor(newTotal / perTicket);
    const delta = newTickets - prevTickets;

    // Always insert a row so total_donated is tracked, even when delta=0
    await supabase.from('contest_tickets').insert({
      contest_id: contestId,
      player_id: Number(telegramId),
      reason: 'clan_donate',
      amount: delta,
      meta: { donated: donateAmount, total_donated: newTotal },
    });
  } catch (e) {
    console.error('[contest] donation award failed', e?.message || e);
  }
}

export { CONTEST_RULES };
