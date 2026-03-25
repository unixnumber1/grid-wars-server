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

// ── Get city bounding box via Nominatim search ──
export async function getCityBounds(cityKey) {
  const cached = cityBoundsCache.get(cityKey);
  if (cached && Date.now() - cached.updatedAt < 86400000) return cached; // 24h cache

  try {
    const q = cityKey.replace(/_[a-z]{2}$/, '').replace(/_/g, ' ');
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&accept-language=ru`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Overthrow Game/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (!data.length) return null;

    const place = data[0];
    const result = {
      lat: parseFloat(place.lat),
      lng: parseFloat(place.lon),
      boundingbox: place.boundingbox.map(parseFloat), // [minLat, maxLat, minLng, maxLng]
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

export { playerCityCache, cityPlayersCache, cityBoundsCache };
