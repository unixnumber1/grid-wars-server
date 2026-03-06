import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { telegram_id, lat, lng } = req.body;
  if (!telegram_id || lat == null || lng == null) {
    return res.status(400).json({ error: 'telegram_id, lat, lng are required' });
  }

  const playerLat = parseFloat(lat);
  const playerLng = parseFloat(lng);
  if (isNaN(playerLat) || isNaN(playerLng)) {
    return res.status(400).json({ error: 'lat and lng must be numbers' });
  }

  console.log('[location] update:', telegram_id, playerLat, playerLng);

  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id);
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player)     return res.status(404).json({ error: 'Player not found' });

  const { data, error } = await supabase
    .from('players')
    .update({ last_lat: playerLat, last_lng: playerLng, last_seen: new Date().toISOString() })
    .eq('id', player.id)
    .select('id, last_lat, last_lng, last_seen');

  console.log('[location] supabase result:', JSON.stringify(data), error ? error.message : null);

  if (error) {
    return res.status(500).json({ error: 'Failed to update location' });
  }

  return res.status(200).json({ ok: true });
}
