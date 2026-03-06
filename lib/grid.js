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
 * Returns a Set of all H3 cell IDs within ~500m of the given position.
 * Used to validate mine placement, capture, upgrade, and collect interactions.
 */
export function getCellsInRange(lat, lng) {
  const center = getCell(lat, lng);
  return new Set(gridDisk(center, MINE_DISK_K));
}

/** Boundary of a cell as [[lat, lng], ...] array for polygon drawing. */
export function getCellBoundary(cellId) {
  return cellToBoundary(cellId);
}

/** Center of a cell as [lat, lng]. */
export function getCellCenter(cellId) {
  return cellToLatLng(cellId);
}
