// ── Water areas detection (shared between vases & ore nodes) ──

const _waterCache = new Map();
const WATER_CACHE_TTL = 24 * 60 * 60 * 1000;

export async function fetchWaterAreas(cityKey, bounds) {
  const cached = _waterCache.get(cityKey);
  if (cached && Date.now() - cached.updatedAt < WATER_CACHE_TTL) return cached.areas;

  const [minLat, maxLat, minLng, maxLng] = bounds;
  const bbox = `${minLat},${minLng},${maxLat},${maxLng}`;
  const query = `
    [out:json][timeout:20];
    (
      way["natural"="water"](${bbox});
      relation["natural"="water"](${bbox});
      way["waterway"="riverbank"](${bbox});
      way["waterway"="river"](${bbox});
      way["landuse"="reservoir"](${bbox});
    );
    out bb;
  `;
  try {
    const resp = await fetch(
      `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`,
      { signal: AbortSignal.timeout(20000) }
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const areas = (data.elements || [])
      .filter(el => el.bounds)
      .map(el => el.bounds);
    _waterCache.set(cityKey, { areas, updatedAt: Date.now() });
    return areas;
  } catch (e) {
    console.error(`[WATER] Query error for ${cityKey}: ${e.message}`);
    return [];
  }
}

export function isInWater(lat, lng, waterAreas) {
  const BUFFER = 0.0003; // ~30m buffer
  for (const b of waterAreas) {
    if (lat >= b.minlat - BUFFER && lat <= b.maxlat + BUFFER &&
        lng >= b.minlon - BUFFER && lng <= b.maxlon + BUFFER) return true;
  }
  return false;
}
