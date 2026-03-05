import { supabase } from '../../lib/supabase.js';
import { calcAccumulatedCoins, HQ_COIN_LIMIT } from '../../lib/income.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { telegram_id } = req.body;

  if (!telegram_id) {
    return res.status(400).json({ error: 'telegram_id is required' });
  }

  // Resolve player
  const { data: player, error: playerError } = await supabase
    .from('players')
    .select('id')
    .eq('telegram_id', Number(telegram_id))
    .maybeSingle();

  if (playerError || !player) {
    return res.status(404).json({ error: 'Player not found' });
  }

  // Fetch HQ
  const { data: hq, error: hqError } = await supabase
    .from('headquarters')
    .select('id, coins')
    .eq('player_id', player.id)
    .maybeSingle();

  if (hqError || !hq) {
    return res.status(404).json({ error: 'Headquarters not found' });
  }

  // Fetch all mines owned by player
  const { data: mines, error: minesError } = await supabase
    .from('mines')
    .select('id, level, last_collected')
    .eq('owner_id', player.id);

  if (minesError) {
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

  // Update HQ coins and reset all mine last_collected timestamps
  const mineIds = mines.map((m) => m.id);

  const [{ error: hqUpdateError }, { error: minesUpdateError }] = await Promise.all([
    supabase.from('headquarters').update({ coins: newBalance }).eq('id', hq.id),
    supabase.from('mines').update({ last_collected: now }).in('id', mineIds),
  ]);

  if (hqUpdateError || minesUpdateError) {
    console.error('Collect error:', hqUpdateError, minesUpdateError);
    return res.status(500).json({ error: 'Failed to collect coins' });
  }

  return res.status(200).json({
    collected: actualCollected,
    total_accumulated: totalCoins,
    hq_coins: newBalance,
  });
}
