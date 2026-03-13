import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { getCell, getCellCenter } from '../../lib/grid.js';
import { SMALL_RADIUS } from '../../lib/formulas.js';
import { haversine } from '../../lib/haversine.js';
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
    .select('id')
    .eq('player_id', player.id)
    .maybeSingle();

  if (hqError) {
    console.error('[mine] hq fetch error:', hqError);
    return res.status(500).json({ error: hqError.message });
  }
  if (!hq) {
    return res.status(403).json({ error: 'You must place your headquarters first' });
  }

  const targetCell  = getCell(mineLat, mineLng);
  const [cellCenterLat, cellCenterLng] = getCellCenter(targetCell);

  // Strict haversine distance check to cell center
  const distance = haversine(playerActualLat, playerActualLng, cellCenterLat, cellCenterLng);
  if (distance > SMALL_RADIUS) {
    return res.status(400).json({
      error: `Слишком далеко (${Math.round(distance)}м > ${SMALL_RADIUS}м)`,
      distance: Math.round(distance),
    });
  }

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
      hp: 0,
      max_hp: 0,
      last_collected: new Date().toISOString(),
    })
    .select('id,owner_id,lat,lng,cell_id,level,last_collected,upgrade_finish_at,pending_level,hp,max_hp')
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
