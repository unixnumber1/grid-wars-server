import { supabase } from './supabase.js';
import { gameState } from './gameState.js';
import { haversine } from './haversine.js';
import { getCellId, getCellCenter } from './grid.js';

const MIN_DISTANCE = 500;
const MAX_DISTANCE = 5000;
const MIN_DISTANCE_BETWEEN_MARKETS = 500;

/**
 * Find a market location — prioritize real shopping centers/malls.
 * Snaps result to hex cell center.
 */
async function findMarketLocation(hqLat, hqLng, existingMarkets) {
  // Step 1: Search for real commercial objects first
  const primaryQuery = `
    [out:json][timeout:15];
    (
      nwr["shop"="mall"](around:${MAX_DISTANCE},${hqLat},${hqLng});
      nwr["shop"="department_store"](around:${MAX_DISTANCE},${hqLat},${hqLng});
      nwr["amenity"="marketplace"](around:${MAX_DISTANCE},${hqLat},${hqLng});
      nwr["building"="retail"]["name"](around:${MAX_DISTANCE},${hqLat},${hqLng});
    );
    out center 100;
  `;

  let osmPoints = await _queryOverpass(primaryQuery, hqLat, hqLng);

  // Step 2: If no malls/markets found, try secondary commercial
  if (!osmPoints.length) {
    const secondaryQuery = `
      [out:json][timeout:15];
      (
        nwr["shop"="supermarket"](around:${MAX_DISTANCE},${hqLat},${hqLng});
        nwr["shop"="shopping_centre"](around:${MAX_DISTANCE},${hqLat},${hqLng});
        nwr["building"="commercial"]["name"](around:${MAX_DISTANCE},${hqLat},${hqLng});
        node["place"="square"](around:${MAX_DISTANCE},${hqLat},${hqLng});
        node["highway"="traffic_signals"](around:${MAX_DISTANCE},${hqLat},${hqLng});
      );
      out center 100;
    `;
    osmPoints = await _queryOverpass(secondaryQuery, hqLat, hqLng);
  }

  if (!osmPoints.length) return null;

  // Priority: mall > department > marketplace > retail > supermarket > rest
  osmPoints.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return haversine(hqLat, hqLng, a.lat, a.lng) - haversine(hqLat, hqLng, b.lat, b.lng);
  });

  for (const pt of osmPoints) {
    const dist = haversine(hqLat, hqLng, pt.lat, pt.lng);
    if (dist < MIN_DISTANCE || dist > MAX_DISTANCE) continue;

    // Snap to hex cell center
    const cellId = getCellId(pt.lat, pt.lng);
    const [cLat, cLng] = getCellCenter(cellId);

    const tooClose = existingMarkets.some(
      m => haversine(cLat, cLng, m.lat, m.lng) < MIN_DISTANCE_BETWEEN_MARKETS
    );
    if (tooClose) continue;

    // Replace mine in this cell if any
    _replaceMineInCell(cellId);

    return { lat: cLat, lng: cLng, name: pt.name };
  }

  return null;
}

async function _queryOverpass(query, hqLat, hqLng) {
  try {
    const resp = await fetch(
      `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`,
      { signal: AbortSignal.timeout(20000) }
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.elements || [])
      .filter(el => (el.lat && el.lon) || (el.center?.lat && el.center?.lon))
      .map(el => {
        const lat = el.center?.lat ?? el.lat;
        const lng = el.center?.lon ?? el.lon;
        const tags = el.tags || {};
        let priority;
        if (tags.shop === 'mall') priority = 1;
        else if (tags.shop === 'department_store') priority = 2;
        else if (tags.amenity === 'marketplace') priority = 3;
        else if (tags.building === 'retail') priority = 4;
        else if (tags.shop === 'supermarket') priority = 5;
        else if (tags.shop === 'shopping_centre') priority = 5;
        else if (tags.building === 'commercial') priority = 6;
        else priority = 7;
        return { lat, lng, name: tags.name || null, priority };
      });
  } catch (e) {
    console.error('[markets] Overpass error:', e.message);
    return [];
  }
}

function _replaceMineInCell(cellId) {
  if (!gameState.loaded) return;
  const mine = gameState.getMineByCellId(cellId);
  if (!mine) return;
  gameState.removeMine(mine.id);
  supabase.from('mines').delete().eq('id', mine.id).then(() => {}).catch(() => {});
  if (mine.owner_id) {
    const notif = {
      id: globalThis.crypto.randomUUID(),
      player_id: mine.owner_id,
      type: 'mine_destroyed_by_market',
      message: `🏪 Рынок заменил вашу шахту Ур.${mine.level}!`,
      read: false,
      created_at: new Date().toISOString(),
    };
    gameState.addNotification(notif);
    supabase.from('notifications').insert(notif).then(() => {}).catch(() => {});
  }
  console.log(`[markets] Replaced mine lv${mine.level} in cell ${cellId}`);
}

/**
 * Ensure there's a market within 5km of this player's HQ.
 */
export async function ensureMarketNearPlayer(playerLat, playerLng, playerId) {
  if (!playerLat || !playerLng || playerLat === 0) return;
  try {
    let hq = null;
    if (gameState.loaded && playerId) hq = gameState.getHqByPlayerId(playerId);
    if (!hq && playerId) {
      const { data } = await supabase.from('headquarters').select('id,lat,lng').eq('player_id', playerId).maybeSingle();
      hq = data;
    }
    const anchorLat = hq?.lat ?? playerLat;
    const anchorLng = hq?.lng ?? playerLng;

    let existingMarkets;
    if (gameState.loaded) existingMarkets = gameState.getAllMarkets();
    else {
      const { data } = await supabase.from('markets').select('id,lat,lng,name').limit(500);
      existingMarkets = data || [];
    }

    const nearby = existingMarkets.find(m => haversine(anchorLat, anchorLng, m.lat, m.lng) <= MAX_DISTANCE);
    if (nearby) return;

    console.log(`[markets] No market within ${MAX_DISTANCE}m of HQ — spawning...`);
    const location = await findMarketLocation(anchorLat, anchorLng, existingMarkets);
    if (!location) { console.log('[markets] No suitable location found'); return; }

    const { data: market, error } = await supabase.from('markets').insert({
      lat: location.lat, lng: location.lng, name: location.name || 'Рынок',
    }).select('id,lat,lng,name').single();
    if (error) { console.error('[markets] insert error:', error.message); return; }
    if (gameState.loaded && market) gameState.upsertMarket(market);
    console.log(`[markets] Spawned "${market.name}" at ${market.lat.toFixed(4)},${market.lng.toFixed(4)}`);
  } catch (e) {
    console.error('[markets] ensureMarketNearPlayer error:', e.message);
  }
}

/**
 * Daily check: ensure every HQ cluster has a market nearby.
 */
export async function dailyMarketCheck() {
  try {
    let allHqs;
    if (gameState.loaded) allHqs = [...gameState.headquarters.values()].map(h => ({ lat: h.lat, lng: h.lng }));
    else {
      const { data } = await supabase.from('headquarters').select('lat,lng').limit(5000);
      allHqs = data || [];
    }
    if (!allHqs.length) return;

    const { data: allMarkets } = await supabase.from('markets').select('id,lat,lng,name').limit(500);
    const existingMarkets = allMarkets || [];

    const clusters = [];
    for (const hq of allHqs) {
      if (!hq.lat || !hq.lng) continue;
      const existing = clusters.find(c => haversine(hq.lat, hq.lng, c.lat, c.lng) <= MAX_DISTANCE);
      if (existing) {
        existing.count++;
        existing.lat = (existing.lat * (existing.count - 1) + hq.lat) / existing.count;
        existing.lng = (existing.lng * (existing.count - 1) + hq.lng) / existing.count;
      } else {
        clusters.push({ lat: hq.lat, lng: hq.lng, count: 1 });
      }
    }

    let spawned = 0;
    for (const cluster of clusters) {
      const hasMarket = existingMarkets.some(m => haversine(cluster.lat, cluster.lng, m.lat, m.lng) <= MAX_DISTANCE);
      if (hasMarket) continue;
      const location = await findMarketLocation(cluster.lat, cluster.lng, existingMarkets);
      if (!location) continue;
      const { data: market, error } = await supabase.from('markets').insert({
        lat: location.lat, lng: location.lng, name: location.name || 'Рынок',
      }).select('id,lat,lng,name').single();
      if (!error && market) {
        existingMarkets.push(market);
        if (gameState.loaded) gameState.upsertMarket(market);
        spawned++;
        console.log(`[markets] Daily: spawned "${market.name}"`);
      }
    }
    if (spawned > 0) console.log(`[markets] Daily check: spawned ${spawned} new markets`);
  } catch (e) {
    console.error('[markets] dailyMarketCheck error:', e.message);
  }
}
