import { supabase } from '../../lib/supabase.js';
import { getCellId } from '../../lib/grid.js';
import { haversine } from '../../lib/haversine.js';

const MINE_PLACEMENT_RADIUS = 500; // meters

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { telegram_id } = req.body;

  // Accept player_lat/player_lng + mine_lat/mine_lng (preferred),
  // or bare lat/lng as fallback for both positions.
  const playerActualLat = parseFloat(req.body.player_lat ?? req.body.lat);
  const playerActualLng = parseFloat(req.body.player_lng ?? req.body.lng);
  const mineLat         = parseFloat(req.body.mine_lat  ?? req.body.lat);
  const mineLng         = parseFloat(req.body.mine_lng  ?? req.body.lng);

  if (!telegram_id || isNaN(mineLat) || isNaN(mineLng) || isNaN(playerActualLat) || isNaN(playerActualLng)) {
    return res.status(400).json({ error: 'telegram_id, player position and mine position are required' });
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

  // Require headquarters
  const { data: hq } = await supabase
    .from('headquarters')
    .select('id, lat, lng')
    .eq('player_id', player.id)
    .maybeSingle();

  if (!hq) {
    return res.status(403).json({ error: 'You must place your headquarters first' });
  }

  const dist = haversine(playerActualLat, playerActualLng, mineLat, mineLng);
  if (dist > MINE_PLACEMENT_RADIUS) {
    return res.status(403).json({
      error: `Too far from target location (${Math.round(dist)}m, max ${MINE_PLACEMENT_RADIUS}m)`,
    });
  }

  const cell_id = getCellId(mineLat, mineLng);

  // Check cell not already occupied
  const { data: existingMine } = await supabase
    .from('mines')
    .select('id')
    .eq('cell_id', cell_id)
    .maybeSingle();

  if (existingMine) {
    return res.status(409).json({ error: 'A mine already exists on this cell' });
  }

  const { data: existingHqOnCell } = await supabase
    .from('headquarters')
    .select('id')
    .eq('cell_id', cell_id)
    .maybeSingle();

  if (existingHqOnCell) {
    return res.status(409).json({ error: 'Cell is occupied by a headquarters' });
  }

  const { data: mine, error: insertError } = await supabase
    .from('mines')
    .insert({
      owner_id: player.id,
      original_builder_id: player.id,
      lat: mineLat,
      lng: mineLng,
      cell_id,
      level: 1,
      last_collected: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertError) {
    console.error('Mine insert error:', insertError);
    return res.status(500).json({ error: 'Failed to place mine' });
  }

  return res.status(201).json({ mine });
}
