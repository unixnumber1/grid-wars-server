// ═══════════════════════════════════════════════════════
//  Player Logger — per-player event logs (in-memory)
// ═══════════════════════════════════════════════════════

const playerLogs = new Map(); // telegram_id → [log entries]
const MAX_LOGS_PER_PLAYER = 200;

/**
 * Log an event for a specific player
 * @param {number} telegramId
 * @param {'action'|'error'|'ban'|'spoof'|'fraud'|'login'|'warn'} level
 * @param {string} message
 * @param {object|null} data — extra context (coords, amounts, etc.)
 */
export function logPlayer(telegramId, level, message, data = null) {
  if (!telegramId) return;
  const id = Number(telegramId);
  const entry = {
    id: Date.now(),
    time: new Date().toLocaleTimeString('ru'),
    date: new Date().toLocaleDateString('ru'),
    level,
    message,
    data,
  };

  const logs = playerLogs.get(id) || [];
  logs.unshift(entry);
  if (logs.length > MAX_LOGS_PER_PLAYER) logs.pop();
  playerLogs.set(id, logs);
}

export function getPlayerLogs(telegramId, filter = null) {
  const logs = playerLogs.get(Number(telegramId)) || [];
  if (!filter || filter === 'all') return logs;
  return logs.filter(l => l.level === filter);
}

export { playerLogs };
