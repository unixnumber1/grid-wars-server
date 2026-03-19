import { haversine } from './haversine.js';

// ── City cache ──
const playerCityCache = new Map();  // telegram_id → { city, country, cityKey, lat, lng, updatedAt }
const cityPlayersCache = new Map(); // cityKey → Set(telegram_id)
const cityBoundsCache = new Map();  // cityKey → { lat, lng, boundingbox, updatedAt }

// ── Reverse geocode: determine player's city via Nominatim ──
export async function getPlayerCity(telegramId, lat, lng) {
  const cached = playerCityCache.get(String(telegramId));
  if (cached && Date.now() - cached.updatedAt < 3600000) return cached;

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=10&accept-language=ru`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Overthrow Game/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();

    const city = data.address?.city || data.address?.town || data.address?.village || data.address?.county || 'unknown';
    const country = data.address?.country_code || 'unknown';
    const cityKey = `${city}_${country}`.toLowerCase().replace(/\s+/g, '_');

    const result = { city, country, cityKey, lat, lng, updatedAt: Date.now() };
    playerCityCache.set(String(telegramId), result);
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
