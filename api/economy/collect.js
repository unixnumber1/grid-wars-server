import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { calcAccumulatedCoins, getMineIncome } from '../../lib/formulas.js';
import { getCellsInRange, radiusToDiskK } from '../../lib/grid.js';
import { SMALL_RADIUS } from '../../lib/formulas.js';
import { addXp } from '../../lib/xp.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { telegram_id, lat, lng } = req.body;

  if (!telegram_id) {
    return res.status(400).json({ error: 'telegram_id is required' });
  }

  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id, 'id, coins');
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player)     return res.status(404).json({ error: 'Player not found' });

  const { data: allMines, error: minesError } = await supabase
    .from('mines')
    .select('id, level, last_collected, cell_id')
    .eq('owner_id', player.id);

  if (minesError) {
    console.error('[collect] mines error:', minesError);
    return res.status(500).json({ error: 'Failed to fetch mines' });
  }

  if (!allMines || allMines.length === 0) {
    return res.status(200).json({ collected: 0, player_coins: player.coins ?? 0 });
  }

  // Only collect mines within build zone (~200m)
  let mines = allMines;
  if (lat != null && lng != null) {
    const diskK = radiusToDiskK(SMALL_RADIUS);
    const playerRange = getCellsInRange(parseFloat(lat), parseFloat(lng), diskK);
    mines = allMines.filter(m => playerRange.has(m.cell_id));
  }

  if (mines.length === 0) {
    return res.status(200).json({ collected: 0, player_coins: player.coins ?? 0 });
  }

  const now = new Date().toISOString();

  let totalCoins = 0;
  for (const mine of mines) {
    totalCoins += calcAccumulatedCoins(mine.level, mine.last_collected);
  }

  const currentCoins = player.coins ?? 0;
  const newCoins = currentCoins + Math.round(totalCoins);

  const [{ error: playerUpdateError }, { error: minesUpdateError }] = await Promise.all([
    supabase.from('players').update({ coins: newCoins }).eq('id', player.id),
    supabase.from('mines').update({ last_collected: now }).in('id', mines.map((m) => m.id)),
  ]);

  if (playerUpdateError || minesUpdateError) {
    console.error('[collect] update error:', playerUpdateError, minesUpdateError);
    return res.status(500).json({ error: 'Failed to collect coins' });
  }

  const xpGained = Math.floor(totalCoins / 50);
  let xpResult = null;
  if (xpGained > 0) {
    try {
      xpResult = await addXp(player.id, xpGained);
      console.log('[collect] XP added:', JSON.stringify(xpResult));
    } catch (e) {
      console.error('[collect] XP ERROR:', e.message);
    }
  }

  const totalIncome = allMines.reduce((sum, m) => sum + getMineIncome(m.level), 0);

  return res.status(200).json({
    collected:         Math.round(totalCoins),
    total_accumulated: Math.round(totalCoins),
    player_coins:      newCoins,
    xp:                xpResult,
    totalIncome,
  });
}
