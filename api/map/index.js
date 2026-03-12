import { supabase, getPlayerByTelegramId, parseTgId } from '../../lib/supabase.js';
import { getCellsInRange } from '../../lib/grid.js';

async function handleLeaderboard(req, res) {
  const { telegram_id } = req.query;

  const { data: top, error } = await supabase
    .from('players')
    .select('telegram_id, username, game_username, avatar, level, xp')
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
          .select('telegram_id, username, game_username, avatar, level, xp')
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
  if (view === 'markets') {
    const { data: mkts, error: mkErr } = await supabase
      .from('markets').select('id,lat,lng,name').limit(200);
    if (mkErr) return res.status(500).json({ error: mkErr.message });
    return res.json({ markets: mkts || [] });
  }

  if (view === 'health') {
    try {
      const { error } = await supabase.from('app_settings').select('key').limit(1);
      if (error) throw error;
      return res.json({ status: 'ok', db: 'connected' });
    } catch (err) {
      return res.status(503).json({ status: 'error', db: err.message });
    }
  }

  if (north == null || south == null || east == null || west == null) {
    return res.status(400).json({ error: 'north, south, east, west are required' });
  }

  const n = parseFloat(north), s = parseFloat(south);
  const e = parseFloat(east),  w = parseFloat(west);

  if (isNaN(n) || isNaN(s) || isNaN(e) || isNaN(w)) {
    return res.status(400).json({ error: 'Invalid bbox params' });
  }

  // Reject if bbox is too large (prevents loading thousands of objects)
  // At minZoom 15 + 20% pad, max bbox ~0.04° lat × 0.07° lng; 0.1° gives margin
  if ((n - s) > 0.1 || (e - w) > 0.1) {
    return res.json({ mines: [], headquarters: [], bots: [], vases: [], online_players: [] });
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
    { data: allCouriers, error: couriersErr },
    { data: allDrops,    error: dropsErr },
    { data: allMarkets,  error: marketsErr },
  ] = await Promise.all([
    supabase
      .from('headquarters')
      .select('id,lat,lng,level,player_id,players(username,game_username,avatar,last_seen,level)')
      .gte('lat', s).lte('lat', n)
      .gte('lng', w).lte('lng', e)
      .limit(2000),

    supabase
      .from('mines')
      .select('id,lat,lng,level,owner_id,cell_id,upgrade_finish_at,pending_level,last_collected,players!mines_owner_id_fkey(username,game_username,avatar,level)')
      .gte('lat', s).lte('lat', n)
      .gte('lng', w).lte('lng', e)
      .limit(2000),

    supabase
      .from('players')
      .select('id,username,game_username,avatar,last_lat,last_lng,last_seen,level')
      .gte('last_lat', s).lte('last_lat', n)
      .gte('last_lng', w).lte('last_lng', e)
      .gte('last_seen', onlineThreshold)
      .not('last_lat', 'is', null)
      .limit(100),

    supabase
      .from('bots')
      .select('id,type,emoji,category,lat,lng,coins_drained,drain_per_sec,reward_min,reward_max,speed,hp,max_hp,attack,size')
      .gt('expires_at', nowISO)
      .gte('lat', s).lte('lat', n)
      .gte('lng', w).lte('lng', e)
      .limit(500),

    supabase
      .from('vases')
      .select('id,lat,lng,expires_at')
      .gt('expires_at', nowISO)
      .is('broken_by', null)
      .gte('lat', s).lte('lat', n)
      .gte('lng', w).lte('lng', e)
      .limit(200),

    supabase
      .from('couriers')
      .select('id,type,owner_id,current_lat,current_lng,target_lat,target_lng,hp,max_hp,status,listing_id')
      .eq('status', 'moving')
      .gte('current_lat', s).lte('current_lat', n)
      .gte('current_lng', w).lte('current_lng', e)
      .limit(200),

    supabase
      .from('courier_drops')
      .select('id,item_id,lat,lng,expires_at')
      .eq('picked_up', false)
      .gt('expires_at', nowISO)
      .gte('lat', s).lte('lat', n)
      .gte('lng', w).lte('lng', e)
      .limit(100),

    supabase
      .from('markets')
      .select('id,lat,lng,name')
      .gte('lat', s).lte('lat', n)
      .gte('lng', w).lte('lng', e)
      .limit(50),
  ]);

  if (hqErr)       console.error('[map] hq error:', hqErr);
  if (minesErr)    console.error('[map] mines error:', minesErr);
  if (onlineErr)   console.error('[map] online error:', onlineErr);
  if (botsErr)     console.error('[map] bots error:', botsErr);
  if (vasesErr)    console.error('[map] vases error:', vasesErr);
  if (couriersErr) console.error('[map] couriers error:', couriersErr);
  if (dropsErr)    console.error('[map] drops error:', dropsErr);
  if (marketsErr)  console.error('[map] markets error:', marketsErr);

  const ONLINE_MS = 3 * 60 * 1000;

  const headquarters = (allHQ || []).map((hq) => ({
    id: hq.id, lat: hq.lat, lng: hq.lng, level: hq.level, player_id: hq.player_id,
    players: hq.players,
    is_mine:   currentPlayerId ? hq.player_id === currentPlayerId : false,
    is_online: hq.players?.last_seen
      ? (Date.now() - new Date(hq.players.last_seen).getTime()) < ONLINE_MS
      : false,
  }));

  const mines = (allMines || []).map((m) => ({
    id: m.id, lat: m.lat, lng: m.lng, level: m.level, owner_id: m.owner_id,
    cell_id: m.cell_id, last_collected: m.last_collected,
    upgrade_finish_at: m.upgrade_finish_at, pending_level: m.pending_level,
    players: m.players,
    is_mine:     currentPlayerId ? m.owner_id === currentPlayerId : false,
    can_capture: currentPlayerId && playerRange
      ? m.owner_id !== currentPlayerId && playerRange.has(m.cell_id)
      : false,
  }));

  const online_players = (allOnline || []).filter((p) => p.id !== currentPlayerId);
  const bots    = allBots    || [];
  const vases   = allVases   || [];
  const couriers     = allCouriers || [];
  const courier_drops = allDrops   || [];
  const markets      = allMarkets  || [];

  const responseData = { headquarters, mines, online_players, bots, vases, couriers, courier_drops, markets };
  console.log('[map] response size:', JSON.stringify(responseData).length, 'bytes, items:',
    { hq: headquarters.length, mines: mines.length, bots: bots.length, vases: vases.length, online: online_players.length, couriers: couriers.length, drops: courier_drops.length, markets: markets.length });

  return res.status(200).json(responseData);
}
