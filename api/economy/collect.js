import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { calcAccumulatedCoins, HQ_COIN_LIMIT } from '../../lib/formulas.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { telegram_id } = req.body;

  if (!telegram_id) {
    return res.status(400).json({ error: 'telegram_id is required' });
  }

  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id);
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player)     return res.status(404).json({ error: 'Player not found' });

  const { data: hq, error: hqError } = await supabase
    .from('headquarters')
    .select('id, coins')
    .eq('player_id', player.id)
    .maybeSingle();

  if (hqError) {
    console.error('[collect] hq error:', hqError);
    return res.status(500).json({ error: hqError.message });
  }
  if (!hq) return res.status(404).json({ error: 'Headquarters not found' });

  const { data: mines, error: minesError } = await supabase
    .from('mines')
    .select('id, level, last_collected')
    .eq('owner_id', player.id);

  if (minesError) {
    console.error('[collect] mines error:', minesError);
    return res.status(500).json({ error: 'Failed to fetch mines' });
  }

  if (!mines || mines.length === 0) {
    return res.status(200).json({ collected: 0, hq_coins: hq.coins });
  }

  const now = new Date().toISOString();
  let totalCoins = 0;
  for (const mine of mines) {
    totalCoins += calcAccumulatedCoins(mine.level, mine.last_collected);
  }

  const newBalance = Math.min(hq.coins + totalCoins, HQ_COIN_LIMIT);
  const actualCollected = newBalance - hq.coins;

  const [{ error: hqUpdateError }, { error: minesUpdateError }] = await Promise.all([
    supabase.from('headquarters').update({ coins: newBalance }).eq('id', hq.id),
    supabase.from('mines').update({ last_collected: now }).in('id', mines.map((m) => m.id)),
  ]);

  if (hqUpdateError || minesUpdateError) {
    console.error('[collect] update error:', hqUpdateError, minesUpdateError);
    return res.status(500).json({ error: 'Failed to collect coins' });
  }

  return res.status(200).json({
    collected: actualCollected,
    total_accumulated: totalCoins,
    hq_coins: newBalance,
  });
}
