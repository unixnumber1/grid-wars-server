import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { getCell, getCellCenter, getCellsInRange, radiusToDiskK } from '../../lib/grid.js';
import { hqConfig, getBuildRadius } from '../../lib/formulas.js';
import { addXp, XP_REWARDS } from '../../lib/xp.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { telegram_id } = req.body;

  const playerActualLat = parseFloat(req.body.player_lat ?? req.body.lat);
  const playerActualLng = parseFloat(req.body.player_lng ?? req.body.lng);
  const mineLat         = parseFloat(req.body.mine_lat  ?? req.body.lat);
  const mineLng         = parseFloat(req.body.mine_lng  ?? req.body.lng);

  if (!telegram_id || isNaN(mineLat) || isNaN(mineLng) || isNaN(playerActualLat) || isNaN(playerActualLng)) {
    return res.status(400).json({ error: 'telegram_id, player position and mine position are required' });
  }

  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id, 'id, level');
  console.log('[mine] player:', player?.id, 'level:', player?.level, 'err:', playerError);
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player)     return res.status(404).json({ error: 'Player not found' });

  const { data: hq, error: hqError } = await supabase
    .from('headquarters')
    .select('*')
    .eq('player_id', player.id)
    .maybeSingle();

  if (hqError) {
    console.error('[mine] hq fetch error:', hqError);
    return res.status(500).json({ error: hqError.message });
  }
  if (!hq) {
    return res.status(403).json({ error: 'You must place your headquarters first' });
  }

  const { count: mineCount } = await supabase
    .from('mines')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', player.id);

  const cfg = hqConfig(hq.level ?? 1);
  console.log('[mine] mines count:', mineCount, 'max:', cfg.maxMines, 'hq level:', hq.level);
  if (mineCount >= cfg.maxMines) {
    return res.status(403).json({
      error: `Лимит шахт для HQ ур.${hq.level ?? 1} — ${cfg.maxMines} шт. Улучши штаб!`,
    });
  }

  // Dynamic build radius based on player level
  const buildRadius = getBuildRadius(player.level ?? 1);
  const diskK       = radiusToDiskK(buildRadius);
  console.log('[radius check] playerLevel:', player.level, 'buildRadius:', buildRadius, 'diskK:', diskK);
  const targetCell  = getCell(mineLat, mineLng);
  const playerRange = getCellsInRange(playerActualLat, playerActualLng, diskK);

  console.log('[mine] cell check: target:', targetCell, 'inRange:', playerRange.has(targetCell), 'radius:', buildRadius);

  if (!playerRange.has(targetCell)) {
    return res.status(403).json({
      error: `Цель вне зоны строительства (~${buildRadius}м)`,
    });
  }

  const [cellCenterLat, cellCenterLng] = getCellCenter(targetCell);

  const { data: existingMine } = await supabase
    .from('mines')
    .select('id')
    .eq('cell_id', targetCell)
    .maybeSingle();

  const { data: existingHqOnCell } = await supabase
    .from('headquarters')
    .select('id')
    .eq('cell_id', targetCell)
    .maybeSingle();

  console.log('[mine] cell check: existingMine:', existingMine?.id, 'existingHq:', existingHqOnCell?.id);

  if (existingMine) {
    return res.status(409).json({ error: 'A mine already exists on this cell' });
  }
  if (existingHqOnCell) {
    return res.status(409).json({ error: 'Cell is occupied by a headquarters' });
  }

  const { data: mine, error: insertError } = await supabase
    .from('mines')
    .insert({
      owner_id: player.id,
      original_builder_id: player.id,
      lat: cellCenterLat,
      lng: cellCenterLng,
      cell_id: targetCell,
      level: 0,
      last_collected: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertError) {
    console.error('[mine] insert error:', insertError);
    // Surface real DB error so it's visible in client and Vercel logs
    return res.status(500).json({ error: insertError.message });
  }

  let xpResult = null;
  try {
    xpResult = await addXp(player.id, XP_REWARDS.BUILD_MINE);
    console.log('[mine] XP added:', JSON.stringify(xpResult));
  } catch (e) {
    console.error('[mine] XP ERROR:', e.message);
  }

  return res.status(201).json({ mine, xp: xpResult });
}
