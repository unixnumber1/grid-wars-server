// ═══════════════════════════════════════════════════════
//  Rate Limiting by telegram_id (in-memory)
// ═══════════════════════════════════════════════════════

import { logPlayer } from './logger.js';

const requestCounts = new Map(); // key → { count, resetAt }
const suspiciousActivity = new Map(); // key → { count, lastAt }

// Cleanup every minute
setInterval(() => {
  const now = Date.now();
  for (const [id, data] of requestCounts) {
    if (now > data.resetAt) requestCounts.delete(id);
  }
}, 60000);

const LIMITS = {
  default:  { max: 120, window: 60000 },
  attack:   { max: 150, window: 60000 },
  tick:     { max: 30,  window: 60000 },
  build:    { max: 40,  window: 60000 },
  collect:  { max: 60,  window: 60000 },
  market:   { max: 60,  window: 60000 },
  location: { max: 200, window: 60000 },
};

export function rateLimitMw(type = 'default') {
  return (req, res, next) => {
    const telegramId = req.body?.telegram_id || req.query?.telegram_id;
    if (!telegramId) return next();

    const key = `${telegramId}:${type}`;
    const limit = LIMITS[type] || LIMITS.default;
    const now = Date.now();

    const current = requestCounts.get(key) || { count: 0, resetAt: now + limit.window };

    if (now > current.resetAt) {
      current.count = 0;
      current.resetAt = now + limit.window;
    }

    current.count++;
    requestCounts.set(key, current);

    if (current.count > limit.max) {
      const v = suspiciousActivity.get(String(telegramId)) || { count: 0, lastAt: 0 };
      v.count++;
      v.lastAt = now;
      suspiciousActivity.set(String(telegramId), v);

      logPlayer(telegramId, 'warn', `Rate limit превышен: ${type}`, { endpoint: type, count: v.count });
      return res.status(429).json({
        error: 'Слишком много запросов. Подождите немного.',
        retry_after: Math.ceil((current.resetAt - now) / 1000),
      });
    }

    next();
  };
}

export { suspiciousActivity };
