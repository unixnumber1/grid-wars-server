import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { addXp, XP_REWARDS } from '../../lib/xp.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { telegram_id } = req.query;
  if (!telegram_id) {
    return res.status(400).json({ error: 'telegram_id is required' });
  }

  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id, 'id');
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player)     return res.status(404).json({ error: 'Player not found' });

  // Find all mines belonging to this player that are ready to complete
  const { data: readyMines, error } = await supabase
    .from('mines')
    .select('id, owner_id, level, pending_level')
    .eq('owner_id', player.id)
    .not('pending_level', 'is', null)
    .lte('upgrade_finish_at', new Date().toISOString());

  if (error) return res.status(500).json({ error: error.message });
  if (!readyMines || readyMines.length === 0) return res.json({ completed: [] });

  const completed = [];
  for (const mine of readyMines) {
    const { data: updated, error: upErr } = await supabase
      .from('mines')
      .update({ level: mine.pending_level, pending_level: null, upgrade_finish_at: null })
      .eq('id', mine.id)
      .select()
      .single();

    if (upErr) {
      console.error('[complete-upgrades] update error:', upErr);
      continue;
    }

    let xpResult = null;
    try {
      xpResult = await addXp(player.id, XP_REWARDS.UPGRADE_MINE(mine.pending_level));
    } catch (e) {
      console.error('[complete-upgrades] XP error:', e.message);
    }

    completed.push({ ...updated, xp: xpResult });
  }

  return res.json({ completed });
}
