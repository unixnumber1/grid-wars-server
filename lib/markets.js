import { supabase } from './supabase.js';
import { haversine } from './haversine.js';

const MAX_MARKET_DISTANCE = 5000; // 5km
const MIN_MARKET_SPACING = 500;   // 500m between markets

/**
 * Find road intersections using Overpass API
 */
async function findRoadIntersections(lat, lng, radius = 3000) {
  const query = `[out:json][timeout:10];(way["highway"~"^(primary|secondary|trunk|motorway)$"](around:${radius},${lat},${lng}););out geom;`;
  try {
    const resp = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();

    // Count how many roads pass through each node (rounded to ~11m grid)
    const nodeCount = new Map();
    for (const way of (data.elements || [])) {
      if (!way.geometry) continue;
      for (const node of way.geometry) {
        const key = `${node.lat.toFixed(4)},${node.lon.toFixed(4)}`;
        nodeCount.set(key, (nodeCount.get(key) || 0) + 1);
      }
    }

    // Intersections = nodes where 2+ roads meet
    const intersections = [];
    for (const [key, count] of nodeCount) {
      if (count >= 2) {
        const [ilat, ilng] = key.split(',').map(Number);
        intersections.push({ lat: ilat, lng: ilng });
      }
    }

    // Sort by distance to player
    intersections.sort((a, b) =>
      haversine(lat, lng, a.lat, a.lng) - haversine(lat, lng, b.lat, b.lng)
    );

    return intersections;
  } catch (e) {
    console.log('[markets] Overpass error:', e.message);
    return [];
  }
}

/**
 * Generate a random point 1-3km from player (fallback when Overpass fails)
 */
function getRandomNearbyPoint(lat, lng) {
  const angle = Math.random() * 2 * Math.PI;
  const distKm = 1 + Math.random() * 2; // 1-3 km
  return {
    lat: lat + Math.cos(angle) * distKm / 111,
    lng: lng + Math.sin(angle) * distKm / (111 * Math.cos(lat * Math.PI / 180)),
  };
}

/**
 * Spawn a market near a player location using road intersections
 */
async function spawnMarketNearPlayer(lat, lng) {
  const intersections = await findRoadIntersections(lat, lng, 3000);

  let point = null;

  if (intersections.length > 0) {
    // Get existing markets to avoid placing too close
    const { data: existingMarkets } = await supabase
      .from('markets').select('lat, lng');

    for (const inter of intersections) {
      const tooClose = (existingMarkets || []).some(m =>
        haversine(inter.lat, inter.lng, m.lat, m.lng) < MIN_MARKET_SPACING
      );
      if (!tooClose) {
        point = inter;
        break;
      }
    }

    // All intersections occupied — take first one anyway
    if (!point) point = intersections[0];
  }

  // Fallback: random point 1-3km away
  if (!point) {
    point = getRandomNearbyPoint(lat, lng);
  }

  // Insert market
  const { data: market, error } = await supabase
    .from('markets')
    .insert({ lat: point.lat, lng: point.lng, name: 'Рынок' })
    .select()
    .single();

  if (error) {
    console.error('[markets] insert error:', error.message);
    return null;
  }

  console.log('[markets] spawned market at', point.lat.toFixed(4), point.lng.toFixed(4));
  return market;
}

/**
 * Ensure a market exists within 5km of a player.
 * Called during player init. Fire-and-forget safe.
 */
export async function ensureMarketNearPlayer(lat, lng) {
  if (lat == null || lng == null) return;

  try {
    const { data: markets } = await supabase
      .from('markets').select('id, lat, lng');

    if (!markets || markets.length === 0) {
      await spawnMarketNearPlayer(lat, lng);
      return;
    }

    // Find nearest market
    let minDist = Infinity;
    for (const m of markets) {
      const dist = haversine(lat, lng, m.lat, m.lng);
      if (dist < minDist) minDist = dist;
    }

    // If further than 5km — create one
    if (minDist > MAX_MARKET_DISTANCE) {
      await spawnMarketNearPlayer(lat, lng);
    }
  } catch (e) {
    console.error('[markets] ensureMarketNearPlayer error:', e.message);
  }
}
