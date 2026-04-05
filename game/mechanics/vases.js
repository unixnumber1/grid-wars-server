import { supabase } from '../../lib/supabase.js';
import { gameState } from '../state/GameState.js';
import { haversine } from '../../lib/haversine.js';
import { VASE_MIN_DISTANCE } from '../../config/constants.js';

// ── City-based vase count ──
function getVaseCountForCity(playerCount) {
  return Math.floor(playerCount * 8);
}

// ── Overpass road points cache (shared idea with oreNodes) ──
const _vaseSpawnCache = new Map(); // cityKey -> { points, updatedAt }
const _vaseErrorCache = new Map(); // cityKey -> timestamp of last error
const VASE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h
const VASE_ERROR_TTL = 30 * 60 * 1000; // 30min

async function fetchVaseSpawnPoints(cityKey, bounds) {
  const cached = _vaseSpawnCache.get(cityKey);
  if (cached && Date.now() - cached.updatedAt < VASE_CACHE_TTL) return cached.points;

  const lastError = _vaseErrorCache.get(cityKey);
  if (lastError && Date.now() - lastError < VASE_ERROR_TTL) return null;

  const [minLat, maxLat, minLng, maxLng] = bounds;
  const bbox = `${minLat},${minLng},${maxLat},${maxLng}`;

  // Roads inside urban areas only
  const query = `
    [out:json][timeout:30];
    (
      way["highway"="residential"](${bbox});
      way["highway"="living_street"](${bbox});
      way["highway"="tertiary"](${bbox});
      way["highway"="pedestrian"](${bbox});
      way["highway"="secondary"](${bbox});
      way["highway"="unclassified"](${bbox});
      way["highway"="service"](${bbox});
    );
    out center 500;
  `;

  try {
    const resp = await fetch(
      `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`,
      { signal: AbortSignal.timeout(30000) }
    );
    if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status}`);
    const data = await resp.json();

    const points = (data.elements || [])
      .filter(el => (el.center?.lat && el.center?.lon) || (el.lat && el.lon))
      .map(el => ({
        lat: el.center?.lat ?? el.lat,
        lng: el.center?.lon ?? el.lon,
      }));

    console.log(`[VASES] Overpass ${cityKey}: ${points.length} road points`);
    _vaseSpawnCache.set(cityKey, { points, updatedAt: Date.now() });
    return points;
  } catch (e) {
    console.error(`[VASES] Overpass error for ${cityKey}: ${e.message}`);
    _vaseErrorCache.set(cityKey, Date.now());
    return null;
  }
}

// ── Water areas cache (prevent vases on rivers/lakes) ──
const _waterCache = new Map();
const WATER_CACHE_TTL = 24 * 60 * 60 * 1000;

async function fetchWaterAreas(cityKey, bounds) {
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
    console.error(`[VASES] Water query error for ${cityKey}: ${e.message}`);
    return [];
  }
}

function isInWater(lat, lng, waterAreas) {
  const BUFFER = 0.0003; // ~30m buffer
  for (const b of waterAreas) {
    if (lat >= b.minlat - BUFFER && lat <= b.maxlat + BUFFER &&
        lng >= b.minlon - BUFFER && lng <= b.maxlon + BUFFER) return true;
  }
  return false;
}

// Small random offset from road point
function offsetPoint(lat, lng) {
  const offsetM = 10 + Math.random() * 40; // 10-50m
  const angle = Math.random() * 2 * Math.PI;
  const dLat = (offsetM * Math.cos(angle)) / 111320;
  const dLng = (offsetM * Math.sin(angle)) / (111320 * Math.cos(lat * Math.PI / 180));
  return { lat: lat + dLat, lng: lng + dLng };
}

// ── Spawn vases for a city by bounding box ──
export async function spawnVasesForCity(cityKey, bounds, playerCount) {
  const [minLat, maxLat, minLng, maxLng] = bounds;

  const existingInCity = [...gameState.vases.values()].filter(v =>
    v.lat >= minLat && v.lat <= maxLat && v.lng >= minLng && v.lng <= maxLng &&
    !v.broken_by && new Date(v.expires_at) > new Date()
  );

  const targetCount = getVaseCountForCity(playerCount);
  const toSpawn = targetCount - existingInCity.length;
  if (toSpawn <= 0) return 0;

  console.log(`[VASES] ${cityKey}: spawning ${toSpawn} vases (players: ${playerCount}, existing: ${existingInCity.length})`);

  // Try to use road points for better placement
  const roadPoints = await fetchVaseSpawnPoints(cityKey, bounds);
  const useRoads = roadPoints && roadPoints.length >= 3;
  const waterAreas = await fetchWaterAreas(cityKey, bounds);

  // Collect existing positions for distance check
  const allPositions = existingInCity.map(v => ({ lat: v.lat, lng: v.lng }));

  const batch = [];
  for (let attempt = 0; attempt < toSpawn * 3 && batch.length < toSpawn; attempt++) {
    let lat, lng;

    if (useRoads) {
      const pt = roadPoints[Math.floor(Math.random() * roadPoints.length)];
      const off = offsetPoint(pt.lat, pt.lng);
      lat = off.lat;
      lng = off.lng;
    } else {
      // Fallback: random in bbox (vases are less critical than ores)
      lat = minLat + Math.random() * (maxLat - minLat);
      lng = minLng + Math.random() * (maxLng - minLng);
    }

    // Min distance check
    let tooClose = false;
    for (const pos of allPositions) {
      if (haversine(lat, lng, pos.lat, pos.lng) < VASE_MIN_DISTANCE) { tooClose = true; break; }
    }
    if (tooClose) continue;
    if (waterAreas.length > 0 && isInWater(lat, lng, waterAreas)) continue;

    allPositions.push({ lat, lng });
    batch.push({
      lat, lng,
      diamonds_reward: Math.floor(Math.random() * 5) + 1,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  }

  if (batch.length > 0) {
    for (let i = 0; i < batch.length; i += 200) {
      const chunk = batch.slice(i, i + 200);
      const { data: inserted, error } = await supabase.from('vases').insert(chunk).select('*');
      if (error) { console.error('[VASES] insert error:', error.message); continue; }
      for (const v of (inserted || [])) gameState.addVase(v);
    }
  }

  console.log(`[VASES] ${cityKey}: spawned ${batch.length}${useRoads ? ' (roads)' : ' (random fallback)'}`);
  return batch.length;
}

