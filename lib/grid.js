import { latLngToCell, gridDisk, cellToBoundary, cellToLatLng } from 'h3-js';

// Resolution 11: edge ~25m, hex diameter ~50m, exactly matching gameplay design
const H3_RESOLUTION = 11;
// gridDisk(12) at res 11: ~12 * 43m center-to-center = ~516m (≈ 500m interaction range)
const MINE_DISK_K = 12;

/** Get H3 cell ID for coordinates. */
export function getCell(lat, lng) {
  return latLngToCell(lat, lng, H3_RESOLUTION);
}

/** Alias kept for backward-compat (headquarters.js, etc). */
export function getCellId(lat, lng) {
  return getCell(lat, lng);
}

/**
 * Returns a Set of all H3 cell IDs within range of the given position.
 * @param {number} diskK - number of H3 hops (default MINE_DISK_K ≈ 500m)
 */
export function getCellsInRange(lat, lng, diskK = MINE_DISK_K) {
  const center = getCell(lat, lng);
  return new Set(gridDisk(center, diskK));
}

/**
 * Convert a metre radius to H3 disk-K value at resolution 11
 * (center-to-center distance ≈ 43m per hop).
 */
export function radiusToDiskK(meters) {
  return Math.ceil(meters / 43);
}

/** Boundary of a cell as [[lat, lng], ...] array for polygon drawing. */
export function getCellBoundary(cellId) {
  return cellToBoundary(cellId);
}

/** Center of a cell as [lat, lng]. */
export function getCellCenter(cellId) {
  return cellToLatLng(cellId);
}
