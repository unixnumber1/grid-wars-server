import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getOreTileKey, tileBounds, computeTileDeficits } from '../../lib/oreTiles.js';
import { ORE_TILE_DEG, ORE_PER_TILE_MIN, ORE_PER_TILE_MAX, ORE_PER_PLAYER } from '../../config/constants.js';

// Tests operate on an in-memory ore array — no gameState, no DB.
let _ores = [];
const oreIter = () => _ores;

describe('getOreTileKey', () => {
  it('returns same key for points within the same tile', () => {
    const a = getOreTileKey(55.7500, 37.5500);
    const b = getOreTileKey(55.7501, 37.5501);
    assert.strictEqual(a, b);
  });

  it('returns different keys for points in adjacent tiles', () => {
    const a = getOreTileKey(55.7500, 37.5500);
    const b = getOreTileKey(55.7500 + ORE_TILE_DEG + 0.001, 37.5500);
    assert.notStrictEqual(a, b);
  });

  it('handles negative longitudes without collision', () => {
    const a = getOreTileKey(55.7, -0.1);
    const b = getOreTileKey(55.7, 0.1);
    assert.notStrictEqual(a, b);
  });

  it('round-trips through tileBounds', () => {
    const lat = 55.7521, lng = 37.6173;
    const k = getOreTileKey(lat, lng);
    const [minLat, maxLat, minLng, maxLng] = tileBounds(k);
    assert(lat >= minLat && lat < maxLat, 'lat inside bounds');
    assert(lng >= minLng && lng < maxLng, 'lng inside bounds');
    // Same bounds yield same key for any point inside
    assert.strictEqual(getOreTileKey((minLat + maxLat) / 2, (minLng + maxLng) / 2), k);
  });
});

describe('computeTileDeficits', () => {
  beforeEach(() => { _ores = []; });

  it('returns empty array when no players given', () => {
    const tiles = computeTileDeficits([55.7, 55.9, 37.5, 37.7], [], oreIter());
    assert.strictEqual(tiles.length, 0);
  });

  it('empty tile with 3 players → target = 3 × ORE_PER_PLAYER, deficit = target (3 × 8 = 24, above MIN)', () => {
    const bounds = [55.7, 55.9, 37.5, 37.7];
    const players = [
      { lat: 55.7500, lng: 37.5500 },
      { lat: 55.7501, lng: 37.5501 },
      { lat: 55.7502, lng: 37.5502 },
    ];
    const tiles = computeTileDeficits(bounds, players, oreIter());
    assert.strictEqual(tiles.length, 1);
    assert.strictEqual(tiles[0].playerCount, 3);
    const expected = Math.max(ORE_PER_TILE_MIN, 3 * ORE_PER_PLAYER);
    assert.strictEqual(tiles[0].target, expected);
    assert.strictEqual(tiles[0].existing, 0);
    assert.strictEqual(tiles[0].deficit, expected);
  });

  it('applies ORE_PER_TILE_MIN floor for single-player tiles', () => {
    const bounds = [55.7, 55.9, 37.5, 37.7];
    const tiles = computeTileDeficits(bounds, [{ lat: 55.7500, lng: 37.5500 }], oreIter());
    assert.strictEqual(tiles[0].target, ORE_PER_TILE_MIN);
  });

  it('applies ORE_PER_TILE_MAX ceiling for dense tiles', () => {
    const bounds = [55.7, 55.9, 37.5, 37.7];
    const players = Array.from({ length: 100 }, () => ({ lat: 55.7500, lng: 37.5500 }));
    const tiles = computeTileDeficits(bounds, players, oreIter());
    assert.strictEqual(tiles[0].target, ORE_PER_TILE_MAX);
  });

  it('filters out tiles that already meet their target', () => {
    const bounds = [55.7, 55.9, 37.5, 37.7];
    const players = [{ lat: 55.7500, lng: 37.5500 }];
    for (let i = 0; i < ORE_PER_TILE_MIN; i++) {
      _ores.push({ lat: 55.7500 + i * 0.0001, lng: 37.5500 });
    }
    const tiles = computeTileDeficits(bounds, players, oreIter());
    assert.strictEqual(tiles.length, 0);
  });

  it('isolates tile deficits — a full center tile does not hide a starving neighbor tile', () => {
    const bounds = [55.0, 56.5, 37.0, 38.5];
    const centerPlayer = { lat: 55.7500, lng: 37.6200 };
    const northPlayer = { lat: 56.0000, lng: 37.6200 }; // > ORE_TILE_DEG north → different tile

    // Saturate the center tile
    const centerKey = getOreTileKey(centerPlayer.lat, centerPlayer.lng);
    const [cMinLat, , cMinLng] = tileBounds(centerKey);
    for (let i = 0; i < ORE_PER_TILE_MAX; i++) {
      _ores.push({ lat: cMinLat + 0.001 + (i * 0.0005), lng: cMinLng + 0.001 });
    }

    const tiles = computeTileDeficits(bounds, [centerPlayer, northPlayer], oreIter());
    assert.strictEqual(tiles.length, 1);
    const northKey = getOreTileKey(northPlayer.lat, northPlayer.lng);
    assert.strictEqual(tiles[0].tileKey, northKey);
    assert.strictEqual(tiles[0].existing, 0);
    assert.strictEqual(tiles[0].target, ORE_PER_TILE_MIN);
  });

  it('sorts tiles by deficit descending', () => {
    const bounds = [55.0, 56.5, 37.0, 38.5];
    const players = [
      { lat: 55.20, lng: 37.20 },               // tile A: 1 player
      { lat: 55.80, lng: 37.80 },               // tile B: 4 players
      { lat: 55.80, lng: 37.80 },
      { lat: 55.80, lng: 37.80 },
      { lat: 55.80, lng: 37.80 },
    ];
    const tiles = computeTileDeficits(bounds, players, oreIter());
    assert.strictEqual(tiles.length, 2);
    assert(tiles[0].deficit >= tiles[1].deficit);
    assert.strictEqual(tiles[0].playerCount, 4);
  });
});
