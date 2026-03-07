import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { mineUpgradeCost, MINE_MAX_LEVEL, hqConfig, getBuildRadius } from '../../lib/formulas.js';
import { getCellsInRange, radiusToDiskK } from '../../lib/grid.js';
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

  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id, 'id, level');
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player)     return res.status(404).json({ error: 'Player not found' });

  const [
    { data: mine,  error: mineError },
    { data: hq,    error: hqError },
  ] = await Promise.all([
    supabase.from('mines').select('*').eq('id', mine_id).maybeSingle(),
    supabase.from('headquarters').select('*').eq('player_id', player.id).maybeSingle(),
  ]);

  if (mineError) return res.status(500).json({ error: mineError.message });
  if (hqError)   return res.status(500).json({ error: hqError.message });
  if (!mine)     return res.status(404).json({ error: 'Mine not found' });
  if (!hq)       return res.status(404).json({ error: 'Headquarters not found' });

  if (mine.owner_id !== player.id) {
    return res.status(403).json({ error: 'You do not own this mine' });
  }

  // Block if upgrade already in progress
  if (mine.upgrade_finish_at && new Date(mine.upgrade_finish_at) > new Date()) {
    const secondsLeft = Math.ceil((new Date(mine.upgrade_finish_at) - new Date()) / 1000);
    return res.status(400).json({ error: `Апгрейд ещё идёт (${secondsLeft} сек)` });
  }

  // H3 range check
  if (lat != null && lng != null) {
    const buildRadius = getBuildRadius(player.level ?? 1);
    const diskK       = radiusToDiskK(buildRadius);
    const playerRange = getCellsInRange(parseFloat(lat), parseFloat(lng), diskK);
    if (!playerRange.has(mine.cell_id)) {
      return res.status(403).json({ error: `Шахта вне зоны взаимодействия (~${buildRadius}м)` });
    }
  }

  if (mine.level >= MINE_MAX_LEVEL) {
    return res.status(400).json({ error: 'Mine is already at max level' });
  }

  const cfg = hqConfig(hq.level ?? 1);
  if (mine.level + 1 > cfg.maxMineLevel) {
    return res.status(400).json({
      error: `HQ ур.${hq.level ?? 1} позволяет шахты до ур.${cfg.maxMineLevel}. Улучши штаб!`,
    });
  }

  const maxAllowed = Math.min(MINE_MAX_LEVEL, cfg.maxMineLevel);
  const targetLevel = Math.min(parseInt(targetLevelParam) || mine.level + 1, maxAllowed);

  if (targetLevel <= mine.level) {
    return res.status(400).json({ error: 'targetLevel должен быть выше текущего уровня' });
  }

  // Compute total cost
  let cost = 0;
  for (let l = mine.level; l < targetLevel; l++) cost += mineUpgradeCost(l);

  if (hq.coins < cost) {
    return res.status(400).json({ error: `Не хватает монет (нужно ${cost})` });
  }

  const levelsCount = targetLevel - mine.level;
  const finishAt = new Date(Date.now() + levelsCount * 2000);

  const [{ error: hqUpdateError }, { error: mineUpdateError }] = await Promise.all([
    supabase.from('headquarters').update({ coins: hq.coins - cost }).eq('id', hq.id),
    supabase.from('mines').update({
      pending_level: targetLevel,
      upgrade_finish_at: finishAt.toISOString(),
    }).eq('id', mine_id),
  ]);

  if (hqUpdateError || mineUpdateError) {
    console.error('[upgrade] error:', hqUpdateError, mineUpdateError);
    return res.status(500).json({ error: 'Failed to start upgrade' });
  }

  return res.status(200).json({
    upgrading: true,
    finishAt: finishAt.toISOString(),
    secondsLeft: levelsCount * 2,
    hq_coins: hq.coins - cost,
    pendingLevel: targetLevel,
  });
}
