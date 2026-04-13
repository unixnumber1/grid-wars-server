import { readFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { supabase } from '../../lib/supabase.js';
import { gameState } from '../state/GameState.js';
import { haversine, fastDistance } from '../../lib/haversine.js';
import { getCellId } from '../../lib/grid.js';
import { fetchWaterAreas, isInWater } from '../../lib/waterAreas.js';
import { persistNow } from '../state/persist.js';
import {
  ORE_CAPTURE_RADIUS, ORE_TTL_DAYS, ORE_MIN_DISTANCE, ORE_ZONE_RADIUS,
  ORE_TYPES, MIN_ORE_PER_CITY, ORE_PER_PLAYER, MAX_ORE_PER_CITY,
  VOLCANO_PHASE_THRESHOLDS, VOLCANO_ERUPTION_BURN_RADIUS, VOLCANO_ERUPTION_OWNER_REWARD,
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

// ── Eruption phase + hourly chance — re-exported from pure helper module ──
export { getVolcanoPhase, getEruptionHourlyChance } from '../../lib/volcanoPhase.js';

// ── Trigger a volcano eruption: reset owner, burn mines in radius, notify, compensate ──
export async function triggerVolcanoEruption(ore, io, connectedPlayers) {
  const nowISO = new Date().toISOString();
  const eruptedOwnerId = ore.owner_id;
  const eruptedOwner = gameState.getPlayerById(eruptedOwnerId);

  // 1. Reset volcano ownership
  ore.owner_id = null;
  ore.hp = ore.max_hp;
  ore.captured_at = null;
  gameState.markDirty('oreNodes', ore.id);
  supabase.from('ore_nodes').update({
    owner_id: null, hp: ore.max_hp, captured_at: null,
  }).eq('id', ore.id).then(() => {}).catch(e => console.error('[eruption] ore DB error:', e.message));

  // 2. Burn all mines within VOLCANO_ERUPTION_BURN_RADIUS of the volcano
  const burnedMines = [];
  const burnedByVolcano = { telegram_id: 0, name: 'Вулкан 🌋', avatar: '🌋' };
  for (const mine of gameState.mines.values()) {
    if (mine.status === 'burning' || mine.status === 'destroyed') continue;
    if (fastDistance(ore.lat, ore.lng, mine.lat, mine.lng) > VOLCANO_ERUPTION_BURN_RADIUS) continue;

    mine.status = 'burning';
    mine.hp = 0;
    mine.burning_started_at = nowISO;
    mine.last_collected = nowISO;
    mine.coins = 0;
    mine._burned_by = burnedByVolcano;
    mine.attacker_id = null;
    mine.attack_started_at = null;
    mine.attack_ends_at = null;
    mine.last_hp_update = null;
    mine.pending_level = null;
    mine.upgrade_finish_at = null;
    gameState.markDirty('mines', mine.id);

    supabase.from('mines').update({
      status: 'burning', hp: 0, burning_started_at: nowISO,
      last_collected: nowISO, coins: 0, attacker_id: null,
      attack_started_at: null, attack_ends_at: null, last_hp_update: null,
      pending_level: null, upgrade_finish_at: null,
    }).eq('id', mine.id).then(() => {}).catch(e => console.error('[eruption] mine DB error:', e.message));

    burnedMines.push(mine);
  }

  // 3. Emit mine:hp_update for each burned mine so nearby clients see them turn red
  for (const mine of burnedMines) {
    for (const [sid, info] of connectedPlayers) {
      if (info.lat && info.lng && fastDistance(mine.lat, mine.lng, info.lat, info.lng) <= 2000) {
        io.to(sid).emit('mine:hp_update', { mine_id: mine.id, hp: 0, status: 'burning', burning_started_at: nowISO });
      }
    }
  }

  // 4. Eruption broadcast for visual effects
  for (const [sid, info] of connectedPlayers) {
    if (info.lat && info.lng && fastDistance(ore.lat, ore.lng, info.lat, info.lng) <= 2000) {
      io.to(sid).emit('volcano:erupted', {
        ore_node_id: ore.id, lat: ore.lat, lng: ore.lng, level: ore.level,
        burned_mine_ids: burnedMines.map(m => m.id),
      });
    }
  }

  // 5. Compensate volcano owner: +20💎 + push notification
  if (eruptedOwner) {
    eruptedOwner.diamonds = (eruptedOwner.diamonds || 0) + VOLCANO_ERUPTION_OWNER_REWARD;
    gameState.markDirty('players', eruptedOwner.id);
    try {
      await persistNow('players', { id: eruptedOwner.id, diamonds: eruptedOwner.diamonds });
    } catch (e) { console.error('[eruption] owner persist error:', e.message); }

    const eLang = eruptedOwner.language || 'en';
    const ownerMsg = eLang === 'ru'
      ? `💥 Ваш вулкан Ур.${ore.level} извергся! Вы получили ${VOLCANO_ERUPTION_OWNER_REWARD}💎 компенсации`
      : `💥 Your Lv.${ore.level} volcano erupted! You received ${VOLCANO_ERUPTION_OWNER_REWARD}💎 compensation`;
    const notif = {
      id: globalThis.crypto.randomUUID(),
      player_id: eruptedOwnerId,
      type: 'volcano_erupted_owner',
      message: ownerMsg,
      data: { ore_node_id: ore.id, reward: VOLCANO_ERUPTION_OWNER_REWARD },
      read: false, created_at: nowISO,
    };
    gameState.addNotification(notif);
    supabase.from('notifications').insert(notif).then(() => {}).catch(e => console.error('[eruption] notif DB error:', e.message));
  }

  // 6. Notify victims (dedupe by owner_id, excluding volcano owner)
  const burnedCountByOwner = new Map();
  for (const mine of burnedMines) {
    if (!mine.owner_id || mine.owner_id === eruptedOwnerId) continue;
    burnedCountByOwner.set(mine.owner_id, (burnedCountByOwner.get(mine.owner_id) || 0) + 1);
  }
  for (const [victimId, count] of burnedCountByOwner) {
    const victim = gameState.getPlayerById(victimId);
    if (!victim) continue;
    const vLang = victim.language || 'en';
    const victimMsg = vLang === 'ru'
      ? `🌋 Извержение вулкана Ур.${ore.level} уничтожило ${count} ваших шахт!`
      : `🌋 A Lv.${ore.level} volcano eruption destroyed ${count} of your mines!`;
    const notif = {
      id: globalThis.crypto.randomUUID(),
      player_id: victimId,
      type: 'volcano_burned_mine',
      message: victimMsg,
      data: { ore_node_id: ore.id, burned_count: count },
      read: false, created_at: nowISO,
    };
    gameState.addNotification(notif);
    supabase.from('notifications').insert(notif).then(() => {}).catch(e => console.error('[eruption] victim DB error:', e.message));
  }

  console.log(`[ORE] 🌋 ERUPTION! Lv.${ore.level} volcano — owner ${eruptedOwner?.game_username || eruptedOwnerId}, burned ${burnedMines.length} mines`);

  return { burnedCount: burnedMines.length };
}

// ── City-based ore count (legacy — kept for compatibility / stats) ──
export function getOreCountForCity(playerCount) {
  if (playerCount === 0) return 0;
  const raw = playerCount * ORE_PER_PLAYER;
  return Math.min(MAX_ORE_PER_CITY, Math.max(MIN_ORE_PER_CITY, raw));
}

// ── Tile-based spawning helpers (pure, re-exported from lib/oreTiles.js) ──
export { getOreTileKey, tileBounds, computeTileDeficits } from '../../lib/oreTiles.js';
import { computeTileDeficits as _computeTileDeficits } from '../../lib/oreTiles.js';

// ── Overpass spawn points cache (persisted to disk) ──
const _spawnPointsCache = new Map(); // cacheKey -> { points, updatedAt }
const _spawnErrorCache = new Map(); // cacheKey -> timestamp of last error
const SPAWN_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7d — road graph is stable
const ERROR_CACHE_TTL = 30 * 60 * 1000; // 30min — don't retry failed regions too often
const ROAD_CACHE_FILE = '/var/www/grid-wars-server/.ore-road-cache.json';

// Load persisted road cache on startup (runs once at module import)
try {
  const raw = readFileSync(ROAD_CACHE_FILE, 'utf8');
  const saved = JSON.parse(raw);
  if (saved && typeof saved === 'object') {
    let loaded = 0;
    for (const [k, v] of Object.entries(saved)) {
      if (v?.points && v?.updatedAt && Date.now() - v.updatedAt < SPAWN_CACHE_TTL) {
        _spawnPointsCache.set(k, v);
        loaded++;
      }
    }
    console.log(`[ORE] Loaded road cache: ${loaded} entries`);
  }
} catch (_) { /* no cache file yet */ }

let _roadPersistPending = false;
function persistRoadCache() {
  if (_roadPersistPending) return;
  _roadPersistPending = true;
  setTimeout(() => {
    _roadPersistPending = false;
    const data = Object.fromEntries(_spawnPointsCache);
    writeFile(ROAD_CACHE_FILE, JSON.stringify(data))
      .catch(e => console.error('[ORE] road cache persist error:', e.message));
  }, 10000); // 10s debounce
}

export function clearSpawnErrorCache() {
  const size = _spawnErrorCache.size;
  _spawnErrorCache.clear();
  console.log(`[ORE] Cleared spawn error cache (${size} entries)`);
  return size;
}

export function clearSpawnPointsCache() {
  const size = _spawnPointsCache.size;
  _spawnPointsCache.clear();
  persistRoadCache();
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
      way["highway"="secondary"](${bbox});
      way["highway"="unclassified"](${bbox});
      way["highway"="service"](${bbox});
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
    persistRoadCache();
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
  persistRoadCache();
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
  const useRoads = roadPoints && roadPoints.length >= 3;
  const waterAreas = await fetchWaterAreas(cityKey, bounds);

  const nowISO = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ORE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let spawned = 0;

  const [minLat, maxLat, minLng, maxLng] = bounds;

  // Only check proximity against nearby ores (tile + ORE_MIN_DISTANCE margin in degrees).
  // O(N_ores_in_region) instead of O(N_all_ores). ~0.005° ≈ 550m.
  const MARGIN = ORE_MIN_DISTANCE / 111000 + 0.001;
  const allOrePositions = [];
  for (const o of gameState.oreNodes.values()) {
    if (o.lat < minLat - MARGIN || o.lat > maxLat + MARGIN) continue;
    if (o.lng < minLng - MARGIN || o.lng > maxLng + MARGIN) continue;
    allOrePositions.push({ lat: o.lat, lng: o.lng });
  }

  for (let attempt = 0; attempt < toSpawn * 5 && spawned < toSpawn; attempt++) {
    let lat, lng;

    if (useRoads) {
      const pt = roadPoints[Math.floor(Math.random() * roadPoints.length)];
      const off = offsetPoint(pt.lat, pt.lng);
      lat = off.lat;
      lng = off.lng;
    } else {
      // Random fallback within bbox (for areas without road data)
      lat = minLat + Math.random() * (maxLat - minLat);
      lng = minLng + Math.random() * (maxLng - minLng);
    }

    let tooClose = false;
    for (const pos of allOrePositions) {
      if (haversine(lat, lng, pos.lat, pos.lng) < ORE_MIN_DISTANCE) { tooClose = true; break; }
    }
    if (tooClose) continue;
    if (waterAreas.length > 0 && isInWater(lat, lng, waterAreas)) continue;

    const oreType = randomOreType();
    const level = randomOreLevel(oreType);
    const hp = getOreHp(level, oreType);
    const oreNode = {
      lat, lng, cell_id: getCellId(lat, lng),
      level, hp, max_hp: hp,
      ore_type: oreType,
      owner_id: null, currency: (ORE_TYPES[oreType]?.dualCurrency ? 'both' : 'shards'),
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

// ── Spawn ore for a city (tile-based: independent per 5×5 km tile) ──
// Called from citySpawnCycle. Iterates tiles with biggest deficit first,
// spawning up to `budget` ores total. Tile cacheKey is stable by geography
// (cityKey + tileKey), so Overpass road points are cached persistently.
export async function spawnOreNodesForCity(cityKey, bounds, playerPositions, budget = Infinity) {
  if (!Array.isArray(playerPositions) || playerPositions.length === 0) return 0;

  const tiles = _computeTileDeficits(bounds, playerPositions, gameState.oreNodes.values());
  if (tiles.length === 0) return 0;

  const totalDeficit = tiles.reduce((s, t) => s + t.deficit, 0);
  console.log(`[ORE] ${cityKey}: ${tiles.length} tiles with deficit, total=${totalDeficit}, budget=${budget === Infinity ? '∞' : budget}`);

  let totalSpawned = 0;
  let remaining = budget;

  for (let i = 0; i < tiles.length; i++) {
    if (remaining <= 0) break;
    const tile = tiles[i];
    const need = Math.min(tile.deficit, remaining);
    const tileCacheKey = `${cityKey}_t${tile.tileKey}`;

    const spawned = await _spawnInBounds(cityKey, tileCacheKey, tile.bounds, need);
    totalSpawned += spawned;
    remaining -= spawned;
    console.log(`[ORE] ${tileCacheKey}: spawned ${spawned}/${need} (players=${tile.playerCount}, existing=${tile.existing}, target=${tile.target})`);

    // Short pause between tiles — road points usually come from persistent cache
    if (i < tiles.length - 1 && remaining > 0) {
      await new Promise(r => setTimeout(r, 800));
    }
  }

  console.log(`[ORE] ${cityKey}: spawned ${totalSpawned} ores across ${tiles.length} tiles`);
  return totalSpawned;
}

