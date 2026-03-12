import { supabase } from '../../lib/supabase.js';
import { getCellCenter } from '../../lib/grid.js';
import { haversine } from '../../lib/haversine.js';

const ADMIN_TG_ID = 560013667;

async function _notifyAllPlayers(text) {
  const { data: players } = await supabase
    .from('players')
    .select('telegram_id')
    .not('telegram_id', 'is', null);

  let sent = 0;
  const BOT = process.env.BOT_TOKEN;
  if (!BOT || !players?.length) return sent;

  // Send in batches of 30 (Telegram rate limit ~30 msg/sec)
  for (let i = 0; i < players.length; i += 30) {
    const batch = players.slice(i, i + 30);
    const results = await Promise.allSettled(
      batch.map(p =>
        fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: p.telegram_id, text, parse_mode: 'HTML' }),
        })
      )
    );
    sent += results.filter(r => r.status === 'fulfilled').length;
    // Small delay between batches to respect Telegram rate limits
    if (i + 30 < players.length) await new Promise(r => setTimeout(r, 1000));
  }
  return sent;
}

export default async function handler(req, res) {
  // GET — public status check OR admin queries
  if (req.method === 'GET') {
    const { action, admin_id, search } = req.query || {};

    // ── players-list: search players by username ──
    if (action === 'players-list') {
      const adminId = parseInt(admin_id, 10);
      if (adminId !== ADMIN_TG_ID) return res.status(403).json({ error: 'Forbidden' });

      const q = (search || '').trim();
      if (!q) return res.status(200).json({ players: [] });

      const { data, error } = await supabase
        .from('players')
        .select('id, username, game_username, avatar, level, coins, diamonds, is_banned, ban_reason, ban_until')
        .or(`username.ilike.%${q}%,game_username.ilike.%${q}%`)
        .order('last_seen', { ascending: false })
        .limit(20);

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ players: data || [] });
    }

    // ── default: maintenance status ──
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'maintenance_mode')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ maintenance: data?.value === 'true' });
  }

  // POST — admin actions
  if (req.method === 'POST') {
    const { telegram_id, admin_id, enabled, action } = req.body;
    const tgId = parseInt(telegram_id || admin_id, 10);
    if (tgId !== ADMIN_TG_ID) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // ── fix-positions: snap all HQs and mines to cell centers ──
    if (action === 'fix-positions') {
      const [{ data: hqs }, { data: mines }] = await Promise.all([
        supabase.from('headquarters').select('id, cell_id'),
        supabase.from('mines').select('id, cell_id'),
      ]);

      const hqUpdates  = (hqs  || []).map(({ id, cell_id }) => {
        const [lat, lng] = getCellCenter(cell_id);
        return supabase.from('headquarters').update({ lat, lng }).eq('id', id);
      });
      const mineUpdates = (mines || []).map(({ id, cell_id }) => {
        const [lat, lng] = getCellCenter(cell_id);
        return supabase.from('mines').update({ lat, lng }).eq('id', id);
      });

      await Promise.all([...hqUpdates, ...mineUpdates]);
      return res.status(200).json({ fixed_hq: hqs?.length ?? 0, fixed_mines: mines?.length ?? 0 });
    }

    // ── fix-usernames: backfill owner_username on all headquarters ──
    if (action === 'fix-usernames') {
      const { data: allHQ } = await supabase.from('headquarters').select('id, player_id');
      for (const hq of (allHQ || [])) {
        const { data: player } = await supabase.from('players').select('username').eq('id', hq.player_id).single();
        await supabase.from('headquarters').update({ owner_username: player?.username ?? null }).eq('id', hq.id);
      }
      return res.status(200).json({ fixed: allHQ?.length ?? 0 });
    }

    // ── reward: give coins or diamonds to a player ──
    if (action === 'reward') {
      const { player_id, currency, amount } = req.body;
      if (!player_id || !currency || !amount) {
        return res.status(400).json({ error: 'player_id, currency, amount are required' });
      }
      if (currency !== 'coins' && currency !== 'diamonds') {
        return res.status(400).json({ error: 'currency must be coins or diamonds' });
      }
      const numAmount = parseInt(amount, 10);
      if (isNaN(numAmount) || numAmount <= 0) {
        return res.status(400).json({ error: 'amount must be a positive number' });
      }

      const { data: player, error: fetchErr } = await supabase
        .from('players').select('id, coins, diamonds').eq('id', player_id).single();
      if (fetchErr || !player) return res.status(404).json({ error: 'Player not found' });

      const newBalance = (player[currency] ?? 0) + numAmount;
      const { error: updateErr } = await supabase
        .from('players').update({ [currency]: newBalance }).eq('id', player_id);
      if (updateErr) return res.status(500).json({ error: updateErr.message });

      return res.status(200).json({ success: true, newBalance });
    }

    // ── ban: ban a player ──
    if (action === 'ban') {
      const { player_id, reason, duration_days } = req.body;
      if (!player_id) return res.status(400).json({ error: 'player_id is required' });
      if (!reason) return res.status(400).json({ error: 'reason is required' });

      const days = parseInt(duration_days, 10);
      if (isNaN(days) || days < 0) return res.status(400).json({ error: 'Invalid duration_days' });

      const banUntil = days === 0 ? null : new Date(Date.now() + days * 86400000).toISOString();

      const { error } = await supabase
        .from('players')
        .update({
          is_banned: true,
          ban_reason: reason,
          ban_until: banUntil,
          banned_at: new Date().toISOString(),
        })
        .eq('id', player_id);
      if (error) return res.status(500).json({ error: error.message });

      return res.status(200).json({ success: true, banned: true, until: banUntil });
    }

    // ── unban: unban a player ──
    if (action === 'unban') {
      const { player_id } = req.body;
      if (!player_id) return res.status(400).json({ error: 'player_id is required' });

      const { error } = await supabase
        .from('players')
        .update({ is_banned: false, ban_reason: null, ban_until: null })
        .eq('id', player_id);
      if (error) return res.status(500).json({ error: error.message });

      return res.status(200).json({ success: true, unbanned: true });
    }

    // ── fix-hq: remove duplicate headquarters (keep oldest per player) ──
    if (action === 'fix-hq') {
      const { data: allHqs, error: allError } = await supabase
        .from('headquarters')
        .select('id, player_id, created_at')
        .order('created_at', { ascending: true });

      if (allError) return res.status(500).json({ error: allError.message });

      const byPlayer = {};
      for (const hq of allHqs) {
        if (!byPlayer[hq.player_id]) byPlayer[hq.player_id] = [];
        byPlayer[hq.player_id].push(hq);
      }

      const toDelete = [];
      for (const [, hqs] of Object.entries(byPlayer)) {
        if (hqs.length > 1) {
          for (let i = 1; i < hqs.length; i++) toDelete.push(hqs[i].id);
        }
      }

      if (toDelete.length === 0) {
        return res.status(200).json({ success: true, deleted: 0, message: 'Дублей не найдено' });
      }

      const { error: delError } = await supabase.from('headquarters').delete().in('id', toDelete);
      if (delError) return res.status(500).json({ error: delError.message });

      return res.status(200).json({
        success: true,
        deleted: toDelete.length,
        message: `Удалено ${toDelete.length} дублей штабов`,
      });
    }

    // ── generate-markets: create market locations from OSM data ──
    if (action === 'generate-markets') {
      const MIN_MARKET_DISTANCE = 1000;
      const MIN_HQ_DISTANCE = 500; // markets must be at least 500m from any HQ
      const MAX_MARKETS_PER_CLUSTER = 2;
      const CLUSTER_RADIUS = 10000;

      const { data: hqs, error: hqErr } = await supabase
        .from('headquarters')
        .select('id, lat, lng');

      if (hqErr) return res.status(500).json({ error: hqErr.message });
      if (!hqs || hqs.length === 0) return res.json({ generated: 0, markets: [] });

      const clusters = [];
      for (const hq of hqs) {
        let assigned = false;
        for (const cl of clusters) {
          if (haversine(hq.lat, hq.lng, cl.lat, cl.lng) <= CLUSTER_RADIUS) {
            cl.hqs.push(hq);
            cl.lat = cl.hqs.reduce((s, h) => s + h.lat, 0) / cl.hqs.length;
            cl.lng = cl.hqs.reduce((s, h) => s + h.lng, 0) / cl.hqs.length;
            assigned = true;
            break;
          }
        }
        if (!assigned) {
          clusters.push({ lat: hq.lat, lng: hq.lng, hqs: [hq] });
        }
      }

      console.log('[generate-markets] clusters:', clusters.length);

      const allMarkets = [];

      for (const cluster of clusters) {
        let osmPoints = [];
        try {
          const radius = 5000;
          const query = `
            [out:json][timeout:10];
            (
              node["highway"="traffic_signals"](around:${radius},${cluster.lat},${cluster.lng});
              node["highway"="crossing"](around:${radius},${cluster.lat},${cluster.lng});
              node["place"="square"](around:${radius},${cluster.lat},${cluster.lng});
              node["amenity"="marketplace"](around:${radius},${cluster.lat},${cluster.lng});
              node["shop"="mall"](around:${radius},${cluster.lat},${cluster.lng});
            );
            out center 50;
          `;

          const resp = await fetch(
            `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`,
            { signal: AbortSignal.timeout(15000) }
          );

          if (resp.ok) {
            const data = await resp.json();
            osmPoints = (data.elements || [])
              .filter(el => el.lat && el.lon)
              .map(el => ({ lat: el.lat, lng: el.lon, name: el.tags?.name || null }));
          }
        } catch (e) {
          console.error('[generate-markets] Overpass error for cluster:', e.message);
        }

        console.log('[generate-markets] OSM points for cluster:', osmPoints.length);

        const selectedPoints = [];

        osmPoints.sort((a, b) =>
          haversine(cluster.lat, cluster.lng, a.lat, a.lng) -
          haversine(cluster.lat, cluster.lng, b.lat, b.lng)
        );

        for (const pt of osmPoints) {
          if (selectedPoints.length >= MAX_MARKETS_PER_CLUSTER) break;
          const tooCloseToMarket = [...allMarkets, ...selectedPoints].some(
            m => haversine(pt.lat, pt.lng, m.lat, m.lng) < MIN_MARKET_DISTANCE
          );
          if (tooCloseToMarket) continue;
          // Must be at least 500m from any HQ
          const tooCloseToHQ = hqs.some(
            h => haversine(pt.lat, pt.lng, h.lat, h.lng) < MIN_HQ_DISTANCE
          );
          if (tooCloseToHQ) continue;
          selectedPoints.push(pt);
        }

        // Fallback: offset from cluster center (1-2km in random direction)
        if (selectedPoints.length === 0) {
          for (let attempt = 0; attempt < 4 && selectedPoints.length === 0; attempt++) {
            const angle = Math.random() * 2 * Math.PI;
            const offsetDeg = 0.01 + Math.random() * 0.01; // ~1-2km
            const fallbackLat = cluster.lat + Math.cos(angle) * offsetDeg;
            const fallbackLng = cluster.lng + Math.sin(angle) * offsetDeg / Math.cos(cluster.lat * Math.PI / 180);
            const tooCloseM = allMarkets.some(
              m => haversine(fallbackLat, fallbackLng, m.lat, m.lng) < MIN_MARKET_DISTANCE
            );
            const tooCloseH = hqs.some(
              h => haversine(fallbackLat, fallbackLng, h.lat, h.lng) < MIN_HQ_DISTANCE
            );
            if (!tooCloseM && !tooCloseH) {
              selectedPoints.push({ lat: fallbackLat, lng: fallbackLng, name: null });
            }
          }
        }

        allMarkets.push(...selectedPoints);
      }

      if (allMarkets.length === 0) {
        return res.json({ generated: 0, markets: [] });
      }

      await supabase.from('markets').delete().neq('id', '00000000-0000-0000-0000-000000000000');

      const rows = allMarkets.map(m => ({
        lat: m.lat,
        lng: m.lng,
        name: m.name || `Market #${allMarkets.indexOf(m) + 1}`,
      }));

      const { data: inserted, error: insertErr } = await supabase
        .from('markets')
        .insert(rows)
        .select('id, lat, lng, name');

      if (insertErr) {
        console.error('[generate-markets] insert error:', insertErr);
        return res.status(500).json({ error: insertErr.message });
      }

      return res.json({ generated: (inserted || []).length, markets: inserted || [] });
    }

    // ── maintenance-start: enable maintenance + notify all players ──
    if (action === 'maintenance-start') {
      const { message } = req.body;
      const { error: setErr } = await supabase
        .from('app_settings')
        .upsert({ key: 'maintenance_mode', value: 'true' }, { onConflict: 'key' });
      if (setErr) return res.status(500).json({ error: setErr.message });

      const text = message
        || '🔧 Начались технические работы. Игра временно недоступна. Следите за обновлениями!';
      const sent = await _notifyAllPlayers(text);
      return res.status(200).json({ success: true, maintenance: true, notified: sent });
    }

    // ── maintenance-end: disable maintenance + notify all players ──
    if (action === 'maintenance-end') {
      const { message } = req.body;
      const { error: setErr } = await supabase
        .from('app_settings')
        .upsert({ key: 'maintenance_mode', value: 'false' }, { onConflict: 'key' });
      if (setErr) return res.status(500).json({ error: setErr.message });

      const text = message
        || '✅ Технические работы завершены! Игра снова доступна. Удачной охоты! ⚔️';
      const sent = await _notifyAllPlayers(text);
      return res.status(200).json({ success: true, maintenance: false, notified: sent });
    }

    // ── maintenance toggle (default) ──
    const value = enabled ? 'true' : 'false';
    const { error } = await supabase
      .from('app_settings')
      .upsert({ key: 'maintenance_mode', value }, { onConflict: 'key' });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ maintenance: enabled });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
