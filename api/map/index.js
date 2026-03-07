import { supabase, getPlayerByTelegramId, parseTgId } from '../../lib/supabase.js';
import { getCellsInRange } from '../../lib/grid.js';

async function handleLeaderboard(req, res) {
  const { telegram_id } = req.query;

  const { data: top, error } = await supabase
    .from('players')
    .select('telegram_id, username, avatar, level, xp')
    .order('xp', { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });

  const ranked = top.map((p, i) => ({ ...p, rank: i + 1 }));

  let current = null;
  if (telegram_id) {
    let tgId;
    try { tgId = parseTgId(telegram_id); } catch (e) { /* ignore */ }
    if (tgId) {
      const inTop = ranked.find(p => String(p.telegram_id) === String(tgId));
      if (!inTop) {
        const { data: player } = await supabase
          .from('players')
          .select('telegram_id, username, avatar, level, xp')
          .eq('telegram_id', tgId)
          .maybeSingle();
        if (player) {
          const { count } = await supabase
            .from('players')
            .select('*', { count: 'exact', head: true })
            .gt('xp', player.xp);
          current = { ...player, rank: (count || 0) + 1 };
        }
      }
    }
  }

  return res.status(200).json({ top: ranked, current });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { north, south, east, west, telegram_id, lat, lng, view } = req.query;

  if (view === 'leaderboard') return handleLeaderboard(req, res);

  if (north == null || south == null || east == null || west == null) {
    return res.status(400).json({ error: 'north, south, east, west are required' });
  }

  const n = parseFloat(north), s = parseFloat(south);
  const e = parseFloat(east),  w = parseFloat(west);

  if (isNaN(n) || isNaN(s) || isNaN(e) || isNaN(w)) {
    return res.status(400).json({ error: 'Invalid bbox params' });
  }

  // Reject if bbox is too large (prevents loading thousands of objects)
  if ((n - s) > 0.5 || (e - w) > 0.5) {
    return res.status(400).json({ error: 'Zoom in to see buildings' });
  }

  // Resolve current player UUID for is_mine / can_capture
  let currentPlayerId = null;
  if (telegram_id) {
    const { player } = await getPlayerByTelegramId(telegram_id);
    if (player) currentPlayerId = player.id;
  }

  // Player cell range for can_capture (optional, needs lat/lng)
  let playerRange = null;
  const pLat = parseFloat(lat);
  const pLng = parseFloat(lng);
  if (!isNaN(pLat) && !isNaN(pLng)) {
    playerRange = getCellsInRange(pLat, pLng);
  }

  const onlineThreshold = new Date(Date.now() - 3 * 60 * 1000).toISOString();

  const nowISO = new Date().toISOString();

  const [
    { data: allHQ,     error: hqErr },
    { data: allMines,  error: minesErr },
    { data: allOnline, error: onlineErr },
    { data: allBots,   error: botsErr },
    { data: allVases,  error: vasesErr },
  ] = await Promise.all([
    supabase
      .from('headquarters')
      .select('*, players(username, avatar, last_seen, level)')
      .gte('lat', s).lte('lat', n)
      .gte('lng', w).lte('lng', e),

    supabase
      .from('mines')
      .select('*, players!mines_owner_id_fkey(username, avatar, level)')
      .gte('lat', s).lte('lat', n)
      .gte('lng', w).lte('lng', e),

    supabase
      .from('players')
      .select('id, username, avatar, last_lat, last_lng, last_seen, level')
      .gte('last_lat', s).lte('last_lat', n)
      .gte('last_lng', w).lte('last_lng', e)
      .gte('last_seen', onlineThreshold)
      .not('last_lat', 'is', null),

    supabase
      .from('bots')
      .select('id, type, emoji, category, lat, lng, coins_drained, drain_per_sec, reward_min, reward_max, speed, hp, max_hp, attack, size')
      .gt('expires_at', nowISO)
      .gte('lat', s).lte('lat', n)
      .gte('lng', w).lte('lng', e),

    supabase
      .from('vases')
      .select('id, lat, lng, expires_at')
      .gt('expires_at', nowISO)
      .is('broken_by', null)
      .gte('lat', s).lte('lat', n)
      .gte('lng', w).lte('lng', e),
  ]);

  if (hqErr)    console.error('[map] hq error:', hqErr);
  if (minesErr) console.error('[map] mines error:', minesErr);
  if (onlineErr) console.error('[map] online error:', onlineErr);
  if (botsErr)  console.error('[map] bots error:', botsErr);
  if (vasesErr) console.error('[map] vases error:', vasesErr);

  const ONLINE_MS = 3 * 60 * 1000;

  const headquarters = (allHQ || []).map((hq) => ({
    ...hq,
    is_mine:   currentPlayerId ? hq.player_id === currentPlayerId : false,
    is_online: hq.players?.last_seen
      ? (Date.now() - new Date(hq.players.last_seen).getTime()) < ONLINE_MS
      : false,
  }));

  const mines = (allMines || []).map((m) => ({
    ...m,
    is_mine:     currentPlayerId ? m.owner_id === currentPlayerId : false,
    can_capture: currentPlayerId && playerRange
      ? m.owner_id !== currentPlayerId && playerRange.has(m.cell_id)
      : false,
  }));

  const online_players = (allOnline || []).filter((p) => p.id !== currentPlayerId);
  const bots  = allBots  || [];
  const vases = allVases || [];

  return res.status(200).json({ headquarters, mines, online_players, bots, vases });
}
