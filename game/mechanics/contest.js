// ═══════════════════════════════════════════════════════
//  Contest tickets — multi-clan event-based contest
//  Active clans selected at runtime via app_settings.
//  Setting value is JSON array of clan UUIDs (legacy:
//  bare UUID string treated as single-element array).
// ═══════════════════════════════════════════════════════

import { CONTEST_RULES, CONTEST_SETTING_KEY, getContestIdForClan } from '../../config/constants.js';
import { gameState } from '../state/GameState.js';
import { supabase } from '../../lib/supabase.js';

/**
 * Returns the currently active contest clan ids as a Set<string>.
 * Empty set means no active contests.
 */
export function getActiveContestClanIds() {
  const raw = gameState.appSettings.get(CONTEST_SETTING_KEY);
  if (!raw) return new Set();
  // Try JSON array first
  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr.filter(Boolean).map(String));
    } catch { /* fall through */ }
  }
  // Legacy: bare UUID
  return new Set([String(raw)]);
}

/**
 * Persist the active contest clan id set into app_settings + gameState.
 * @param {Set<string>|string[]} ids
 */
export async function setActiveContestClanIds(ids) {
  const arr = [...new Set([...(ids || [])].map(String).filter(Boolean))];
  const value = JSON.stringify(arr);
  await supabase
    .from('app_settings')
    .upsert({ key: CONTEST_SETTING_KEY, value }, { onConflict: 'key' });
  gameState.appSettings.set(CONTEST_SETTING_KEY, value);
  return arr;
}

/**
 * Returns the player's active contest clan_id if they are an eligible member,
 * otherwise null. The returned id is the contest clan they belong to (used to
 * pick the right contest_id pool).
 */
export function getEligibleClanIdForPlayer(telegramId) {
  const active = getActiveContestClanIds();
  if (active.size === 0) return null;
  const tgId = Number(telegramId);
  if (!tgId) return null;
  const player = gameState.playersByTgId.get(tgId);
  if (!player || !player.clan_id) return null;
  const playerClanId = String(player.clan_id);
  if (!active.has(playerClanId)) return null;
  // Confirm active membership row
  for (const m of gameState.clanMembers.values()) {
    if (String(m.clan_id) === playerClanId && m.player_id === player.id && !m.left_at) {
      return playerClanId;
    }
  }
  return null;
}

/**
 * Award contest tickets to a player. Fire-and-forget.
 * Writes to the contest_id derived from the player's own clan.
 *
 * @param {number} telegramId - player telegram_id
 * @param {string} reason - 'mine_destroy' | 'ore_capture' | 'monument_kill'
 * @param {number} amount - number of tickets
 * @param {object} meta - extra data for audit
 */
export async function awardContestTickets(telegramId, reason, amount, meta = {}) {
  if (!amount || amount <= 0) return;
  const clanId = getEligibleClanIdForPlayer(telegramId);
  if (!clanId) return;
  const contestId = getContestIdForClan(clanId);
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
 * Award tickets for clan-treasury donation. Cumulative: every N gems = 1 ticket.
 * Only awards when the donation goes into a clan that is itself an active
 * contest clan AND the donor is a member there.
 *
 * @param {number} telegramId
 * @param {number} donateAmount - gems donated in this donation
 * @param {string} clanId - the clan being donated to
 */
export async function awardClanDonationTickets(telegramId, donateAmount, clanId) {
  if (!donateAmount || donateAmount <= 0) return;
  const eligibleClanId = getEligibleClanIdForPlayer(telegramId);
  if (!eligibleClanId) return;
  // Donor must be donating into their own contest clan (this is normally true
  // by clan-membership invariant, but be defensive).
  if (String(clanId) !== eligibleClanId) return;
  const contestId = getContestIdForClan(eligibleClanId);
  if (!contestId) return;
  const perTicket = CONTEST_RULES.clanDonatePerTicket;
  if (!perTicket || perTicket <= 0) return;

  try {
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
