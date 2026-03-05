import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { mineUpgradeCost, MINE_MAX_LEVEL, hqConfig } from '../../lib/formulas.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { telegram_id, mine_id } = req.body;

  if (!telegram_id || !mine_id) {
    return res.status(400).json({ error: 'telegram_id and mine_id are required' });
  }

  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id);
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player)     return res.status(404).json({ error: 'Player not found' });

  // Fetch mine and HQ in parallel — use * on HQ to be resilient to new columns
  const [
    { data: mine,  error: mineError },
    { data: hq,    error: hqError },
  ] = await Promise.all([
    supabase.from('mines').select('*').eq('id', mine_id).maybeSingle(),
    supabase.from('headquarters').select('*').eq('player_id', player.id).maybeSingle(),
  ]);

  if (mineError) {
    console.error('[upgrade] mine error:', mineError);
    return res.status(500).json({ error: mineError.message });
  }
  if (hqError) {
    console.error('[upgrade] hq error:', hqError);
    return res.status(500).json({ error: hqError.message });
  }
  if (!mine) return res.status(404).json({ error: 'Mine not found' });
  if (!hq)   return res.status(404).json({ error: 'Headquarters not found' });

  if (mine.owner_id !== player.id) {
    return res.status(403).json({ error: 'You do not own this mine' });
  }

  if (mine.level >= MINE_MAX_LEVEL) {
    return res.status(400).json({ error: 'Mine is already at max level' });
  }

  const cfg = hqConfig(hq.level ?? 1);
  if (mine.level + 1 > cfg.maxMineLevel) {
    return res.status(400).json({
      error: `HQ level ${hq.level ?? 1} only allows mines up to level ${cfg.maxMineLevel}. Upgrade your HQ first.`,
    });
  }

  const cost = mineUpgradeCost(mine.level + 1);

  if (hq.coins < cost) {
    return res.status(400).json({ error: `Not enough coins (need ${cost}, have ${hq.coins})` });
  }

  const [{ error: hqUpdateError }, { data: updatedMine, error: mineUpdateError }] =
    await Promise.all([
      supabase.from('headquarters').update({ coins: hq.coins - cost }).eq('id', hq.id),
      supabase.from('mines').update({ level: mine.level + 1 }).eq('id', mine_id).select().single(),
    ]);

  if (hqUpdateError || mineUpdateError) {
    console.error('[upgrade] error:', hqUpdateError, mineUpdateError);
    return res.status(500).json({ error: 'Failed to upgrade mine' });
  }

  return res.status(200).json({ mine: updatedMine, hq_coins: hq.coins - cost });
}
