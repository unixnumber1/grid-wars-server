/**
 * Pure tile helpers for ore spawning. No gameState / no DB / no network imports
 * so tests can load this module without bringing in `pg` etc.
 *
 * 5×5 km tiles — matches lib/mineBoost.js CELL_DEG pattern.
 */
import {
  ORE_TILE_DEG, ORE_PER_TILE_MIN, ORE_PER_TILE_MAX, ORE_PER_PLAYER,
} from '../config/constants.js';

// cy is offset by TILE_CY_OFFSET so the numeric key stays non-negative for
// longitudes down to -ORE_TILE_DEG * TILE_CY_OFFSET ≈ -2250°.
const TILE_CY_OFFSET = 50000;

export function getOreTileKey(lat, lng) {
  const cx = Math.floor(lat / ORE_TILE_DEG);
  const cy = Math.floor(lng / ORE_TILE_DEG) + TILE_CY_OFFSET;
  return cx * 100000 + cy;
}

export function tileBounds(tileKey) {
  const cx = Math.floor(tileKey / 100000);
  const cy = (tileKey - cx * 100000) - TILE_CY_OFFSET;
  const minLat = cx * ORE_TILE_DEG;
  const minLng = cy * ORE_TILE_DEG;
  return [minLat, minLat + ORE_TILE_DEG, minLng, minLng + ORE_TILE_DEG];
}

/**
 * Split a bbox + player positions + existing ores into per-tile deficits.
 * Returns tiles sorted by deficit desc (biggest shortage first).
 *
 * @param {number[]} bounds [minLat, maxLat, minLng, maxLng]
 * @param {Array<{lat:number,lng:number}>} playerPositions
 * @param {Iterable<{lat:number,lng:number}>} oreIterable e.g. gameState.oreNodes.values()
 */
export function computeTileDeficits(bounds, playerPositions, oreIterable) {
  const [minLat, maxLat, minLng, maxLng] = bounds;
  const playersPerTile = new Map();
  const oresPerTile = new Map();

  for (const p of playerPositions) {
    if (p?.lat == null || p?.lng == null) continue;
    const k = getOreTileKey(p.lat, p.lng);
    playersPerTile.set(k, (playersPerTile.get(k) || 0) + 1);
  }

  for (const o of oreIterable) {
    if (o.lat < minLat || o.lat > maxLat || o.lng < minLng || o.lng > maxLng) continue;
    const k = getOreTileKey(o.lat, o.lng);
    oresPerTile.set(k, (oresPerTile.get(k) || 0) + 1);
  }

  const tiles = [];
  for (const [k, pc] of playersPerTile) {
    const target = Math.min(ORE_PER_TILE_MAX, Math.max(ORE_PER_TILE_MIN, pc * ORE_PER_PLAYER));
    const existing = oresPerTile.get(k) || 0;
    const deficit = target - existing;
    if (deficit > 0) {
      tiles.push({ tileKey: k, bounds: tileBounds(k), deficit, target, existing, playerCount: pc });
    }
  }
  tiles.sort((a, b) => b.deficit - a.deficit);
  return tiles;
}
