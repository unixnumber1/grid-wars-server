// ═══════════════════════════════════════════════════════
//  Rate Limiting by telegram_id (in-memory)
// ═══════════════════════════════════════════════════════

import { logPlayer } from '../lib/logger.js';
import { isAdmin as isAdminId } from '../config/constants.js';

const requestCounts = new Map();      // key (tgId:type) → { count, resetAt, stickyUntil }
const suspiciousActivity = new Map(); // tgId → { count, lastAt, escalations, lastEscalationAt, autoBanned }

// Cleanup every minute
setInterval(() => {
  const now = Date.now();
  for (const [id, data] of requestCounts) {
    // Don't delete entries that are in sticky-block window
    if (now > data.resetAt && (!data.stickyUntil || now > data.stickyUntil)) {
      requestCounts.delete(id);
    }
  }
}, 60000);

const LIMITS = {
  default:  { max: 312, window: 60000 },
  attack:   { max: 180, window: 60000 },
  tick:     { max: 78,  window: 60000 },
  build:    { max: 208, window: 60000 },
  collect:  { max: 156, window: 60000 },
  market:   { max: 156, window: 60000 },
  location: { max: 520, window: 60000 },
};

// Escalation thresholds
const STICKY_MULTIPLIER = 3;          // count > max*3 within window → sticky block
const STICKY_BLOCK_MS   = 5 * 60_000; // 5 minutes hard block on sticky trigger
const AUTOBAN_ESCALATIONS = 5;        // after 5 sticky escalations → 1h ban
const AUTOBAN_DURATION_MS = 60 * 60_000;
const ESCALATION_DECAY_MS = 30 * 60_000; // forget escalations older than 30min

export function rateLimitMw(type = 'default') {
  return (req, res, next) => {
    // Use verified telegram_id from auth middleware, fall back to body/query
    const telegramId = req.verifiedTgId || req.body?.telegram_id || req.query?.telegram_id;
    if (!telegramId) return next();
    // Only skip rate limit for verified admin (not spoofed)
    if (isAdminId(telegramId) && req.authVerified) return next();

    const key = `${telegramId}:${type}`;
    const limit = LIMITS[type] || LIMITS.default;
    const now = Date.now();

    const current = requestCounts.get(key) || { count: 0, resetAt: now + limit.window, stickyUntil: 0 };

    // Sticky block: hard reject without resetting counter
    if (current.stickyUntil && now < current.stickyUntil) {
      requestCounts.set(key, current);
      return res.status(429).json({
        error: 'Слишком много запросов. Подождите.',
        retry_after: Math.max(0, current.stickyUntil - now), // milliseconds
      });
    }

    if (now > current.resetAt) {
      current.count = 0;
      current.resetAt = now + limit.window;
      current.stickyUntil = 0;
    }

    current.count++;
    requestCounts.set(key, current);

    if (current.count > limit.max) {
      const v = suspiciousActivity.get(String(telegramId)) || {
        count: 0, lastAt: 0, escalations: 0, lastEscalationAt: 0, autoBanned: false,
      };
      v.count++;
      v.lastAt = now;

      // Decay old escalations
      if (v.lastEscalationAt && now - v.lastEscalationAt > ESCALATION_DECAY_MS) {
        v.escalations = 0;
      }

      // Sticky escalation: clearly abusive flood
      if (current.count > limit.max * STICKY_MULTIPLIER && !current.stickyUntil) {
        current.stickyUntil = now + STICKY_BLOCK_MS;
        v.escalations++;
        v.lastEscalationAt = now;
        requestCounts.set(key, current);

        logPlayer(telegramId, 'warn', `Sticky block: ${type} ${req.method} ${req.path}`, {
          endpoint: type, path: req.path, count: current.count,
          escalations: v.escalations, blocked_for_sec: STICKY_BLOCK_MS / 1000,
        });

        // After several sticky escalations → temporary auto-ban
        if (v.escalations >= AUTOBAN_ESCALATIONS && !v.autoBanned) {
          v.autoBanned = true;
          autoBanForFlood(telegramId, type, v.escalations).catch(() => {});
        }
      } else {
        logPlayer(telegramId, 'warn', `Rate limit превышен: ${type} ${req.method} ${req.path}`, {
          endpoint: type, path: req.path, count: current.count, total: v.count,
        });
      }

      suspiciousActivity.set(String(telegramId), v);
      return res.status(429).json({
        error: 'Слишком много запросов. Подождите немного.',
        retry_after: Math.max(0, current.resetAt - now), // milliseconds
      });
    }

    next();
  };
}

// ── Auto-ban for sustained flooding ──
async function autoBanForFlood(telegramId, type, escalations) {
  if (isAdminId(telegramId)) return;
  try {
    const { supabase } = await import('../lib/supabase.js');
    const banUntil = new Date(Date.now() + AUTOBAN_DURATION_MS);
    const reason = `Автобан: флуд API (${type}, ${escalations} эскалаций)`;

    await supabase.from('players').update({
      is_banned: true,
      ban_reason: reason,
      ban_until: banUntil.toISOString(),
    }).eq('telegram_id', telegramId);

    const { gameState } = await import('../lib/gameState.js');
    if (gameState?.loaded) {
      const p = gameState.getPlayerByTgId(telegramId);
      if (p) {
        p.is_banned = true;
        p.ban_reason = reason;
        p.ban_until = banUntil.toISOString();
        gameState.markDirty('players', p.id);
      }
    }

    console.log(`[RATELIMIT] AUTO-BAN flood: ${telegramId} type=${type} escalations=${escalations}`);
    logPlayer(telegramId, 'ban', reason, { type, escalations, ban_until: banUntil.toISOString() });
  } catch (e) {
    console.error('[RATELIMIT] autoBanForFlood error:', e.message);
  }
}

export { suspiciousActivity };
