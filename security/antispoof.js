import { haversine } from '../lib/haversine.js';
import { suspiciousActivity } from './rateLimit.js';
import { logPlayer } from '../lib/logger.js';
import { ADMIN_NOTIFY_ID, ANTISPOOF, isAdmin } from '../config/constants.js';
import { playerCityCache } from '../lib/geocity.js';

// ═══════════════════════════════════════════════════════
//  GPS Anti-Spoof v4 — GPS fingerprint + cosmic speed only
//
//  Principles:
//  1. Detect FAKE GPS SOFTWARE by missing altitude/speed/heading
//  2. Only ban for absolutely impossible speeds (>500 km/h)
//  3. Never ban for driving, GPS glitches, or jamming
//  4. Bad accuracy → silently reject update, no penalty
// ═══════════════════════════════════════════════════════

const {
  PIN_MAX_DISTANCE_KM, PIN_GRACE_MS,
  MIN_UPDATE_INTERVAL_MS, POSITION_HISTORY_SIZE, SESSION_GAP_MS,
  TELEPORT_SPEED_KMH, TELEPORT_MAX_TIME_S,
  HIGH_SPEED_KMH, HIGH_SPEED_MAX_TIME_S,
  BAD_ACCURACY_THRESHOLD,
  FINGERPRINT_MIN_UPDATES, FINGERPRINT_NULL_RATIO, FINGERPRINT_MIN_MOVEMENT_M,
  VIOLATION_THRESHOLD, BAN_DAYS,
} = ANTISPOOF;

// ── Per-player state ──
const positionHistory = new Map();  // telegram_id → [{ lat, lng, timestamp, ...gpsData }]
const gpsFingerprint = new Map();   // telegram_id → { nullCount, totalMoving, lastViolationAt }
const pinModeState = new Map();     // telegram_id → { active, graceUntil }
const playerHqPositions = new Map(); // telegram_id → { lat, lng } — cached HQ position for PIN detection

// ── PIN mode ──

export function setPinMode(telegramId, active) {
  const now = Date.now();
  if (active) {
    pinModeState.set(telegramId, { active: true, graceUntil: now + PIN_GRACE_MS });
    positionHistory.delete(telegramId);
  } else {
    pinModeState.set(telegramId, { active: false, graceUntil: now + PIN_GRACE_MS });
    positionHistory.delete(telegramId);
  }
}

function isPinModeActive(telegramId) {
  const state = pinModeState.get(telegramId);
  if (!state) return false;
  if (state.active) return true;
  if (Date.now() < state.graceUntil) return true;
  return false;
}

// ── HQ position cache (for PIN jump detection) ──
export function setPlayerHq(telegramId, lat, lng) {
  if (lat != null && lng != null) playerHqPositions.set(telegramId, { lat, lng });
  else playerHqPositions.delete(telegramId);
}

function isLikelyPinJump(telegramId, fromLat, fromLng, toLat, toLng) {
  const hq = playerHqPositions.get(telegramId);
  if (!hq) return false;
  // Jump TO HQ (activating PIN) or FROM HQ (deactivating PIN)
  const distToHq = haversine(toLat, toLng, hq.lat, hq.lng);
  const distFromHq = haversine(fromLat, fromLng, hq.lat, hq.lng);
  return distToHq < 500 || distFromHq < 500; // within 500m of HQ
}

// ════════════════════════════════════════════════════════
//  Main validation
// ════════════════════════════════════════════════════════

export function validatePosition(telegramId, lat, lng, isPinMode = false, gpsData = {}) {
  if (isAdmin(telegramId)) return { valid: true };

  // Validate coords
  if (typeof lat !== 'number' || typeof lng !== 'number') return { valid: false, reason: 'invalid_coords' };
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return { valid: false, reason: 'out_of_bounds' };
  if (lat === 0 && lng === 0) return { valid: false, reason: 'null_island' };

  const now = Date.now();
  const accuracy = gpsData.accuracy ?? null;

  // PIN mode — distance check only
  if (isPinMode || isPinModeActive(telegramId)) {
    const history = positionHistory.get(telegramId) || [];
    if (history.length > 0) {
      const last = history[history.length - 1];
      const distanceKm = haversine(last.lat, last.lng, lat, lng) / 1000;
      if (distanceKm > PIN_MAX_DISTANCE_KM) {
        return { valid: false, reason: 'pin_too_far', distance: distanceKm };
      }
    }
    return { valid: true };
  }

  // Bad accuracy — silently reject, no violation, no history pollution
  if (accuracy !== null && accuracy > BAD_ACCURACY_THRESHOLD) {
    return { valid: false, reason: 'bad_accuracy' };
  }

  const history = positionHistory.get(telegramId) || [];

  if (history.length > 0) {
    const last = history[history.length - 1];
    const timeDiffMs = now - last.timestamp;
    const timeDiffS = timeDiffMs / 1000;

    // Too frequent
    if (timeDiffMs < MIN_UPDATE_INTERVAL_MS) {
      return { valid: false, reason: 'too_frequent' };
    }

    const distance = haversine(last.lat, last.lng, lat, lng);
    const distanceKm = distance / 1000;
    const speedKmh = timeDiffS > 0 ? (distanceKm / timeDiffS) * 3600 : 0;

    // ── Session gap (>60s) — reset history, accept without speed check ──
    if (timeDiffMs > SESSION_GAP_MS) {
      history.length = 0;
      history.push({ lat, lng, timestamp: now, ...gpsData });
      positionHistory.set(telegramId, history);
      return { valid: true };
    }

    // ── Speed checks — only cosmic violations ──
    // Skip if this looks like a PIN jump (to/from HQ)
    const pinJump = isLikelyPinJump(telegramId, last.lat, last.lng, lat, lng);
    if (pinJump) {
      // PIN jump — reset history and accept silently
      history.length = 0;
      history.push({ lat, lng, timestamp: now, ...gpsData });
      positionHistory.set(telegramId, history);
      return { valid: true };
    }

    // Teleport: >500 km/h within 60s
    if (speedKmh > TELEPORT_SPEED_KMH && timeDiffS <= TELEPORT_MAX_TIME_S && distanceKm > 5) {
      recordViolation(telegramId, {
        timestamp: now, speed: speedKmh, distance: distanceKm,
        from: { lat: last.lat, lng: last.lng }, to: { lat, lng },
        type: 'teleport',
      });
      history.length = 0;
      history.push({ lat, lng, timestamp: now, ...gpsData });
      positionHistory.set(telegramId, history);
      return { valid: false, reason: 'teleport', speed: speedKmh };
    }

    // High speed: >300 km/h within 30s
    if (speedKmh > HIGH_SPEED_KMH && timeDiffS <= HIGH_SPEED_MAX_TIME_S && distanceKm > 2) {
      recordViolation(telegramId, {
        timestamp: now, speed: speedKmh, distance: distanceKm,
        from: { lat: last.lat, lng: last.lng }, to: { lat, lng },
        type: 'speed',
      });
      history.length = 0;
      history.push({ lat, lng, timestamp: now, ...gpsData });
      positionHistory.set(telegramId, history);
      return { valid: false, reason: 'high_speed', speed: speedKmh };
    }

    // ── GPS Fingerprint check (fake GPS software detection) ──
    // Real GPS provides altitude, speed, heading when moving.
    // Spoof software almost always sends null for these fields.
    if (distance >= FINGERPRINT_MIN_MOVEMENT_M) {
      const fp = gpsFingerprint.get(telegramId) || { nullCount: 0, totalMoving: 0, lastViolationAt: 0 };
      fp.totalMoving++;

      const altitude = gpsData.altitude ?? null;
      const gpsSpeed = gpsData.gpsSpeed ?? null;
      const heading = gpsData.heading ?? null;

      // All three null while moving = likely fake GPS
      if (altitude === null && gpsSpeed === null && heading === null) {
        fp.nullCount++;
      }

      // Check threshold: enough samples AND high null ratio
      if (fp.totalMoving >= FINGERPRINT_MIN_UPDATES) {
        const nullRatio = fp.nullCount / fp.totalMoving;
        if (nullRatio >= FINGERPRINT_NULL_RATIO && now - fp.lastViolationAt > 300000) {
          // Record violation at most once per 5 minutes
          fp.lastViolationAt = now;
          recordViolation(telegramId, {
            timestamp: now, speed: speedKmh, distance: distanceKm,
            from: { lat: last.lat, lng: last.lng }, to: { lat, lng },
            type: 'fake_gps', nullRatio: nullRatio.toFixed(2),
            nullCount: fp.nullCount, totalMoving: fp.totalMoving,
          });
        }
      }

      gpsFingerprint.set(telegramId, fp);
    }
  }

  // Update history
  history.push({ lat, lng, timestamp: now, ...gpsData });
  if (history.length > POSITION_HISTORY_SIZE) history.shift();
  positionHistory.set(telegramId, history);

  return { valid: true };
}

// ── Violation Recording ──
// All violation types contribute to auto-ban score.
// teleport (>500km/h) = 2 pts, speed (>300km/h) = 1 pt, fake_gps = 4 pts.
// Threshold = 15 → teleport: ~8 bans, speed: ~15 bans, fake_gps: ~4 bans.
const TYPE_WEIGHT = { teleport: 2, fake_gps: 4, speed: 1 };

function recordViolation(telegramId, violation) {
  const key = `spoof:${telegramId}`;
  const record = suspiciousActivity.get(key) || {
    violations: [],
    totalViolations: 0,
    weightedScore: 0,
    banned: false,
  };

  record.violations.push(violation);
  record.totalViolations++;

  // Recalculate weighted score with time decay
  const now = Date.now();
  const ONE_DAY = 86400000;
  let weightedScore = 0;
  for (const v of record.violations) {
    const age = now - v.timestamp;
    const tw = TYPE_WEIGHT[v.type] || 1;
    if (age < ONE_DAY) weightedScore += tw;
    else if (age < 7 * ONE_DAY) weightedScore += tw * 0.5;
    else weightedScore += tw * 0.2;
  }
  record.weightedScore = weightedScore;

  if (record.violations.length > 50) record.violations.shift();
  suspiciousActivity.set(key, record);

  const typeLabels = { teleport: '🚀 Телепорт', speed: '⚡ Скорость', fake_gps: '📡 Фейк GPS' };
  const label = typeLabels[violation.type] || violation.type;
  console.log(`[ANTISPOOF] ${label} #${record.totalViolations} for ${telegramId}: speed=${violation.speed?.toFixed(0) || 0}km/h, dist=${violation.distance?.toFixed(2) || 0}km, weighted=${weightedScore.toFixed(1)}`);
  logPlayer(telegramId, 'spoof', `${label}: ${violation.speed?.toFixed(0) || 0} км/ч`, {
    speed: violation.speed, distance: violation.distance, type: violation.type,
    from: violation.from, to: violation.to,
    nullRatio: violation.nullRatio, nullCount: violation.nullCount,
  });

  if (record.weightedScore >= VIOLATION_THRESHOLD && !record.banned) {
    autoBan(telegramId, record);
  } else if (violation.type === 'teleport' || violation.type === 'speed') {
    // Speed violations: notify admin for manual review, no auto-ban
    notifyAdminWarning(telegramId, violation);
  }
}

// ── Auto-Ban ──
async function autoBan(telegramId, record) {
  if (isAdmin(telegramId)) return;
  try {
    const { supabase } = await import('../lib/supabase.js');
    const banUntil = new Date(Date.now() + BAN_DAYS * 24 * 60 * 60 * 1000);

    await supabase.from('players').update({
      is_banned: true,
      ban_reason: 'GPS спуфинг (автобан v4)',
      ban_until: banUntil.toISOString(),
    }).eq('telegram_id', telegramId);

    const { gameState } = await import('../lib/gameState.js');
    if (gameState.loaded) {
      const p = gameState.getPlayerByTgId(telegramId);
      if (p) {
        p.is_banned = true;
        p.ban_reason = 'GPS спуфинг (автобан v4)';
        p.ban_until = banUntil.toISOString();
        gameState.markDirty('players', p.id);
      }
    }

    record.banned = true;
    suspiciousActivity.set(`spoof:${telegramId}`, record);

    console.log(`[ANTISPOOF] AUTO-BAN: ${telegramId} (weighted=${record.weightedScore.toFixed(1)}, total=${record.totalViolations})`);
    logPlayer(telegramId, 'ban', `Автобан v4: GPS спуфинг (score ${record.weightedScore.toFixed(1)})`, {
      violations: record.totalViolations, ban_until: banUntil.toISOString(),
    });

    notifyAdmin(telegramId, record);
  } catch (e) {
    console.error('[ANTISPOOF] autoBan error:', e.message);
  }
}

async function getPlayerInfo(telegramId) {
  try {
    const { gameState } = await import('../lib/gameState.js');
    if (!gameState?.loaded) return null;
    return gameState.getPlayerByTgId(telegramId) || gameState.getPlayerByTgId(String(telegramId));
  } catch { return null; }
}

async function notifyAdmin(telegramId, record) {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) return;

  const player = await getPlayerInfo(telegramId);
  const name = player?.game_username || '???';
  const tgTag = player?.username ? `@${player.username}` : '—';
  const city = playerCityCache.get(String(telegramId))?.city || '?';

  const lastV = record.violations[record.violations.length - 1];
  const typeLabels = { teleport: '🚀 Телепорт', speed: '⚡ Скорость', fake_gps: '📡 Фейк GPS' };
  const label = typeLabels[lastV?.type] || lastV?.type || '?';

  let message = `🚨 АВТОБАН v4 — GPS\n\n👤 ${name} (${tgTag})\n🆔 ${telegramId}\n🏙 ${city}\n📊 Score: ${record.weightedScore.toFixed(1)}/${VIOLATION_THRESHOLD}\n📌 Нарушений: ${record.totalViolations}\n${label}: ${lastV?.speed?.toFixed(0) || '?'} км/ч\n📏 ${lastV?.distance?.toFixed(2) || '?'} км`;
  if (lastV?.type === 'fake_gps') {
    message += `\n📡 Null ratio: ${lastV.nullRatio} (${lastV.nullCount}/${lastV.totalMoving})`;
  }
  message += `\n⏰ Бан ${BAN_DAYS} дней`;

  // Use violation coordinates for the "view" button (where the spoof happened)
  const vLat = lastV?.to?.lat || player?.last_lat;
  const vLng = lastV?.to?.lng || player?.last_lng;
  const keyboard = [[
    { text: '✅ Подтвердить', callback_data: `confirm_ban_${telegramId}` },
    { text: '❌ Разбанить', callback_data: `unban_${telegramId}` },
  ]];
  if (vLat && vLng) {
    keyboard.push([{ text: '👁 Посмотреть', web_app: { url: `https://overthrow.ru:8443?fly_to=${vLat},${vLng}` } }]);
  }

  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ADMIN_NOTIFY_ID,
        text: message,
        reply_markup: { inline_keyboard: keyboard },
      }),
    });
  } catch (e) {
    console.error('[ANTISPOOF] notifyAdmin error:', e.message);
  }
}

async function notifyAdminWarning(telegramId, violation) {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) return;

  const player = await getPlayerInfo(telegramId);
  const name = player?.game_username || '???';
  const tgTag = player?.username ? `@${player.username}` : '—';
  const city = playerCityCache.get(String(telegramId))?.city || '?';

  const typeLabels = { teleport: '🚀 Телепорт', speed: '⚡ Скорость' };
  const label = typeLabels[violation.type] || violation.type;
  const message = `⚠️ GPS Подозрение (не бан)\n\n👤 ${name} (${tgTag})\n🆔 ${telegramId}\n🏙 ${city}\n${label}: ${violation.speed?.toFixed(0) || '?'} км/ч\n📏 ${violation.distance?.toFixed(2) || '?'} км`;

  // Use violation coordinates for the "view" button
  const vLat = violation.to?.lat || player?.last_lat;
  const vLng = violation.to?.lng || player?.last_lng;
  const reply_markup = (vLat && vLng) ? {
    inline_keyboard: [[{ text: '👁 Посмотреть', web_app: { url: `https://overthrow.ru:8443?fly_to=${vLat},${vLng}` } }]],
  } : undefined;

  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_NOTIFY_ID, text: message, ...(reply_markup && { reply_markup }) }),
    });
  } catch (_) {}
}

// ── Public API ──

export function getSpoofStats(telegramId) {
  return suspiciousActivity.get(`spoof:${telegramId}`) || null;
}

export function resetSpoofRecord(telegramId) {
  suspiciousActivity.delete(`spoof:${telegramId}`);
  positionHistory.delete(telegramId);
  gpsFingerprint.delete(telegramId);
  pinModeState.delete(telegramId);
  playerHqPositions.delete(telegramId);
}

export function resetPositionHistory(telegramId) {
  positionHistory.delete(telegramId);
}

export function seedPositionFromDB(telegramId, lastLat, lastLng, lastSeen) {
  if (!lastLat || !lastLng || !lastSeen) return;
  const existing = positionHistory.get(telegramId);
  if (existing && existing.length > 0) return;
  const ts = new Date(lastSeen).getTime();
  if (isNaN(ts)) return;
  positionHistory.set(telegramId, [{ lat: lastLat, lng: lastLng, timestamp: ts, accuracy: null }]);
}
