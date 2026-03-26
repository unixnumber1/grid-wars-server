import { haversine } from '../lib/haversine.js';
import { suspiciousActivity } from './rateLimit.js';
import { logPlayer } from '../lib/logger.js';
import { ADMIN_TG_ID } from '../config/constants.js';

// ═══════════════════════════════════════════════════════
//  GPS Anti-Spoof v2 — designed for Russian GPS jamming reality
// ═══════════════════════════════════════════════════════

// Position history per player (in-memory)
const positionHistory = new Map(); // telegram_id -> [{ lat, lng, timestamp, accuracy }]

// ── Thresholds ──
const MAX_SPEED_KMH = 200;             // raised for GPS jamming jumps
const PIN_MAX_DISTANCE_KM = 20;
const MIN_UPDATE_INTERVAL_MS = 1000;
const POSITION_HISTORY_SIZE = 20;       // increased for pattern analysis
const VIOLATION_THRESHOLD = 15;         // raised — GPS jamming causes many false positives
const BAN_DAYS = 30;

// ── Jamming detection ──
// GPS jammers cause massive random jumps. Real spoofing is smooth.
// If accuracy is terrible (>500m) or jump is huge but random — it's likely jamming, not cheating.
const JAMMING_ACCURACY_THRESHOLD = 300; // meters — positions with accuracy > this are likely jammed
const JAMMING_JUMP_KM = 5;             // jumps > 5km in <5sec are almost certainly jamming, not spoof
const JAMMING_COOLDOWN_MS = 30000;      // suppress violations for 30s after jamming detection

// ── Joystick detection ──
// Virtual joysticks move at realistic speeds but have telltale patterns:
// 1. Perfectly constant speed (no acceleration/deceleration)
// 2. Perfectly straight lines (no GPS jitter)
// 3. Very low accuracy values (spoofed GPS reports perfect accuracy)
// 4. Movement at exact same speed for long periods
const JITTER_THRESHOLD = 2;            // meters — real GPS always jitters at least this much
const CONST_SPEED_WINDOW = 8;          // check last N positions for constant speed
const CONST_SPEED_TOLERANCE = 0.05;    // 5% speed variation = suspicious (real GPS varies 15%+)
const SUSPICIOUS_ACCURACY = 5;         // meters — real GPS rarely reports <5m accuracy consistently
const JOYSTICK_SCORE_THRESHOLD = 60;   // accumulated joystick score to flag

// Per-player joystick suspicion tracking
const joystickScores = new Map(); // telegram_id -> { score, lastDecay, jammingUntil }

export function validatePosition(telegramId, lat, lng, isPinMode = false, accuracy = null) {
  // Admin bypass
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
  const jScore = joystickScores.get(telegramId) || { score: 0, lastDecay: now, jammingUntil: 0 };

  // Time-decay joystick score: -5 points per minute
  const decayMinutes = (now - jScore.lastDecay) / 60000;
  if (decayMinutes >= 1) {
    jScore.score = Math.max(0, jScore.score - Math.floor(decayMinutes * 5));
    jScore.lastDecay = now;
  }

  // PIN mode — only validate coords + distance, don't update history
  if (isPinMode) {
    if (history.length > 0) {
      const last = history[history.length - 1];
      const distanceKm = haversine(last.lat, last.lng, lat, lng) / 1000;
      if (distanceKm > PIN_MAX_DISTANCE_KM) {
        return { valid: false, reason: 'pin_too_far', distance: distanceKm };
      }
    }
    return { valid: true };
  }

  if (history.length > 0) {
    const last = history[history.length - 1];
    const timeDiff = (now - last.timestamp) / 1000;
    const distance = haversine(last.lat, last.lng, lat, lng);
    const distanceKm = distance / 1000;

    // Too frequent
    if (now - last.timestamp < MIN_UPDATE_INTERVAL_MS) {
      return { valid: false, reason: 'too_frequent' };
    }

    const speedKmh = timeDiff > 0 ? (distanceKm / timeDiff) * 3600 : 0;

    // ── GPS Jamming Detection ──
    // Huge random jump with bad accuracy = jamming, not spoofing
    const isLikelyJamming = (
      (accuracy !== null && accuracy > JAMMING_ACCURACY_THRESHOLD) ||
      (distanceKm > JAMMING_JUMP_KM && timeDiff < 5)
    );

    if (isLikelyJamming) {
      // Don't update position (wait for GPS to stabilize)
      jScore.jammingUntil = now + JAMMING_COOLDOWN_MS;
      joystickScores.set(telegramId, jScore);
      return { valid: false, reason: 'gps_jamming', speed: speedKmh };
    }

    // During jamming cooldown — accept positions but don't flag
    if (now < jScore.jammingUntil) {
      // Still in cooldown — accept position but skip speed check
      history.push({ lat, lng, timestamp: now, accuracy });
      if (history.length > POSITION_HISTORY_SIZE) history.shift();
      positionHistory.set(telegramId, history);
      return { valid: true };
    }

    // ── Speed Check ──
    if (speedKmh > MAX_SPEED_KMH && distanceKm > 0.1) {
      recordSpoofViolation(telegramId, {
        timestamp: now, speed: speedKmh, distance: distanceKm,
        from: { lat: last.lat, lng: last.lng }, to: { lat, lng },
        type: 'speed',
      });
      return { valid: false, reason: 'impossible_speed', speed: speedKmh };
    }

    // ── Joystick Pattern Detection ──
    if (history.length >= 3) {
      let scoreIncrease = 0;

      // Check 1: No jitter (positions too smooth)
      // Real GPS always has micro-jitter. Spoofed GPS is perfectly smooth.
      if (distance > 10 && distance < 5000) {
        const prevDistance = history.length >= 2
          ? haversine(history[history.length - 2].lat, history[history.length - 2].lng, last.lat, last.lng)
          : 0;
        // If both segments are > 10m but the lateral jitter is < 2m, suspicious
        if (prevDistance > 10) {
          const bearing1 = getBearing(history[history.length - 2], last);
          const bearing2 = getBearing(last, { lat, lng });
          const bearingDiff = Math.abs(bearing1 - bearing2);
          const normalizedDiff = bearingDiff > 180 ? 360 - bearingDiff : bearingDiff;
          // Perfectly straight movement (bearing change < 1 degree) over multiple segments
          if (normalizedDiff < 1 && distance > 20) {
            scoreIncrease += 3; // very suspicious
          }
        }
      }

      // Check 2: Constant speed (joystick moves at fixed speed)
      if (history.length >= CONST_SPEED_WINDOW) {
        const speeds = [];
        for (let i = history.length - CONST_SPEED_WINDOW; i < history.length; i++) {
          const prev = history[i - 1] || history[0];
          const curr = history[i];
          const dt = (curr.timestamp - prev.timestamp) / 1000;
          if (dt > 0) {
            const d = haversine(prev.lat, prev.lng, curr.lat, curr.lng);
            speeds.push((d / dt) * 3.6); // km/h
          }
        }
        if (speeds.length >= 4) {
          const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
          if (avgSpeed > 3) { // only check if actually moving (> walking)
            const maxDeviation = Math.max(...speeds.map(s => Math.abs(s - avgSpeed) / avgSpeed));
            if (maxDeviation < CONST_SPEED_TOLERANCE) {
              scoreIncrease += 5; // very suspicious — constant speed
            }
          }
        }
      }

      // Check 3: Suspiciously perfect accuracy
      if (accuracy !== null && accuracy < SUSPICIOUS_ACCURACY) {
        // Count how many recent positions had perfect accuracy
        const recentPerfect = history.slice(-5).filter(h => h.accuracy !== null && h.accuracy < SUSPICIOUS_ACCURACY).length;
        if (recentPerfect >= 4) {
          scoreIncrease += 2;
        }
      }

      if (scoreIncrease > 0) {
        jScore.score += scoreIncrease;
        joystickScores.set(telegramId, jScore);

        if (jScore.score >= JOYSTICK_SCORE_THRESHOLD) {
          recordSpoofViolation(telegramId, {
            timestamp: now, speed: speedKmh, distance: distanceKm,
            from: { lat: last.lat, lng: last.lng }, to: { lat, lng },
            type: 'joystick', joystickScore: jScore.score,
          });
          jScore.score = Math.floor(jScore.score * 0.5); // reduce but don't reset
        }
      }
    }
  }

  // Update history
  history.push({ lat, lng, timestamp: now, accuracy });
  if (history.length > POSITION_HISTORY_SIZE) history.shift();
  positionHistory.set(telegramId, history);
  joystickScores.set(telegramId, jScore);

  return { valid: true };
}

// ── Bearing calculation (degrees 0-360) ──
function getBearing(from, to) {
  const dLng = (to.lng - from.lng) * Math.PI / 180;
  const lat1 = from.lat * Math.PI / 180;
  const lat2 = to.lat * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

// ── Violation Recording (with time-decay) ──
function recordSpoofViolation(telegramId, violation) {
  const key = `spoof:${telegramId}`;
  const record = suspiciousActivity.get(key) || {
    violations: [],
    totalViolations: 0,
    weightedScore: 0,
    banned: false,
  };

  record.violations.push(violation);
  record.totalViolations++;

  // Weighted score: recent violations count more
  // Violations older than 7 days count as 0.3, older than 1 day as 0.7
  const now = Date.now();
  const ONE_DAY = 86400000;
  let weightedScore = 0;
  for (const v of record.violations) {
    const age = now - v.timestamp;
    if (age < ONE_DAY) weightedScore += 1;
    else if (age < 7 * ONE_DAY) weightedScore += 0.7;
    else weightedScore += 0.3;
  }
  record.weightedScore = weightedScore;

  if (record.violations.length > 30) record.violations.shift();
  suspiciousActivity.set(key, record);

  const typeLabel = violation.type === 'joystick' ? 'Джойстик' : 'Скорость';
  console.log(`[ANTISPOOF] ${typeLabel} violation #${record.totalViolations} for ${telegramId}: speed=${violation.speed?.toFixed(0) || 0}km/h, dist=${violation.distance?.toFixed(2) || 0}km, weighted=${weightedScore.toFixed(1)}`);
  logPlayer(telegramId, 'spoof', `${typeLabel}: ${violation.speed?.toFixed(0) || 0} км/ч`, {
    speed: violation.speed, distance: violation.distance, type: violation.type,
    joystickScore: violation.joystickScore, from: violation.from, to: violation.to,
  });

  // Auto-ban based on weighted score (accounts for time-decay)
  if (record.weightedScore >= VIOLATION_THRESHOLD && !record.banned) {
    autoBan(telegramId, record);
  }
}

async function autoBan(telegramId, record) {
  if (Number(telegramId) === ADMIN_TG_ID) return;
  try {
    const { supabase } = await import('../lib/supabase.js');
    const banUntil = new Date(Date.now() + BAN_DAYS * 24 * 60 * 60 * 1000);

    await supabase.from('players').update({
      is_banned: true,
      ban_reason: 'GPS спуфинг (автобан)',
      ban_until: banUntil.toISOString(),
    }).eq('telegram_id', telegramId);

    const { gameState } = await import('../lib/gameState.js');
    if (gameState.loaded) {
      const p = gameState.getPlayerByTgId(telegramId);
      if (p) {
        p.is_banned = true;
        p.ban_reason = 'GPS спуфинг (автобан)';
        p.ban_until = banUntil.toISOString();
        gameState.markDirty('players', p.id);
      }
    }

    record.banned = true;
    suspiciousActivity.set(`spoof:${telegramId}`, record);

    console.log(`[ANTISPOOF] AUTO-BAN: ${telegramId} (weighted=${record.weightedScore.toFixed(1)}, total=${record.totalViolations})`);
    logPlayer(telegramId, 'ban', `Автобан: GPS спуфинг (score ${record.weightedScore.toFixed(1)})`, { violations: record.totalViolations, ban_until: banUntil.toISOString() });

    notifyAdmin(telegramId, record);
  } catch (e) {
    console.error('[ANTISPOOF] autoBan error:', e.message);
  }
}

async function notifyAdmin(telegramId, record) {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) return;

  const lastV = record.violations[record.violations.length - 1];
  const typeLabel = lastV?.type === 'joystick' ? '🕹 Джойстик' : '🚀 Скорость';

  const message = `🚨 АВТОБАН — GPS\n\n👤 ID: ${telegramId}\n📊 Score: ${record.weightedScore.toFixed(1)}/${VIOLATION_THRESHOLD}\n📌 Нарушений: ${record.totalViolations}\n${typeLabel}: ${lastV?.speed?.toFixed(0) || '?'} км/ч\n📏 ${lastV?.distance?.toFixed(2) || '?'} км\n⏰ Бан ${BAN_DAYS} дней`;

  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ADMIN_TG_ID,
        text: message,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Подтвердить', callback_data: `confirm_ban_${telegramId}` },
            { text: '❌ Разбанить', callback_data: `unban_${telegramId}` },
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
  joystickScores.delete(telegramId);
}

export function resetPositionHistory(telegramId) {
  positionHistory.delete(telegramId);
}
