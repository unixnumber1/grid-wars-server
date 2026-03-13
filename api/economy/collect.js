import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { calcAccumulatedCoins, getMineIncome, SMALL_RADIUS } from '../../lib/formulas.js';
import { getCellCenter, getCell } from '../../lib/grid.js';
import { haversine } from '../../lib/haversine.js';
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
    .select('id, level, last_collected, cell_id, lat, lng, status')
    .eq('owner_id', player.id);

  if (minesError) {
    console.error('[collect] mines error:', minesError);
    return res.status(500).json({ error: 'Failed to fetch mines' });
  }

  if (!allMines || allMines.length === 0) {
    return res.status(200).json({ collected: 0, player_coins: player.coins ?? 0 });
  }

  // Coordinates required — strict haversine zone check
  if (lat == null || lng == null) {
    return res.status(400).json({ error: 'Координаты игрока не переданы' });
  }
  const pLat = parseFloat(lat), pLng = parseFloat(lng);
  const mines = allMines.filter(m => {
    if (m.status === 'burning' || m.status === 'destroyed') return false;
    const mLat = m.lat != null ? m.lat : getCellCenter(m.cell_id)[0];
    const mLng = m.lng != null ? m.lng : getCellCenter(m.cell_id)[1];
    return haversine(pLat, pLng, mLat, mLng) <= SMALL_RADIUS;
  });

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

  const [{ data: coinsOk, error: playerUpdateError }, { error: minesUpdateError }] = await Promise.all([
    supabase.from('players').update({ coins: newCoins }).eq('id', player.id).eq('coins', currentCoins).select('id').maybeSingle(),
    supabase.from('mines').update({ last_collected: now }).in('id', mines.map((m) => m.id)),
  ]);

  if (playerUpdateError || minesUpdateError) {
    console.error('[collect] update error:', playerUpdateError, minesUpdateError);
    return res.status(500).json({ error: 'Failed to collect coins' });
  }
  if (!coinsOk && !playerUpdateError) {
    return res.status(409).json({ error: 'Конфликт — попробуйте снова' });
  }

  // 0.1% of collected coins, minimum 1
  const collectedAmount = Math.round(totalCoins);
  const xpGained = collectedAmount > 0 ? Math.max(1, Math.floor(collectedAmount * 0.001)) : 0;
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
