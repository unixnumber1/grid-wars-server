/**
 * Compute a unique cell ID from lat/lng coordinates.
 * Each cell covers approximately 100x100 meters.
 * (1 degree of latitude ≈ 111,000 m → 0.001° ≈ 111 m)
 */
export function getCellId(lat, lng) {
  return `${Math.floor(lat * 1000)}_${Math.floor(lng * 1000)}`;
}
