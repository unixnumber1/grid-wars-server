import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { calcAccumulatedCoins, getHQLimit } from '../../lib/formulas.js';
import { getCellsInRange } from '../../lib/grid.js';
import { addXp } from '../../lib/xp.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { telegram_id, lat, lng } = req.body;

  if (!telegram_id) {
    return res.status(400).json({ error: 'telegram_id is required' });
  }

  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id);
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player)     return res.status(404).json({ error: 'Player not found' });

  const { data: hq, error: hqError } = await supabase
    .from('headquarters')
    .select('id, coins, level')
    .eq('player_id', player.id)
    .maybeSingle();

  if (hqError) {
    console.error('[collect] hq error:', hqError);
    return res.status(500).json({ error: hqError.message });
  }
  if (!hq) return res.status(404).json({ error: 'Headquarters not found' });

  const { data: allMines, error: minesError } = await supabase
    .from('mines')
    .select('id, level, last_collected, cell_id')
    .eq('owner_id', player.id);

  if (minesError) {
    console.error('[collect] mines error:', minesError);
    return res.status(500).json({ error: 'Failed to fetch mines' });
  }

  if (!allMines || allMines.length === 0) {
    return res.status(200).json({ collected: 0, hq_coins: hq.coins });
  }

  // If player position provided, only collect mines within interaction zone (~500m)
  let mines = allMines;
  if (lat != null && lng != null) {
    const playerRange = getCellsInRange(parseFloat(lat), parseFloat(lng));
    mines = allMines.filter(m => playerRange.has(m.cell_id));
  }

  if (mines.length === 0) {
    return res.status(200).json({ collected: 0, hq_coins: hq.coins });
  }

  const now = new Date().toISOString();
  let totalCoins = 0;
  for (const mine of mines) {
    totalCoins += calcAccumulatedCoins(mine.level, mine.last_collected);
  }

  const hqLimit = getHQLimit(hq.level ?? 1);
  const newBalance = Math.min(hq.coins + totalCoins, hqLimit);
  const actualCollected = newBalance - hq.coins;

  const [{ error: hqUpdateError }, { error: minesUpdateError }] = await Promise.all([
    supabase.from('headquarters').update({ coins: newBalance }).eq('id', hq.id),
    supabase.from('mines').update({ last_collected: now }).in('id', mines.map((m) => m.id)),
  ]);

  if (hqUpdateError || minesUpdateError) {
    console.error('[collect] update error:', hqUpdateError, minesUpdateError);
    return res.status(500).json({ error: 'Failed to collect coins' });
  }

  const xpGained = Math.floor(actualCollected / 50);
  let xpResult = null;
  if (xpGained > 0) {
    try {
      xpResult = await addXp(player.id, xpGained);
      console.log('[collect] XP added:', JSON.stringify(xpResult));
    } catch (e) {
      console.error('[collect] XP ERROR:', e.message);
    }
  }

  return res.status(200).json({
    collected: actualCollected,
    total_accumulated: totalCoins,
    hq_coins: newBalance,
    xp: xpResult,
  });
}
