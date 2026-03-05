import { supabase } from '../../lib/supabase.js';
import { getCellId } from '../../lib/grid.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { telegram_id, lat, lng } = req.body;

  if (!telegram_id || lat == null || lng == null) {
    return res.status(400).json({ error: 'telegram_id, lat, lng are required' });
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

  // Check if player already has a HQ
  const { data: existingHq } = await supabase
    .from('headquarters')
    .select('id')
    .eq('player_id', player.id)
    .maybeSingle();

  if (existingHq) {
    return res.status(409).json({ error: 'Headquarters already placed' });
  }

  const cell_id = getCellId(parseFloat(lat), parseFloat(lng));

  // Check if cell is already occupied
  const { data: cellConflict } = await supabase
    .from('headquarters')
    .select('id')
    .eq('cell_id', cell_id)
    .maybeSingle();

  if (cellConflict) {
    return res.status(409).json({ error: 'Cell already occupied by another headquarters' });
  }

  const { data: hq, error: insertError } = await supabase
    .from('headquarters')
    .insert({
      player_id: player.id,
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      cell_id,
      coins: 0,
    })
    .select()
    .single();

  if (insertError) {
    console.error('HQ insert error:', insertError);
    return res.status(500).json({ error: 'Failed to place headquarters' });
  }

  return res.status(201).json({ headquarters: hq });
}
