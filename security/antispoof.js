import { haversine } from '../lib/haversine.js';
import { suspiciousActivity } from './rateLimit.js';
import { logPlayer } from '../lib/logger.js';
import { ADMIN_TG_ID } from '../config/constants.js';

// Position history per player (in-memory)
const positionHistory = new Map(); // telegram_id -> [{ lat, lng, timestamp }]

// Max physically possible speed (km/h)
const MAX_SPEED_KMH = 120;

// Pin mode max jump (km)
const PIN_MAX_DISTANCE_KM = 20;

// Min interval between position updates (ms)
const MIN_UPDATE_INTERVAL_MS = 1000;

export function validatePosition(telegramId, lat, lng, isPinMode = false) {
  // Admin bypass — never flag admin
  if (Number(telegramId) === ADMIN_TG_ID) return { valid: true };

  // Validate coords
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return { valid: false, reason: 'invalid_coords' };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { valid: false, reason: 'out_of_bounds' };
  }
  if (lat === 0 && lng === 0) {
    return { valid: false, reason: 'null_island' };
  }

  const now = Date.now();
  const history = positionHistory.get(telegramId) || [];

  // Pin mode — only validate coords and max distance, do NOT update history
  // (so returning to GPS won't trigger speed violation from HQ position)
  if (isPinMode) {
    if (history.length > 0) {
      const last = history[history.length - 1];
      const distance = haversine(last.lat, last.lng, lat, lng);
      const distanceKm = distance / 1000;
      if (distanceKm > PIN_MAX_DISTANCE_KM) {
        return { valid: false, reason: 'pin_too_far', distance: distanceKm };
      }
    }
    return { valid: true };
  }

  if (history.length > 0) {
    const last = history[history.length - 1];
    const timeDiff = (now - last.timestamp) / 1000; // seconds
    const distance = haversine(last.lat, last.lng, lat, lng); // meters
    const distanceKm = distance / 1000;

    // Too frequent updates
    if (now - last.timestamp < MIN_UPDATE_INTERVAL_MS) {
      return { valid: false, reason: 'too_frequent' };
    }

    // Normal mode — check physical speed
    const speedKmh = (distanceKm / timeDiff) * 3600;

    if (speedKmh > MAX_SPEED_KMH && distanceKm > 0.1) {
      const violation = {
        timestamp: now,
        speed: speedKmh,
        distance: distanceKm,
        from: { lat: last.lat, lng: last.lng },
        to: { lat, lng },
      };

      recordSpoofViolation(telegramId, violation);
      return { valid: false, reason: 'impossible_speed', speed: speedKmh };
    }
  }

  // Update history (keep last 10 positions)
  history.push({ lat, lng, timestamp: now });
  if (history.length > 10) history.shift();
  positionHistory.set(telegramId, history);

  return { valid: true };
}

function recordSpoofViolation(telegramId, violation) {
  const key = `spoof:${telegramId}`;
  const record = suspiciousActivity.get(key) || {
    violations: [],
    totalViolations: 0,
    banned: false,
  };

  record.violations.push(violation);
  record.totalViolations++;

  // Keep only last 20 violations
  if (record.violations.length > 20) record.violations.shift();

  suspiciousActivity.set(key, record);

  console.log(`[ANTISPOOF] Violation #${record.totalViolations} for ${telegramId}: speed=${violation.speed.toFixed(0)}km/h, dist=${violation.distance.toFixed(2)}km`);
  logPlayer(telegramId, 'spoof', `Подозрительная скорость: ${violation.speed.toFixed(0)} км/ч`, { speed: violation.speed, distance: violation.distance, from: violation.from, to: violation.to });

  // Auto-ban after 5 confirmed violations
  if (record.totalViolations >= 5 && !record.banned) {
    autoBan(telegramId, record);
  }
}

async function autoBan(telegramId, record) {
  if (Number(telegramId) === ADMIN_TG_ID) return; // never ban admin
  try {
    const { supabase } = await import('../lib/supabase.js');

    const banUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await supabase
      .from('players')
      .update({
        is_banned: true,
        ban_reason: 'GPS \u0441\u043F\u0443\u0444\u0438\u043D\u0433 (\u0430\u0432\u0442\u043E\u0431\u0430\u043D)',
        ban_until: banUntil.toISOString(),
      })
      .eq('telegram_id', telegramId);

    // Update gameState
    const { gameState } = await import('../lib/gameState.js');
    if (gameState.loaded) {
      const p = gameState.getPlayerByTgId(telegramId);
      if (p) {
        p.is_banned = true;
        p.ban_reason = 'GPS \u0441\u043F\u0443\u0444\u0438\u043D\u0433 (\u0430\u0432\u0442\u043E\u0431\u0430\u043D)';
        p.ban_until = banUntil.toISOString();
        gameState.markDirty('players', p.id);
      }
    }

    record.banned = true;
    suspiciousActivity.set(`spoof:${telegramId}`, record);

    console.log(`[ANTISPOOF] AUTO-BAN: ${telegramId} banned for 30 days (${record.totalViolations} violations)`);
    logPlayer(telegramId, 'ban', `Автобан: GPS спуфинг (${record.totalViolations} нарушений)`, { violations: record.totalViolations, ban_until: banUntil.toISOString() });

    // Notify admin via Telegram
    notifyAdmin(telegramId, record);
  } catch (e) {
    console.error('[ANTISPOOF] autoBan error:', e.message);
  }
}

async function notifyAdmin(telegramId, record) {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const ADMIN_ID = ADMIN_TG_ID;
  if (!BOT_TOKEN) return;

  const lastViolation = record.violations[record.violations.length - 1];

  const message = `\u{1F6A8} \u0410\u0412\u0422\u041E\u0411\u0410\u041D \u2014 GPS \u0421\u041F\u0423\u0424\u0418\u041D\u0413\n\n\u{1F464} \u0418\u0433\u0440\u043E\u043A ID: ${telegramId}\n\u{1F4CD} \u041D\u0430\u0440\u0443\u0448\u0435\u043D\u0438\u0439: ${record.totalViolations}\n\u{1F680} \u041F\u043E\u0441\u043B\u0435\u0434\u043D\u044F\u044F \u0441\u043A\u043E\u0440\u043E\u0441\u0442\u044C: ${lastViolation.speed.toFixed(0)} \u043A\u043C/\u0447\n\u{1F4CF} \u0420\u0430\u0441\u0441\u0442\u043E\u044F\u043D\u0438\u0435: ${lastViolation.distance.toFixed(2)} \u043A\u043C\n\u23F0 \u0411\u0430\u043D \u043D\u0430 30 \u0434\u043D\u0435\u0439`;

  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ADMIN_ID,
        text: message,
        reply_markup: {
          inline_keyboard: [[
            { text: '\u2705 \u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044C', callback_data: `confirm_ban_${telegramId}` },
            { text: '\u274C \u0420\u0430\u0437\u0431\u0430\u043D\u0438\u0442\u044C', callback_data: `unban_${telegramId}` },
          ]],
        },
      }),
    });
  } catch (e) {
    console.error('[ANTISPOOF] notifyAdmin error:', e.message);
  }
}

export function getSpoofStats(telegramId) {
  return suspiciousActivity.get(`spoof:${telegramId}`) || null;
}

export function resetSpoofRecord(telegramId) {
  suspiciousActivity.delete(`spoof:${telegramId}`);
  positionHistory.delete(telegramId);
}

// Reset only position history (for pin/unpin transitions)
export function resetPositionHistory(telegramId) {
  positionHistory.delete(telegramId);
}
