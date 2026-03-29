import { haversine } from './haversine.js';
import { readFileSync, writeFileSync } from 'fs';

const CACHE_FILE = '/var/www/grid-wars-server/.geocity-cache.json';

// ── City cache ──
const playerCityCache = new Map();  // telegram_id → { city, country, cityKey, lat, lng, updatedAt }
const cityPlayersCache = new Map(); // cityKey → Set(telegram_id)
const cityBoundsCache = new Map();  // cityKey → { lat, lng, boundingbox, updatedAt }

// Load persistent cache on startup
try {
  const raw = readFileSync(CACHE_FILE, 'utf8');
  const saved = JSON.parse(raw);
  if (saved.players) for (const [k, v] of Object.entries(saved.players)) playerCityCache.set(k, v);
  if (saved.bounds) for (const [k, v] of Object.entries(saved.bounds)) cityBoundsCache.set(k, v);
  console.log(`[GEOCITY] Loaded cache: ${playerCityCache.size} players, ${cityBoundsCache.size} bounds`);
} catch (_) { /* no cache file yet */ }

function persistCache() {
  try {
    const data = {
      players: Object.fromEntries(playerCityCache),
      bounds: Object.fromEntries(cityBoundsCache),
    };
    writeFileSync(CACHE_FILE, JSON.stringify(data));
  } catch (_) {}
}

// ── Reverse geocode: determine player's city via Nominatim ──
export async function getPlayerCity(telegramId, lat, lng) {
  const cached = playerCityCache.get(String(telegramId));
  if (cached && Date.now() - cached.updatedAt < 3600000) return cached;

  // Check if another player nearby is already cached — avoid Nominatim call
  for (const [, p] of playerCityCache) {
    if (p.cityKey && haversine(lat, lng, p.lat, p.lng) < 15000) {
      const result = { city: p.city, country: p.country, cityKey: p.cityKey, lat, lng, updatedAt: Date.now() };
      playerCityCache.set(String(telegramId), result);
      return result;
    }
  }

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=10&accept-language=ru`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Overthrow Game/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const city = data.address?.city || data.address?.town || data.address?.village || data.address?.county || 'unknown';
    const country = data.address?.country_code || 'unknown';
    const cityKey = `${city}_${country}`.toLowerCase().replace(/\s+/g, '_');

    const result = { city, country, cityKey, lat, lng, updatedAt: Date.now() };
    playerCityCache.set(String(telegramId), result);
    persistCache();
    return result;
  } catch (err) {
    console.error('[GEOCITY] reverse geocode error:', err.message);
    return null;
  }
}

// ── Get city bounding box ──
// Builds bbox from player positions in the city + padding (~5km)
// Falls back to Nominatim search only if no players have coordinates
export async function getCityBounds(cityKey) {
  const cached = cityBoundsCache.get(cityKey);
  if (cached && Date.now() - cached.updatedAt < 86400000) return cached; // 24h cache

  // Primary: build bbox from player positions in this city
  const playersInCity = cityPlayersCache.get(cityKey);
  if (playersInCity && playersInCity.size > 0) {
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    let hasCoords = false;
    for (const tgId of playersInCity) {
      const p = playerCityCache.get(tgId);
      if (!p?.lat || !p?.lng) continue;
      hasCoords = true;
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }
    if (hasCoords) {
      const PAD = 0.018; // ~2km padding
      const MIN_HALF_LAT = 0.036; // ~4km — minimum city half-span
      const MIN_HALF_LNG = 0.054; // ~4km at ~55° latitude
      const centerLat = (minLat + maxLat) / 2;
      const centerLng = (minLng + maxLng) / 2;

      // Ensure bbox covers at least ~8x8 km even with 1 player
      const halfLat = Math.max((maxLat - minLat) / 2 + PAD, MIN_HALF_LAT);
      const halfLng = Math.max((maxLng - minLng) / 2 + PAD, MIN_HALF_LNG);
      const bbMinLat = centerLat - halfLat;
      const bbMaxLat = centerLat + halfLat;
      const bbMinLng = centerLng - halfLng;
      const bbMaxLng = centerLng + halfLng;

      // Always build per-player sub-zones to guarantee coverage near each player
      const subZones = [];
      for (const tgId of playersInCity) {
        const pp = playerCityCache.get(tgId);
        if (!pp?.lat || !pp?.lng) continue;
        const alreadyCovered = subZones.some(z =>
          haversine(pp.lat, pp.lng, (z[0]+z[1])/2, (z[2]+z[3])/2) < 4000
        );
        if (alreadyCovered) continue;
        subZones.push([pp.lat - MIN_HALF_LAT, pp.lat + MIN_HALF_LAT, pp.lng - MIN_HALF_LNG, pp.lng + MIN_HALF_LNG]);
      }

      const result = {
        lat: centerLat, lng: centerLng,
        boundingbox: [bbMinLat, bbMaxLat, bbMinLng, bbMaxLng],
        subZones: subZones.length > 1 ? subZones : undefined,
        updatedAt: Date.now(),
      };
      cityBoundsCache.set(cityKey, result);
      persistCache();
      return result;
    }
  }

  // Fallback: Nominatim reverse geocode from a known player position (more accurate than name search)
  try {
    // Find any player in this city to get representative coordinates
    let fallbackLat = null, fallbackLng = null;
    const fallbackPlayers = cityPlayersCache.get(cityKey);
    if (fallbackPlayers) {
      for (const tgId of fallbackPlayers) {
        const pp = playerCityCache.get(tgId);
        if (pp?.lat && pp?.lng) { fallbackLat = pp.lat; fallbackLng = pp.lng; break; }
      }
    }

    let url;
    if (fallbackLat && fallbackLng) {
      // Use reverse geocode with actual player coordinates — avoids name ambiguity
      url = `https://nominatim.openstreetmap.org/reverse?lat=${fallbackLat}&lon=${fallbackLng}&format=json&zoom=8&accept-language=ru`;
    } else {
      const q = cityKey.replace(/_[a-z]{2}$/, '').replace(/_/g, ' ');
      url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&accept-language=ru`;
    }
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Overthrow Game/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    // Handle both search (array) and reverse (object) responses
    const place = Array.isArray(data) ? data[0] : data;
    if (!place?.lat || !place?.boundingbox) return null;

    const result = {
      lat: parseFloat(place.lat),
      lng: parseFloat(place.lon),
      boundingbox: place.boundingbox.map(parseFloat),
      updatedAt: Date.now(),
    };
    cityBoundsCache.set(cityKey, result);
    persistCache();
    return result;
  } catch (err) {
    console.error('[GEOCITY] search error:', err.message);
    return null;
  }
}

// ── Update player city on connect/move ──
export async function updatePlayerCity(telegramId, lat, lng) {
  const cityData = await getPlayerCity(telegramId, lat, lng);
  if (!cityData) return null;

  // Remove from old city set
  for (const [, players] of cityPlayersCache) {
    players.delete(String(telegramId));
  }

  // Add to new city set
  if (!cityPlayersCache.has(cityData.cityKey)) {
    cityPlayersCache.set(cityData.cityKey, new Set());
  }
  cityPlayersCache.get(cityData.cityKey).add(String(telegramId));

  return cityData;
}

// ── Get all known city keys ──
export function getAllCityKeys() {
  return [...cityPlayersCache.keys()].filter(k => {
    const s = cityPlayersCache.get(k);
    return s && s.size > 0;
  });
}

// ── Get player count for city ──
export function getCityPlayerCount(cityKey) {
  return cityPlayersCache.get(cityKey)?.size || 0;
}

export function clearCityBoundsCache() {
  const size = cityBoundsCache.size;
  cityBoundsCache.clear();
  console.log(`[GEOCITY] Cleared bounds cache (${size} entries)`);
  return size;
}

export { playerCityCache, cityPlayersCache, cityBoundsCache };
