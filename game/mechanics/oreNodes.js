import { supabase } from '../../lib/supabase.js';
import { gameState } from '../state/GameState.js';
import { haversine } from '../../lib/haversine.js';
import { getCellId } from '../../lib/grid.js';
import {
  ORE_CAPTURE_RADIUS, ORE_TTL_DAYS, ORE_MIN_DISTANCE, ORE_ZONE_RADIUS,
  ORE_TYPES, MIN_ORE_PER_CITY, ORE_PER_PLAYER, MAX_ORE_PER_CITY,
  VOLCANO_ERUPTION_MAX_CHANCE, VOLCANO_ERUPTION_RAMP_DAYS,
} from '../../config/constants.js';

export { ORE_CAPTURE_RADIUS, ORE_TTL_DAYS, ORE_MIN_DISTANCE, ORE_ZONE_RADIUS };

// ── Weighted random ore type ──
const _totalWeight = Object.values(ORE_TYPES).reduce((s, t) => s + t.spawnWeight, 0);

export function randomOreType() {
  let roll = Math.random() * _totalWeight;
  for (const [key, cfg] of Object.entries(ORE_TYPES)) {
    roll -= cfg.spawnWeight;
    if (roll <= 0) return key;
  }
  return 'hill';
}

// ── Level within type range ──
export function randomOreLevel(oreType = 'hill') {
  const cfg = ORE_TYPES[oreType] || ORE_TYPES.hill;
  const [min, max] = cfg.levels;
  return min + Math.floor(Math.random() * (max - min + 1));
}

// ── HP by type ──
export function getOreHp(level, oreType = 'hill') {
  const cfg = ORE_TYPES[oreType] || ORE_TYPES.hill;
  return cfg.hpBase + level * cfg.hpPerLevel;
}

// ── Income per hour ──
export function getOreIncome(level, oreType = 'hill') {
  const cfg = ORE_TYPES[oreType] || ORE_TYPES.hill;
  return Math.floor(level * cfg.incomeMultiplier);
}

// ── Eruption chance (daily %) for volcano ──
export function getEruptionDailyChance(daysOwned) {
  if (daysOwned <= 1) return 0;
  return Math.min(VOLCANO_ERUPTION_MAX_CHANCE, (daysOwned - 1) * (VOLCANO_ERUPTION_MAX_CHANCE / VOLCANO_ERUPTION_RAMP_DAYS));
}

// Convert daily chance to per-tick chance (5 min ticks, 288 per day)
export function getEruptionTickChance(daysOwned) {
  const daily = getEruptionDailyChance(daysOwned) / 100;
  if (daily <= 0) return 0;
  return 1 - Math.pow(1 - daily, 1 / 288);
}

// ── City-based ore count ──
export function getOreCountForCity(playerCount) {
  if (playerCount === 0) return 0;
  const raw = playerCount * ORE_PER_PLAYER;
  return Math.min(MAX_ORE_PER_CITY, Math.max(MIN_ORE_PER_CITY, raw));
}

// ── Overpass spawn points cache ──
const _spawnPointsCache = new Map(); // cityKey -> { points, updatedAt }
const _spawnErrorCache = new Map(); // cityKey -> timestamp of last error
const SPAWN_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h
const ERROR_CACHE_TTL = 30 * 60 * 1000; // 30min — don't retry failed cities too often

export function clearSpawnErrorCache() {
  const size = _spawnErrorCache.size;
  _spawnErrorCache.clear();
  console.log(`[ORE] Cleared spawn error cache (${size} entries)`);
  return size;
}

export function clearSpawnPointsCache() {
  const size = _spawnPointsCache.size;
  _spawnPointsCache.clear();
  console.log(`[ORE] Cleared spawn points cache (${size} entries)`);
  return size;
}

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const TILE_SIZE_DEG = 0.045; // ~5km tile size

async function _queryOverpass(bbox) {
  const query = `
    [out:json][timeout:25];
    (
      way["highway"="residential"](${bbox});
      way["highway"="living_street"](${bbox});
      way["highway"="tertiary"](${bbox});
      way["highway"="pedestrian"](${bbox});
    );
    out center 500;
  `;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const resp = await fetch(
        `${endpoint}?data=${encodeURIComponent(query)}`,
        { signal: AbortSignal.timeout(30000) }
      );
      if (!resp.ok) {
        if (resp.status === 429) await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      const data = await resp.json();
      return (data.elements || [])
        .filter(el => (el.center?.lat && el.center?.lon) || (el.lat && el.lon))
        .map(el => ({
          lat: el.center?.lat ?? el.lat,
          lng: el.center?.lon ?? el.lon,
        }));
    } catch (_) { continue; }
  }
  return null; // all endpoints failed
}

async function fetchSpawnPoints(cityKey, bounds) {
  const cached = _spawnPointsCache.get(cityKey);
  if (cached && Date.now() - cached.updatedAt < SPAWN_CACHE_TTL) return cached.points;

  // Don't hammer Overpass if this city recently failed
  const lastError = _spawnErrorCache.get(cityKey);
  if (lastError && Date.now() - lastError < ERROR_CACHE_TTL) return null;

  const [minLat, maxLat, minLng, maxLng] = bounds;
  const spanLat = maxLat - minLat;
  const spanLng = maxLng - minLng;

  // Small area — single query
  if (spanLat <= TILE_SIZE_DEG * 2 && spanLng <= TILE_SIZE_DEG * 2) {
    const bbox = `${minLat},${minLng},${maxLat},${maxLng}`;
    const points = await _queryOverpass(bbox);
    if (!points) {
      console.error(`[ORE] Overpass failed for ${cityKey}`);
      _spawnErrorCache.set(cityKey, Date.now());
      return null;
    }
    console.log(`[ORE] Overpass ${cityKey}: ${points.length} road points`);
    _spawnPointsCache.set(cityKey, { points, updatedAt: Date.now() });
    return points;
  }

  // Large area — tile into ~5km chunks, query each
  console.log(`[ORE] ${cityKey}: large area (${(spanLat*111).toFixed(0)}x${(spanLng*111*0.6).toFixed(0)}km), tiling...`);
  const allPoints = [];
  let tiles = 0, failed = 0;

  for (let lat = minLat; lat < maxLat; lat += TILE_SIZE_DEG) {
    for (let lng = minLng; lng < maxLng; lng += TILE_SIZE_DEG) {
      const tLat2 = Math.min(lat + TILE_SIZE_DEG, maxLat);
      const tLng2 = Math.min(lng + TILE_SIZE_DEG, maxLng);
      const bbox = `${lat},${lng},${tLat2},${tLng2}`;
      tiles++;

      const points = await _queryOverpass(bbox);
      if (points) {
        allPoints.push(...points);
      } else {
        failed++;
      }

      // Pause between tiles to avoid rate limiting
      await new Promise(r => setTimeout(r, 2000));

      // Cap total points to avoid memory bloat
      if (allPoints.length >= 2000) break;
    }
    if (allPoints.length >= 2000) break;
  }

  if (allPoints.length === 0) {
    console.error(`[ORE] Overpass failed for ${cityKey}: 0/${tiles} tiles succeeded`);
    _spawnErrorCache.set(cityKey, Date.now());
    return null;
  }

  console.log(`[ORE] Overpass ${cityKey}: ${allPoints.length} road points from ${tiles - failed}/${tiles} tiles`);
  _spawnPointsCache.set(cityKey, { points: allPoints, updatedAt: Date.now() });
  return allPoints;
}

// Add random offset ±20-50m to a point (small offset to stay near roads)
function offsetPoint(lat, lng) {
  const offsetM = 20 + Math.random() * 30; // 20-50m
  const angle = Math.random() * 2 * Math.PI;
  const dLat = (offsetM * Math.cos(angle)) / 111320;
  const dLng = (offsetM * Math.sin(angle)) / (111320 * Math.cos(lat * Math.PI / 180));
  return { lat: lat + dLat, lng: lng + dLng };
}

// ── Spawn ores into a single bounding box ──
async function _spawnInBounds(cityKey, cacheKey, bounds, toSpawn) {
  const roadPoints = await fetchSpawnPoints(cacheKey, bounds);
  if (!roadPoints || roadPoints.length < 10) {
    console.log(`[ORE] ${cacheKey}: skipping — not enough road points (${roadPoints?.length ?? 0})`);
    return 0;
  }

  const nowISO = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ORE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let spawned = 0;
  const allOrePositions = [...gameState.oreNodes.values()].map(o => ({ lat: o.lat, lng: o.lng }));

  for (let attempt = 0; attempt < toSpawn * 5 && spawned < toSpawn; attempt++) {
    const pt = roadPoints[Math.floor(Math.random() * roadPoints.length)];
    const off = offsetPoint(pt.lat, pt.lng);
    const lat = off.lat;
    const lng = off.lng;

    let tooClose = false;
    for (const pos of allOrePositions) {
      if (haversine(lat, lng, pos.lat, pos.lng) < ORE_MIN_DISTANCE) { tooClose = true; break; }
    }
    if (tooClose) continue;

    const oreType = randomOreType();
    const level = randomOreLevel(oreType);
    const hp = getOreHp(level, oreType);
    const oreNode = {
      lat, lng, cell_id: getCellId(lat, lng),
      level, hp, max_hp: hp,
      ore_type: oreType,
      owner_id: null, currency: 'shards',
      last_collected: nowISO, expires_at: expiresAt, created_at: nowISO,
    };

    const { data: inserted, error } = await supabase.from('ore_nodes').insert(oreNode).select().single();
    if (error) { console.error('[ORE] spawn error:', error.message); continue; }
    if (inserted) {
      gameState.oreNodes.set(inserted.id, inserted);
      allOrePositions.push({ lat, lng });
      spawned++;
    }
  }
  return spawned;
}

// ── Spawn ore for a city (handles sub-zones for large cities) ──
export async function spawnOreNodesForCity(cityKey, bounds, playerCount, subZones) {
  const [minLat, maxLat, minLng, maxLng] = bounds;

  const existingInCity = [...gameState.oreNodes.values()].filter(o =>
    o.lat >= minLat && o.lat <= maxLat && o.lng >= minLng && o.lng <= maxLng
  );

  const targetCount = getOreCountForCity(playerCount);
  let toSpawn = targetCount - existingInCity.length;

  // If city is full but sub-zones are provided (uncovered players), spawn 10 per zone
  if (toSpawn <= 0 && subZones && subZones.length > 0) {
    toSpawn = subZones.length * 10;
    console.log(`[ORE] ${cityKey}: full but ${subZones.length} uncovered zones, spawning ${toSpawn} extra`);
  }

  if (toSpawn <= 0) return 0;

  console.log(`[ORE] ${cityKey}: need ${toSpawn} ores (players: ${playerCount}, existing: ${existingInCity.length})`);

  let totalSpawned = 0;

  // Sub-zones: spawn per player zone
  if (subZones && subZones.length > 0) {
    const perZone = Math.max(1, Math.ceil(toSpawn / subZones.length));
    for (let i = 0; i < subZones.length; i++) {
      const zone = subZones[i];
      const zoneKey = `${cityKey}_zone${i}`;
      const zoneNeed = Math.min(perZone, toSpawn - totalSpawned);
      if (zoneNeed <= 0) break;

      const spawned = await _spawnInBounds(cityKey, zoneKey, zone, zoneNeed);
      totalSpawned += spawned;
      console.log(`[ORE] ${zoneKey}: spawned ${spawned}/${zoneNeed}`);

      // Pause between zones
      if (i < subZones.length - 1) await new Promise(r => setTimeout(r, 3000));
    }
  } else {
    // Small city — single bounds
    totalSpawned = await _spawnInBounds(cityKey, cityKey, bounds, toSpawn);
  }

  console.log(`[ORE] ${cityKey}: spawned ${totalSpawned}/${toSpawn} total`);
  return totalSpawned;
}

// ── Legacy global spawn (kept for backward compat in server.js initial startup) ──
export async function spawnOreNodesGlobally() {
  console.log('[ORE] Global ore spawn — delegating to city-based system');
  // No-op: city-based spawn happens via server.js citySpawnCycle
  return 0;
}
