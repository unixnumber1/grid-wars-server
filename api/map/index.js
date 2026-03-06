import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { haversine } from '../../lib/haversine.js';
import { getCellsInRange } from '../../lib/grid.js';

const RADIUS_METERS = 20000;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const telegramId = req.query.telegram_id || null;

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'lat and lng are required' });
  }

  // Resolve current player UUID for is_mine / can_capture
  let currentPlayerId = null;
  if (telegramId) {
    const { player } = await getPlayerByTelegramId(telegramId);
    if (player) currentPlayerId = player.id;
  }

  const onlineThreshold = new Date(Date.now() - 3 * 60 * 1000).toISOString();

  // Fetch ALL buildings + online players in parallel
  const [
    { data: allHQ,      error: hqErr },
    { data: allMines,   error: minesErr },
    { data: allOnline,  error: onlineErr },
  ] = await Promise.all([
    supabase.from('headquarters').select('*, players(username, last_seen)'),
    supabase.from('mines').select('*, players!mines_owner_id_fkey(username)'),
    supabase
      .from('players')
      .select('id, username, avatar, last_lat, last_lng, last_seen')
      .gte('last_seen', onlineThreshold)
      .not('last_lat', 'is', null),
  ]);

  if (hqErr)     console.error('[map] hq error:', hqErr);
  if (minesErr)  console.error('[map] mines error:', minesErr);
  if (onlineErr) console.error('[map] online error:', onlineErr);

  console.log('[map] online raw from DB:', JSON.stringify(allOnline));
  console.log('[map] currentPlayerId:', currentPlayerId, 'onlineThreshold:', onlineThreshold);

  const ONLINE_MS = 3 * 60 * 1000;
  const headquarters = (allHQ || [])
    .filter((hq) => haversine(lat, lng, hq.lat, hq.lng) <= RADIUS_METERS)
    .map((hq) => ({
      ...hq,
      is_mine:   currentPlayerId ? hq.player_id === currentPlayerId : false,
      is_online: hq.players?.last_seen
        ? (Date.now() - new Date(hq.players.last_seen).getTime()) < ONLINE_MS
        : false,
    }));

  const playerRange = getCellsInRange(lat, lng);

  const mines = (allMines || [])
    .filter((m) => haversine(lat, lng, m.lat, m.lng) <= RADIUS_METERS)
    .map((m) => ({
      ...m,
      is_mine:     currentPlayerId ? m.owner_id === currentPlayerId : false,
      can_capture: currentPlayerId
        ? m.owner_id !== currentPlayerId && playerRange.has(m.cell_id)
        : false,
    }));

  const ONLINE_RADIUS = 25000;
  const online_players = (allOnline || [])
    .filter((p) => p.id !== currentPlayerId)
    .filter((p) => haversine(lat, lng, p.last_lat, p.last_lng) <= ONLINE_RADIUS);

  console.log('[map] online after filter:', JSON.stringify(online_players));

  return res.status(200).json({ headquarters, mines, online_players });
}
