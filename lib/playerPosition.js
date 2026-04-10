// ═══════════════════════════════════════════════════════
//  Server-authoritative player position helper
//
//  All distance-check routes MUST use this instead of trusting
//  req.body.lat/lng. Returns the player's last antispoof-validated
//  position from gameState, or null if stale / unknown.
// ═══════════════════════════════════════════════════════

import { gameState } from './gameState.js';

const DEFAULT_MAX_AGE_MS = 60000; // 60s — reject actions if position older than this

/**
 * Returns { lat, lng } of the player's last validated position, or null
 * if the position is unknown or stale (older than maxAgeMs).
 *
 * When null is returned, the caller should respond with
 *   res.status(400).json({ error: 'Обновите позицию' })
 *
 * @param {number|string} telegramId
 * @param {number} maxAgeMs — 0 = no freshness check (use sparingly)
 */
export function getVerifiedPlayerPos(telegramId, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const player = gameState.getPlayerByTgId(Number(telegramId));
  if (!player || player.last_lat == null || player.last_lng == null) return null;
  if (maxAgeMs > 0 && player.last_seen) {
    const age = Date.now() - new Date(player.last_seen).getTime();
    if (age > maxAgeMs) return null;
  }
  return { lat: player.last_lat, lng: player.last_lng };
}
