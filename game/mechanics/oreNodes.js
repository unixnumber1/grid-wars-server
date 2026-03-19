import { supabase } from '../../lib/supabase.js';
import { gameState } from '../state/GameState.js';
import { haversine } from '../../lib/haversine.js';
import { getCellId } from '../../lib/grid.js';

export const ORE_CAPTURE_RADIUS = 200;
export const ORE_TTL_DAYS = 30;
export const ORE_MIN_DISTANCE = 200;
export const ORE_ZONE_RADIUS = 5000; // legacy — kept for imports

export function getOreIncome(level) { return level; }
export function randomOreLevel() { return Math.floor(Math.random() * 10) + 1; }
export function getOreHp(level) { return 1000 + level * 500; }

// ── City-based ore count ──
function getOreCountForCity(playerCount) {
  if (playerCount === 0) return 0;
  if (playerCount <= 5) return playerCount * 3 + Math.floor(Math.random() * 5);
  if (playerCount <= 20) return Math.floor(playerCount * 3);
  if (playerCount <= 50) return Math.floor(playerCount * 2.5);
  return Math.min(200, Math.floor(playerCount * 2));
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

  const nowISO = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ORE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let spawned = 0;

  for (let attempt = 0; attempt < toSpawn * 3 && spawned < toSpawn; attempt++) {
    const lat = minLat + Math.random() * (maxLat - minLat);
    const lng = minLng + Math.random() * (maxLng - minLng);

    // Min 200m from other ore nodes
    let tooClose = false;
    for (const ore of gameState.oreNodes.values()) {
      if (haversine(lat, lng, ore.lat, ore.lng) < ORE_MIN_DISTANCE) { tooClose = true; break; }
    }
    if (tooClose) continue;

    const level = randomOreLevel();
    const hp = getOreHp(level);
    const oreNode = {
      lat, lng, cell_id: getCellId(lat, lng),
      level, hp, max_hp: hp,
      owner_id: null, currency: 'shards',
      last_collected: nowISO, expires_at: expiresAt, created_at: nowISO,
    };

    const { data: inserted, error } = await supabase.from('ore_nodes').insert(oreNode).select().single();
    if (error) { console.error('[ORE] spawn error:', error.message); continue; }
    if (inserted) { gameState.oreNodes.set(inserted.id, inserted); spawned++; }
  }

  console.log(`[ORE] ${cityKey}: spawned ${spawned}/${toSpawn}`);
  return spawned;
}

// ── Legacy global spawn (kept for backward compat in server.js initial startup) ──
export async function spawnOreNodesGlobally() {
  console.log('[ORE] Global ore spawn — delegating to city-based system');
  // No-op: city-based spawn happens via server.js citySpawnCycle
  return 0;
}
