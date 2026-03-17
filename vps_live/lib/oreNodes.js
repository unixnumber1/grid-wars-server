import { supabase } from './supabase.js';
import { gameState } from './gameState.js';
import { haversine } from './haversine.js';
import { getCellId } from './grid.js';

export const ORE_CAPTURE_RADIUS = 200;
export const ORE_TTL_DAYS = 30;
export const ORE_SPAWN_MIN = 300;
export const ORE_SPAWN_MAX = 800;
export const ORE_MIN_DISTANCE = 200;
export const ORE_PER_HQ = 2;
const ONLINE_MS = 3 * 60 * 1000;

export function getOreIncome(level) { return level; }
export function randomOreLevel() { return Math.floor(Math.random() * 10) + 1; }
export function getOreHp(level) { return 1000 + level * 500; }

export async function spawnOreNodesNearHq(lat, lng) {
  // Count existing ore nodes within 1km
  let nearbyCount = 0;
  for (const ore of gameState.oreNodes.values()) {
    if (haversine(lat, lng, ore.lat, ore.lng) <= 1000) nearbyCount++;
  }
  const needed = Math.max(0, ORE_PER_HQ - nearbyCount);
  if (needed === 0) return;

  const cosLat = Math.cos(lat * Math.PI / 180);
  const nowISO = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ORE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  for (let i = 0; i < needed; i++) {
    let oreLat, oreLng, cellId;
    let attempts = 0;
    let valid = false;

    while (!valid && attempts < 20) {
      attempts++;
      const angle = Math.random() * 2 * Math.PI;
      const distM = ORE_SPAWN_MIN + Math.random() * (ORE_SPAWN_MAX - ORE_SPAWN_MIN);
      const distLat = distM / 111000;
      const distLng = distM / (111000 * (cosLat || 1));
      oreLat = lat + Math.cos(angle) * distLat;
      oreLng = lng + Math.sin(angle) * distLng;
      cellId = getCellId(oreLat, oreLng);

      // Don't place on existing mines
      const existingMine = gameState.getMineByCellId(cellId);
      if (existingMine) continue;

      // Check min distance from other ore nodes
      let tooClose = false;
      for (const ore of gameState.oreNodes.values()) {
        if (haversine(oreLat, oreLng, ore.lat, ore.lng) < ORE_MIN_DISTANCE) {
          tooClose = true; break;
        }
      }
      if (tooClose) continue;

      valid = true;
    }

    if (!valid) continue;

    const level = randomOreLevel();
    const hp = getOreHp(level);
    const oreNode = {
      lat: oreLat, lng: oreLng, cell_id: cellId,
      level, hp, max_hp: hp,
      owner_id: null, last_collected: nowISO,
      expires_at: expiresAt, created_at: nowISO,
    };

    const { data: inserted, error } = await supabase.from('ore_nodes').insert(oreNode).select().single();
    if (error) {
      console.error('[ore] spawn error:', error.message);
      continue;
    }
    if (inserted) {
      gameState.oreNodes.set(inserted.id, inserted);
    }
  }
}
