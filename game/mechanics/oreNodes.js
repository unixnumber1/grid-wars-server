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
const SPAWN_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

async function fetchSpawnPoints(cityKey, bounds) {
  const cached = _spawnPointsCache.get(cityKey);
  if (cached && Date.now() - cached.updatedAt < SPAWN_CACHE_TTL) return cached.points;

  const [minLat, maxLat, minLng, maxLng] = bounds;
  const bbox = `${minLat},${minLng},${maxLat},${maxLng}`;

  const query = `
    [out:json][timeout:25];
    (
      way["highway"="residential"](${bbox});
      way["highway"="living_street"](${bbox});
      way["highway"="service"](${bbox});
      way["highway"="footway"](${bbox});
      way["highway"="pedestrian"](${bbox});
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

    console.log(`[ORE] Overpass ${cityKey}: ${points.length} road points`);
    _spawnPointsCache.set(cityKey, { points, updatedAt: Date.now() });
    return points;
  } catch (e) {
    console.error(`[ORE] Overpass error for ${cityKey}: ${e.message}`);
    return null; // fallback to random
  }
}

// Add random offset ±50-150m to a point
function offsetPoint(lat, lng) {
  const offsetM = 50 + Math.random() * 100; // 50-150m
  const angle = Math.random() * 2 * Math.PI;
  const dLat = (offsetM * Math.cos(angle)) / 111320;
  const dLng = (offsetM * Math.sin(angle)) / (111320 * Math.cos(lat * Math.PI / 180));
  return { lat: lat + dLat, lng: lng + dLng };
}

// ── Spawn ore for a city by bounding box ──
export async function spawnOreNodesForCity(cityKey, bounds, playerCount) {
  const [minLat, maxLat, minLng, maxLng] = bounds;

  const existingInCity = [...gameState.oreNodes.values()].filter(o =>
    o.lat >= minLat && o.lat <= maxLat && o.lng >= minLng && o.lng <= maxLng
  );

  const targetCount = getOreCountForCity(playerCount);
  const toSpawn = targetCount - existingInCity.length;
  if (toSpawn <= 0) return 0;

  console.log(`[ORE] ${cityKey}: spawning ${toSpawn} ores (players: ${playerCount}, existing: ${existingInCity.length})`);

  // Try Overpass for valid spawn points
  const roadPoints = await fetchSpawnPoints(cityKey, bounds);
  const useOverpass = roadPoints && roadPoints.length >= 10;

  const nowISO = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ORE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let spawned = 0;

  // Collect all existing ore positions for distance check
  const allOrePositions = [...gameState.oreNodes.values()].map(o => ({ lat: o.lat, lng: o.lng }));

  for (let attempt = 0; attempt < toSpawn * 5 && spawned < toSpawn; attempt++) {
    let lat, lng;

    if (useOverpass) {
      // Pick random road point + offset
      const pt = roadPoints[Math.floor(Math.random() * roadPoints.length)];
      const off = offsetPoint(pt.lat, pt.lng);
      lat = off.lat;
      lng = off.lng;
    } else {
      // Fallback: random within city bounds
      lat = minLat + Math.random() * (maxLat - minLat);
      lng = minLng + Math.random() * (maxLng - minLng);
    }

    // Check min distance from all ore nodes
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

  console.log(`[ORE] ${cityKey}: spawned ${spawned}/${toSpawn}${useOverpass ? ' (Overpass)' : ' (random fallback)'}`);
  return spawned;
}

// ── Legacy global spawn (kept for backward compat in server.js initial startup) ──
export async function spawnOreNodesGlobally() {
  console.log('[ORE] Global ore spawn — delegating to city-based system');
  // No-op: city-based spawn happens via server.js citySpawnCycle
  return 0;
}
