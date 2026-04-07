/**
 * Fast approximate distance in meters (Equirectangular projection).
 * ~10-20× faster than haversine, <0.1% error for distances up to 20km.
 * Use for mass proximity checks; use haversine for precise single checks.
 */
export function fastDistance(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * 0.017453293;
  const dLng = (lng2 - lng1) * 0.017453293;
  const cosAvg = Math.cos((lat1 + lat2) * 0.5 * 0.017453293);
  const x = dLng * cosAvg;
  return 6371000 * Math.sqrt(dLat * dLat + x * x);
}

/**
 * Calculate distance in meters between two lat/lng points
 * using the Haversine formula.
 */
export function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Offset a lat/lng point by meters in a given direction (angle in radians).
 */
export function offsetLatLng(lat, lng, meters, angle) {
  const cosLat = Math.cos(lat * Math.PI / 180);
  return {
    lat: lat + (meters / 111320) * Math.cos(angle),
    lng: lng + (meters / (111320 * cosLat)) * Math.sin(angle),
  };
}

/**
 * Find a safe drop position that doesn't overlap with markets or monuments.
 * If the given position is within MIN_DIST of any market/monument, shift it
 * to the nearest free spot.
 */
export function findSafeDropPosition(lat, lng, gameState, minDist = 25) {
  if (!gameState?.loaded) return { lat, lng };

  function isBlocked(pLat, pLng) {
    for (const m of gameState.markets.values()) {
      if (haversine(pLat, pLng, m.lat, m.lng) < minDist) return true;
    }
    for (const m of gameState.monuments.values()) {
      if (haversine(pLat, pLng, m.lat, m.lng) < minDist) return true;
    }
    return false;
  }

  if (!isBlocked(lat, lng)) return { lat, lng };

  // Try 8 directions at increasing distances
  for (let dist = minDist; dist <= minDist * 3; dist += minDist) {
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * 2 * Math.PI;
      const pos = offsetLatLng(lat, lng, dist, angle);
      if (!isBlocked(pos.lat, pos.lng)) return pos;
    }
  }
  // Fallback: offset 50m north
  return offsetLatLng(lat, lng, 50, 0);
}
