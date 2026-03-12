import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { mineUpgradeCost, MINE_MAX_LEVEL, SMALL_RADIUS } from '../../lib/formulas.js';
import { getCellsInRange, radiusToDiskK } from '../../lib/grid.js';
import { haversine } from '../../lib/haversine.js';
import { addXp, XP_REWARDS } from '../../lib/xp.js';

export default async function handler(req, res) {
  // GET: complete finished upgrades for a player
  if (req.method === 'GET') {
    const { telegram_id } = req.query;
    if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });

    const { player, error: playerError } = await getPlayerByTelegramId(telegram_id, 'id');
    if (playerError) return res.status(500).json({ error: playerError });
    if (!player)     return res.status(404).json({ error: 'Player not found' });

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

      if (upErr) { console.error('[upgrade GET] update error:', upErr); continue; }

      let xpResult = null;
      try { xpResult = await addXp(player.id, XP_REWARDS.UPGRADE_MINE(mine.pending_level)); }
      catch (e) { console.error('[upgrade GET] XP error:', e.message); }

      completed.push({ ...updated, xp: xpResult });
    }
    return res.json({ completed });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { telegram_id, mine_id, lat, lng, targetLevel: targetLevelParam } = req.body;

  if (!telegram_id || !mine_id) {
    return res.status(400).json({ error: 'telegram_id and mine_id are required' });
  }

  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id, 'id, level, coins, last_lat, last_lng');
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player)     return res.status(404).json({ error: 'Player not found' });

  const { data: mine, error: mineError } = await supabase
    .from('mines').select('id,owner_id,level,cell_id,lat,lng,pending_level,upgrade_finish_at').eq('id', mine_id).maybeSingle();

  if (mineError) return res.status(500).json({ error: mineError.message });
  if (!mine)     return res.status(404).json({ error: 'Mine not found' });

  if (mine.owner_id !== player.id) {
    return res.status(403).json({ error: 'You do not own this mine' });
  }

  // Block if upgrade already in progress
  if (mine.upgrade_finish_at && new Date(mine.upgrade_finish_at) > new Date()) {
    const secondsLeft = Math.ceil((new Date(mine.upgrade_finish_at) - new Date()) / 1000);
    return res.status(400).json({ error: `Апгрейд ещё идёт (${secondsLeft} сек)` });
  }

  // Strict haversine distance check — coordinates required
  if (lat == null || lng == null) {
    return res.status(400).json({ error: 'Координаты игрока не переданы' });
  }
  const pLat = parseFloat(lat);
  const pLng = parseFloat(lng);
  if (isNaN(pLat) || isNaN(pLng)) {
    return res.status(400).json({ error: 'Некорректные координаты' });
  }
  const distance = haversine(pLat, pLng, mine.lat, mine.lng);
  if (distance > SMALL_RADIUS) {
    return res.status(400).json({ error: `Слишком далеко! Подойди ближе (200м)`, distance: Math.round(distance) });
  }

  if (mine.level >= MINE_MAX_LEVEL) {
    return res.status(400).json({ error: 'Mine is already at max level' });
  }

  const targetLevel = Math.min(parseInt(targetLevelParam) || mine.level + 1, MINE_MAX_LEVEL);

  if (targetLevel <= mine.level) {
    return res.status(400).json({ error: 'targetLevel должен быть выше текущего уровня' });
  }

  // Compute total cost
  let cost = 0;
  for (let l = mine.level; l < targetLevel; l++) cost += mineUpgradeCost(l);

  const balance = player.coins ?? 0;
  if (balance < cost) {
    return res.status(400).json({ error: `Не хватает монет (нужно ${Math.round(cost).toLocaleString()})` });
  }

  const newBalance = balance - cost;
  const finishAt = new Date(Date.now() + 20000);

  const [{ error: playerUpdateError }, { error: mineUpdateError }] = await Promise.all([
    supabase.from('players').update({ coins: newBalance }).eq('id', player.id),
    supabase.from('mines').update({
      pending_level: targetLevel,
      upgrade_finish_at: finishAt.toISOString(),
    }).eq('id', mine_id),
  ]);

  if (playerUpdateError || mineUpdateError) {
    console.error('[upgrade] error:', playerUpdateError, mineUpdateError);
    return res.status(500).json({ error: 'Failed to start upgrade' });
  }

  return res.status(200).json({
    upgrading: true,
    finishAt: finishAt.toISOString(),
    secondsLeft: 20,
    player_coins: newBalance,
    pendingLevel: targetLevel,
  });
}
