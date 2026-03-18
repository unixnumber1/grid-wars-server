import { supabase } from './supabase.js';
import { gameState } from './gameState.js';
import { haversine } from './haversine.js';
import { getCellId } from './grid.js';

export const ORE_CAPTURE_RADIUS = 200;
export const ORE_TTL_DAYS = 30;
export const ORE_MIN_DISTANCE = 200;
export const ORE_ZONE_RADIUS = 5000; // 5km zone for clustering

export function getOreIncome(level) { return level; }
export function randomOreLevel() { return Math.floor(Math.random() * 10) + 1; }
export function getOreHp(level) { return 1000 + level * 500; }

// How many ore nodes for a zone based on player count
function getOreCountForZone(playerCount) {
  if (playerCount === 0) return 0;
  if (playerCount === 1) return Math.floor(Math.random() * 3) + 3; // 3-5
  return Math.floor(playerCount * (2 + Math.random())); // 2-3 per player
}

// Cluster players into zones of radiusM
function clusterPlayersIntoZones(players, radiusM) {
  const zones = [];
  const assigned = new Set();

  for (const player of players) {
    const pid = player.telegram_id || player.id;
    if (assigned.has(pid)) continue;

    const nearby = players.filter(p => {
      const id = p.telegram_id || p.id;
      if (assigned.has(id)) return false;
      return haversine(player.last_lat, player.last_lng, p.last_lat, p.last_lng) <= radiusM;
    });

    const center = {
      lat: nearby.reduce((s, p) => s + p.last_lat, 0) / nearby.length,
      lng: nearby.reduce((s, p) => s + p.last_lng, 0) / nearby.length,
    };

    zones.push({ center, players: nearby });
    nearby.forEach(p => assigned.add(p.telegram_id || p.id));
  }

  return zones;
}

// Spawn a single ore node near a center point
async function spawnSingleOreNode(centerLat, centerLng, radiusM) {
  const cosLat = Math.cos(centerLat * Math.PI / 180) || 1;
  const nowISO = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ORE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  for (let attempt = 0; attempt < 15; attempt++) {
    const angle = Math.random() * 2 * Math.PI;
    const dist = radiusM * 0.2 + Math.random() * radiusM * 0.8;
    const lat = centerLat + (dist / 111320) * Math.cos(angle);
    const lng = centerLng + (dist / (111320 * cosLat)) * Math.sin(angle);

    // Check min 200m from other ore nodes
    let tooClose = false;
    for (const ore of gameState.oreNodes.values()) {
      if (haversine(lat, lng, ore.lat, ore.lng) < ORE_MIN_DISTANCE) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    const cellId = getCellId(lat, lng);

    const level = randomOreLevel();
    const hp = getOreHp(level);
    const oreNode = {
      lat, lng, cell_id: cellId,
      level, hp, max_hp: hp,
      owner_id: null, currency: 'shards',
      last_collected: nowISO,
      expires_at: expiresAt, created_at: nowISO,
    };

    const { data: inserted, error } = await supabase.from('ore_nodes').insert(oreNode).select().single();
    if (error) {
      console.error('[ore] spawn error:', error.message);
      continue;
    }
    if (inserted) {
      gameState.oreNodes.set(inserted.id, inserted);
      return inserted;
    }
  }

  return null;
}

// Global ore spawn — clusters players into zones, spawns proportionally
export async function spawnOreNodesGlobally() {
  console.log('[ORE] Global ore spawn starting...');

  // Get all players with coordinates
  const players = [...gameState.players.values()].filter(p => p.last_lat && p.last_lng);

  if (players.length === 0) {
    console.log('[ORE] No players with coordinates, skipping');
    return 0;
  }

  // Cluster players into 5km zones
  const zones = clusterPlayersIntoZones(players, ORE_ZONE_RADIUS);

  let totalSpawned = 0;

  for (const zone of zones) {
    const targetCount = getOreCountForZone(zone.players.length);

    // Count existing ore nodes in this zone
    let existing = 0;
    for (const ore of gameState.oreNodes.values()) {
      if (haversine(zone.center.lat, zone.center.lng, ore.lat, ore.lng) <= ORE_ZONE_RADIUS) {
        existing++;
      }
    }

    const toSpawn = Math.max(0, targetCount - existing);
    if (toSpawn <= 0) continue;

    for (let i = 0; i < toSpawn; i++) {
      const ore = await spawnSingleOreNode(zone.center.lat, zone.center.lng, ORE_ZONE_RADIUS);
      if (ore) totalSpawned++;
    }
  }

  console.log(`[ORE] Spawned ${totalSpawned} ore nodes across ${zones.length} zones (${players.length} players)`);
  return totalSpawned;
}
