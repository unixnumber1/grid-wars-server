/**
 * Push an event to a specific player by telegram_id.
 */
export function pushToPlayer(io, connectedPlayers, telegram_id, event, data) {
  for (const [socketId, player] of connectedPlayers) {
    if (String(player.telegram_id) === String(telegram_id)) {
      io.to(socketId).emit(event, data);
      break;
    }
  }
}

/**
 * Push an event to all members of a clan.
 */
export function pushToClan(io, connectedPlayers, clanMemberTelegramIds, event, data) {
  const idSet = new Set(clanMemberTelegramIds.map(String));
  for (const [socketId, player] of connectedPlayers) {
    if (idSet.has(String(player.telegram_id))) {
      io.to(socketId).emit(event, data);
    }
  }
}

/**
 * Broadcast an event to all players within a radius (meters) of a point.
 */
export function pushToNearby(io, connectedPlayers, lat, lng, radiusM, event, data) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;

  for (const [socketId, player] of connectedPlayers) {
    if (player.lat == null || player.lng == null) continue;
    const dLat = toRad(player.lat - lat);
    const dLng = toRad(player.lng - lng);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat)) * Math.cos(toRad(player.lat)) * Math.sin(dLng / 2) ** 2;
    const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    if (dist <= radiusM) {
      io.to(socketId).emit(event, data);
    }
  }
}
