// ═══════════════════════════════════════════════════════
//  Badge definitions
// ═══════════════════════════════════════════════════════

export const BADGES = {
  pioneer: {
    id: 'pioneer',
    name: 'Первопроходец',
    name_en: 'Pioneer',
    emoji: '🧭',
    description: 'Один из первых игроков Overthrow',
    description_en: 'One of the first Overthrow players',
    color: '#FFD700',
    rarity: 'legendary',
    condition: (player) => player.created_at && new Date(player.created_at) < new Date('2026-04-01T00:00:00Z'),
  },
};

/**
 * Check all badge conditions and award new ones.
 * Returns array of newly earned badge objects.
 */
export async function checkAndAwardBadges(player, supabase) {
  const { data: existing } = await supabase
    .from('player_badges')
    .select('badge_id')
    .eq('player_id', player.telegram_id);

  const earned = new Set((existing || []).map(b => b.badge_id));
  const newBadges = [];

  for (const [id, badge] of Object.entries(BADGES)) {
    if (earned.has(id)) continue;
    try {
      if (badge.condition(player)) {
        await supabase.from('player_badges').insert({
          player_id: player.telegram_id,
          badge_id: id,
        });
        newBadges.push(badge);
      }
    } catch (_) { /* duplicate or constraint — ignore */ }
  }

  return newBadges;
}
