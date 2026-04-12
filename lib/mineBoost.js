/**
 * Mine boost computation — cell-aggregate O(N + C²) algorithm.
 * Replaces per-mine O(N²) haversine proximity check.
 */
import { fastDistance } from './haversine.js';
import { getMineCountBoost } from '../config/formulas.js';
import { MINE_BOOST_RADIUS } from '../config/constants.js';

// ~5km cells — gives ~25 cells in 20km radius
const CELL_DEG = 0.045;

/**
 * Compute boost data for all mines of a player.
 * Density boost only applies when (a) activated (paid HQ boost) AND (b) mine sits
 * within the HQ zone radius. Both gates must pass; otherwise boost = 1.
 *
 * @param {Array} mines - player mines with lat, lng, level, id
 * @param {Object|null} clanInfo - { clanHqs: [{lat,lng}], radius, defenseMul }
 * @param {Object|null} hqInfo - { lat, lng, radius } or null if player has no HQ
 * @param {boolean} boostActive - whether paid HQ boost is currently active
 */
export function computeMineBoostData(mines, clanInfo, hqInfo, boostActive) {
  const perMineBoost = new Map();
  const inClanZone = new Set();
  let clanDefMul = 1;

  if (!mines || mines.length === 0) {
    return { perMineBoost, maxBoost: 1, inClanZone, clanDefMul };
  }

  // ── Step 1: Bucket mines into spatial cells, aggregate level points ──
  const cellData = new Map(); // cellKey → { totalLevels, centerLat, centerLng }
  const mineCellKey = new Map(); // mineId → cellKey

  for (const m of mines) {
    if (m.lat == null || m.lng == null) continue;
    const cx = Math.floor(m.lat / CELL_DEG);
    const cy = Math.floor(m.lng / CELL_DEG);
    const key = cx * 100000 + cy; // numeric key for speed

    let cell = cellData.get(key);
    if (!cell) {
      cell = { totalLevels: 0, count: 0, sumLat: 0, sumLng: 0 };
      cellData.set(key, cell);
    }
    cell.totalLevels += (m.level || 1);
    cell.count++;
    cell.sumLat += m.lat;
    cell.sumLng += m.lng;
    mineCellKey.set(m.id, key);
  }

  // Compute cell centers
  for (const cell of cellData.values()) {
    cell.centerLat = cell.sumLat / cell.count;
    cell.centerLng = cell.sumLng / cell.count;
  }

  // ── Step 2: For each cell, sum level points from all cells within 20km ──
  const cellKeys = [...cellData.keys()];
  const cellBoostPoints = new Map(); // cellKey → totalPoints in radius

  for (const keyA of cellKeys) {
    const cellA = cellData.get(keyA);
    let pts = 0;

    for (const keyB of cellKeys) {
      const cellB = cellData.get(keyB);
      // Quick bounding box pre-filter (~20km in degrees)
      const dLat = Math.abs(cellA.centerLat - cellB.centerLat);
      const dLng = Math.abs(cellA.centerLng - cellB.centerLng);
      if (dLat > 0.2 || dLng > 0.35) continue; // ~22km lat, ~28km lng at mid-latitudes

      if (keyA === keyB || fastDistance(cellA.centerLat, cellA.centerLng, cellB.centerLat, cellB.centerLng) <= MINE_BOOST_RADIUS + 5000) {
        // +5km margin because cell center != mine position (cell is ~5km wide)
        pts += cellB.totalLevels;
      }
    }
    cellBoostPoints.set(keyA, pts);
  }

  // ── Step 3: Assign gated boost to each mine ──
  // Gate 1: HQ boost must be activated (paid).
  // Gate 2: mine must be inside owner's HQ zone.
  // If either gate fails, boost = 1 (no density bonus).
  let maxBoost = 1;
  for (const m of mines) {
    const key = mineCellKey.get(m.id);
    if (key == null) { perMineBoost.set(m.id, 1); continue; }
    if (!boostActive) { perMineBoost.set(m.id, 1); continue; }

    let inHqZone = false;
    if (hqInfo && m.lat != null && m.lng != null) {
      inHqZone = fastDistance(m.lat, m.lng, hqInfo.lat, hqInfo.lng) <= hqInfo.radius;
    }
    if (!inHqZone) { perMineBoost.set(m.id, 1); continue; }

    const pts = cellBoostPoints.get(key) || 0;
    const boost = getMineCountBoost(pts);
    perMineBoost.set(m.id, boost);
    if (boost > maxBoost) maxBoost = boost;
  }

  // ── Step 4: Clan zone check (if player has clan) ──
  if (clanInfo && clanInfo.clanHqs.length > 0 && clanInfo.radius > 0) {
    clanDefMul = clanInfo.defenseMul || 1;
    for (const m of mines) {
      if (m.lat == null || m.lng == null) continue;
      for (const hq of clanInfo.clanHqs) {
        if (fastDistance(m.lat, m.lng, hq.lat, hq.lng) <= clanInfo.radius) {
          inClanZone.add(m.id);
          break;
        }
      }
    }
  }

  return { perMineBoost, maxBoost, inClanZone, clanDefMul };
}
