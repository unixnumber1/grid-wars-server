import { haversine } from '../lib/haversine.js';
import { suspiciousActivity } from './rateLimit.js';
import { logPlayer } from '../lib/logger.js';
import { ADMIN_TG_ID, ANTISPOOF, isAdmin } from '../config/constants.js';

// ═══════════════════════════════════════════════════════
//  GPS Anti-Spoof v3 — jamming-tolerant, PIN-aware
// ═══════════════════════════════════════════════════════

const {
  MAX_SPEED_KMH, PIN_MAX_DISTANCE_KM, PIN_GRACE_MS,
  MIN_UPDATE_INTERVAL_MS, POSITION_HISTORY_SIZE,
  VIOLATION_THRESHOLD, BAN_DAYS,
  SESSION_MAX_SPEED_KMH, SESSION_GAP_MIN_MS,
  JAMMING_ACCURACY_THRESHOLD, JAMMING_JUMP_KM, JAMMING_COOLDOWN_MS, JAMMING_MAX_COOLDOWN_MS,
  SNAP_BACK_RADIUS_M, OSCILLATION_RADIUS_M,
  INSTABILITY_DECAY_PER_UPDATE, INSTABILITY_MODERATE, INSTABILITY_SEVERE,
  JITTER_THRESHOLD, CONST_SPEED_WINDOW, CONST_SPEED_TOLERANCE,
  SUSPICIOUS_ACCURACY, JOYSTICK_SCORE_THRESHOLD,
} = ANTISPOOF;

// ── Per-player state maps ──
const positionHistory = new Map(); // telegram_id -> [{ lat, lng, timestamp, accuracy }]
const joystickScores = new Map();  // telegram_id -> { score, lastDecay, jammingUntil }
const pinModeState = new Map();    // telegram_id -> { active, graceUntil }
const gpsInstability = new Map();  // telegram_id -> { score, preJammingPositions, jammingCount }

// ── PIN mode server-side tracking ──

export function setPinMode(telegramId, active) {
  const now = Date.now();
  if (active) {
    pinModeState.set(telegramId, { active: true, graceUntil: now + PIN_GRACE_MS });
    // Reset history so the teleport to HQ doesn't pollute speed checks
    positionHistory.delete(telegramId);
  } else {
    pinModeState.set(telegramId, { active: false, graceUntil: now + PIN_GRACE_MS });
    // Reset history so the return from HQ to real GPS doesn't trigger speed violation
    positionHistory.delete(telegramId);
  }
}

function isPinModeActive(telegramId) {
  const state = pinModeState.get(telegramId);
  if (!state) return false;
  // Active OR within grace window (covers socket events that arrive before HTTP)
  if (state.active) return true;
  if (Date.now() < state.graceUntil) return true;
  return false;
}

// ── Oscillation detection ──
// GPS jammers cause position to bounce between points. If current position
// is close to a position from 3+ updates ago, it's oscillation (not travel).
function detectOscillation(history, lat, lng) {
  if (history.length < 3) return false;
  // Check positions from 3+ updates ago (skip last 2 to avoid normal backtracking)
  for (let i = 0; i < history.length - 2; i++) {
    const dist = haversine(history[i].lat, history[i].lng, lat, lng);
    if (dist < OSCILLATION_RADIUS_M) return true;
  }
  return false;
}

// ── Snap-back detection ──
// After jamming cooldown expires, GPS may "snap back" to real position.
// If the new position is close to a pre-jamming stable position, it's recovery.
function isSnapBack(preJammingPositions, lat, lng) {
  if (!preJammingPositions || preJammingPositions.length === 0) return false;
  for (const pos of preJammingPositions) {
    if (haversine(pos.lat, pos.lng, lat, lng) < SNAP_BACK_RADIUS_M) return true;
  }
  return false;
}

// ── GPS instability score update ──
function updateInstability(telegramId, accuracy, distanceKm, timeDiffS, isOscillation) {
  const inst = gpsInstability.get(telegramId) || { score: 0, preJammingPositions: [], jammingCount: 0 };

  let increase = 0;
  if (accuracy !== null && accuracy > 100) increase += 5;
  if (accuracy !== null && accuracy > JAMMING_ACCURACY_THRESHOLD) increase += 10;
  if (distanceKm > 0.2 && timeDiffS < 5) increase += 15;  // 200m+ jump in <5s
  if (distanceKm >= 2 && timeDiffS < 5) increase += 10;    // extra for huge jumps
  if (isOscillation) increase += 10;

  if (increase > 0) {
    inst.score = Math.min(100, inst.score + increase);
  } else {
    // Stable update — decay instability
    if (accuracy !== null && accuracy < 50) {
      inst.score = Math.max(0, inst.score - INSTABILITY_DECAY_PER_UPDATE);
    }
  }

  gpsInstability.set(telegramId, inst);
  return inst;
}

// ── Adaptive cooldown ──
// Each re-detection of jamming extends the cooldown. Capped at max.
function getAdaptiveCooldown(inst) {
  const base = JAMMING_COOLDOWN_MS;
  // Each consecutive jamming detection adds 30s, up to max
  const extra = Math.min(inst.jammingCount, 8) * 30000;
  return Math.min(base + extra, JAMMING_MAX_COOLDOWN_MS);
}

// ════════════════════════════════════════════════════════
//  Main validation
// ════════════════════════════════════════════════════════

export function validatePosition(telegramId, lat, lng, isPinMode = false, accuracy = null) {
  // Admin bypass
  if (isAdmin(telegramId)) return { valid: true };

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

  // PIN mode — check parameter OR server-side state (covers socket race condition)
  if (isPinMode || isPinModeActive(telegramId)) {
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
    const timeDiffMs = now - last.timestamp;
    const timeDiff = timeDiffMs / 1000;
    const distance = haversine(last.lat, last.lng, lat, lng);
    const distanceKm = distance / 1000;

    // Too frequent
    if (timeDiffMs < MIN_UPDATE_INTERVAL_MS) {
      return { valid: false, reason: 'too_frequent' };
    }

    const speedKmh = timeDiff > 0 ? (distanceKm / timeDiff) * 3600 : 0;

    // ── Oscillation detection ──
    const isOscillation = detectOscillation(history, lat, lng);

    // ── Update GPS instability score ──
    const inst = updateInstability(telegramId, accuracy, distanceKm, timeDiff, isOscillation);

    // ── GPS Jamming Detection (improved) ──
    // Lowered thresholds: 500m jump in <5s, bad accuracy, or oscillation pattern
    const isLikelyJamming = (
      (accuracy !== null && accuracy > JAMMING_ACCURACY_THRESHOLD) ||
      (distanceKm > JAMMING_JUMP_KM && timeDiff < 5) ||
      (isOscillation && distanceKm > 0.1 && speedKmh > 50)
    );

    if (isLikelyJamming) {
      // Save pre-jamming positions (stable ones) for snap-back detection
      if (inst.jammingCount === 0 || inst.preJammingPositions.length === 0) {
        inst.preJammingPositions = history
          .filter(h => h.accuracy === null || h.accuracy < 100)
          .slice(-5)
          .map(h => ({ lat: h.lat, lng: h.lng }));
      }
      inst.jammingCount++;
      gpsInstability.set(telegramId, inst);

      // Adaptive cooldown — extends on repeated detection
      const cooldown = getAdaptiveCooldown(inst);
      jScore.jammingUntil = now + cooldown;
      joystickScores.set(telegramId, jScore);
      return { valid: false, reason: 'gps_jamming', speed: speedKmh };
    }

    // During jamming cooldown — accept positions but skip all checks
    if (now < jScore.jammingUntil) {
      history.push({ lat, lng, timestamp: now, accuracy });
      if (history.length > POSITION_HISTORY_SIZE) history.shift();
      positionHistory.set(telegramId, history);
      return { valid: true };
    }

    // ── Jamming cooldown just expired — check for snap-back ──
    // If the player's position returned to where they were before jamming, it's GPS recovery
    if (inst.preJammingPositions.length > 0 && speedKmh > MAX_SPEED_KMH && distanceKm > 0.1) {
      if (isSnapBack(inst.preJammingPositions, lat, lng)) {
        // GPS recovered to real position — accept and clear jamming state
        inst.preJammingPositions = [];
        inst.jammingCount = 0;
        inst.score = Math.max(0, inst.score - 20);
        gpsInstability.set(telegramId, inst);
        // Reset history to new (real) position
        history.length = 0;
        history.push({ lat, lng, timestamp: now, accuracy });
        positionHistory.set(telegramId, history);
        return { valid: true };
      }
    }

    // ── Speed Check (instability-adaptive) ──
    // Determine effective speed limit based on GPS instability
    let effectiveSpeedLimit = MAX_SPEED_KMH;
    if (inst.score >= INSTABILITY_SEVERE) {
      // Severe instability: treat impossible speed as jamming, not violation
      effectiveSpeedLimit = Infinity;
    } else if (inst.score >= INSTABILITY_MODERATE) {
      // Moderate instability: double the threshold
      effectiveSpeedLimit = MAX_SPEED_KMH * 2;
    }

    if (speedKmh > effectiveSpeedLimit && distanceKm > 0.3) {
      // If gap > 1 min, this is a cross-session reconnect — use more lenient check
      if (timeDiffMs > SESSION_GAP_MIN_MS) {
        const sessionSpeedKmh = (distanceKm / (timeDiffMs / 1000)) * 3600;
        if (sessionSpeedKmh > SESSION_MAX_SPEED_KMH && distanceKm > 5) {
          recordSpoofViolation(telegramId, {
            timestamp: now, speed: sessionSpeedKmh, distance: distanceKm,
            from: { lat: last.lat, lng: last.lng }, to: { lat, lng },
            type: 'session_teleport', gapMinutes: Math.round(timeDiffMs / 60000),
          });
          history.length = 0;
          history.push({ lat, lng, timestamp: now, accuracy });
          positionHistory.set(telegramId, history);
          return { valid: true };
        }
        // Long gap + fast but plausible — reset history, allow
        history.length = 0;
        history.push({ lat, lng, timestamp: now, accuracy });
        positionHistory.set(telegramId, history);
        return { valid: true };
      }

      // Short gap + impossible speed
      // Medium-to-large jumps (>=500m) at impossible speed = treat as jamming always
      if (distanceKm >= 0.5) {
        inst.jammingCount++;
        if (inst.preJammingPositions.length === 0) {
          inst.preJammingPositions = history
            .filter(h => h.accuracy === null || h.accuracy < 100)
            .slice(-5)
            .map(h => ({ lat: h.lat, lng: h.lng }));
        }
        gpsInstability.set(telegramId, inst);
        const cooldown = getAdaptiveCooldown(inst);
        jScore.jammingUntil = now + cooldown;
        joystickScores.set(telegramId, jScore);
        return { valid: false, reason: 'gps_jamming', speed: speedKmh };
      }

      // Small distance (<500m) + impossible speed = real-time spoof
      recordSpoofViolation(telegramId, {
        timestamp: now, speed: speedKmh, distance: distanceKm,
        from: { lat: last.lat, lng: last.lng }, to: { lat, lng },
        type: 'speed',
      });
      return { valid: false, reason: 'impossible_speed', speed: speedKmh };
    }

    // If we got here with normal speed, decay jamming state
    if (inst.jammingCount > 0 && speedKmh < 50 && (accuracy === null || accuracy < 50)) {
      inst.jammingCount = Math.max(0, inst.jammingCount - 1);
      if (inst.jammingCount === 0) inst.preJammingPositions = [];
      gpsInstability.set(telegramId, inst);
    }

    // ── Joystick Pattern Detection (unchanged) ──
    if (history.length >= 3) {
      let scoreIncrease = 0;

      // Check 1: No jitter (positions too smooth)
      if (distance > 10 && distance < 5000) {
        const prevDistance = history.length >= 2
          ? haversine(history[history.length - 2].lat, history[history.length - 2].lng, last.lat, last.lng)
          : 0;
        if (prevDistance > 10) {
          const bearing1 = getBearing(history[history.length - 2], last);
          const bearing2 = getBearing(last, { lat, lng });
          const bearingDiff = Math.abs(bearing1 - bearing2);
          const normalizedDiff = bearingDiff > 180 ? 360 - bearingDiff : bearingDiff;
          if (normalizedDiff < 0.5 && distance > 50) {
            scoreIncrease += 2;
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
            speeds.push((d / dt) * 3.6);
          }
        }
        if (speeds.length >= 4) {
          const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
          if (avgSpeed > 3) {
            const maxDeviation = Math.max(...speeds.map(s => Math.abs(s - avgSpeed) / avgSpeed));
            if (maxDeviation < CONST_SPEED_TOLERANCE) {
              scoreIncrease += 5;
            }
          }
        }
      }

      // Check 3: Suspiciously perfect accuracy
      if (accuracy !== null && accuracy < SUSPICIOUS_ACCURACY) {
        const recentPerfect = history.slice(-8).filter(h => h.accuracy !== null && h.accuracy < SUSPICIOUS_ACCURACY).length;
        if (recentPerfect >= 7) {
          scoreIncrease += 1;
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
          jScore.score = Math.floor(jScore.score * 0.5);
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

  const now = Date.now();
  const ONE_DAY = 86400000;
  const TYPE_WEIGHT = { speed: 0.5, session_teleport: 1.0, joystick: 1.5 };
  let weightedScore = 0;
  for (const v of record.violations) {
    const age = now - v.timestamp;
    const tw = TYPE_WEIGHT[v.type] || 1.0;
    if (age < ONE_DAY) weightedScore += 1 * tw;
    else if (age < 7 * ONE_DAY) weightedScore += 0.7 * tw;
    else weightedScore += 0.3 * tw;
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

  if (record.weightedScore >= VIOLATION_THRESHOLD && !record.banned) {
    autoBan(telegramId, record);
  }
}

async function autoBan(telegramId, record) {
  if (isAdmin(telegramId)) return;
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
  gpsInstability.delete(telegramId);
  pinModeState.delete(telegramId);
}

export function resetPositionHistory(telegramId) {
  positionHistory.delete(telegramId);
}

// Seed position history from DB on player connect (for cross-session teleport detection)
export function seedPositionFromDB(telegramId, lastLat, lastLng, lastSeen) {
  if (!lastLat || !lastLng || !lastSeen) return;
  const existing = positionHistory.get(telegramId);
  if (existing && existing.length > 0) return;
  const ts = new Date(lastSeen).getTime();
  if (isNaN(ts)) return;
  positionHistory.set(telegramId, [{ lat: lastLat, lng: lastLng, timestamp: ts, accuracy: null }]);
}
