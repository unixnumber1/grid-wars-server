import { haversine } from '../lib/haversine.js';
import { suspiciousActivity } from './rateLimit.js';
import { logPlayer } from '../lib/logger.js';
import { ADMIN_NOTIFY_ID, ANTISPOOF, isAdmin } from '../config/constants.js';
import { playerCityCache } from '../lib/geocity.js';

// ═══════════════════════════════════════════════════════
//  GPS Anti-Spoof v4.1 — Stage 0 fixes
//
//  Principles:
//  1. Detect FAKE GPS SOFTWARE by missing altitude/speed/heading
//  2. Detect impossible absolute distance (>2000km in one jump, any time)
//  3. Detect cosmic speeds (>500 km/h) within a session
//  4. Catch cross-session city jumps (>100km after a gap)
//  5. PIN mode: clean slate — no synthetic HQ point, generous grace
//  6. Bad accuracy → silently reject, no penalty
// ═══════════════════════════════════════════════════════

const {
  PIN_MAX_DISTANCE_KM, PIN_GRACE_MS,
  MIN_UPDATE_INTERVAL_MS, POSITION_HISTORY_SIZE, SESSION_GAP_MS, STALE_HISTORY_MS,
  TELEPORT_SPEED_KMH, TELEPORT_MAX_TIME_S,
  HIGH_SPEED_KMH, HIGH_SPEED_MAX_TIME_S,
  BAD_ACCURACY_THRESHOLD,
  IMPOSSIBLE_DISTANCE_KM, CITY_JUMP_MIN_DISTANCE_KM,
  FINGERPRINT_MIN_UPDATES, FINGERPRINT_NULL_RATIO, FINGERPRINT_MIN_MOVEMENT_M,
  VIOLATION_THRESHOLD, BAN_DAYS,
} = ANTISPOOF;

// ── Per-player state ──
const positionHistory = new Map();  // telegram_id → [{ lat, lng, timestamp, ...gpsData }]
const gpsFingerprint = new Map();   // telegram_id → { nullCount, totalMoving, lastViolationAt }
const pinModeState = new Map();     // telegram_id → { active, graceUntil }
const playerHqPositions = new Map(); // telegram_id → { lat, lng } — cached HQ position for PIN detection
const pendingBoomerangs = new Map(); // telegram_id → { lat, lng, timestamp } — pre-jump position for jammer detection
const BOOMERANG_RADIUS_M = 500;     // return within 500m = jammer, not spoofer
const BOOMERANG_TIMEOUT_MS = 300000; // 5 minutes to return
const CLUSTER_WINDOW_MS = 120000;    // 2 minutes — violations in same window = one incident

// ── PIN mode ──
//
// On PIN on/off we:
//   1) Fully delete positionHistory — no synthetic HQ anchor (was source of
//      false positives: a fake "you were at HQ just now" point made the next
//      real GPS update look like a 1000+ km/h teleport).
//   2) Extend grace to 30s (was 5s — too short for client to send first real
//      coords after unpin).
//   3) On ACTIVATION clear suspiciousActivity entirely. Rationale: real
//      spoofers should already have been caught by past detections; legit
//      players using PIN should not be one stray glitch away from a ban.
//   4) Clear gpsFingerprint (PIN coords have no real altitude/speed/heading).
export function setPinMode(telegramId, active) {
  const now = Date.now();
  pinModeState.set(telegramId, { active, graceUntil: now + PIN_GRACE_MS });
  positionHistory.delete(telegramId);
  gpsFingerprint.delete(telegramId);
  if (active) {
    suspiciousActivity.delete(`spoof:${telegramId}`);
  }
}

export function isPinModeActive(telegramId) {
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

  // PIN mode — distance check + GPS fingerprint (skip speed checks)
  if (isPinMode || isPinModeActive(telegramId)) {
    const history = positionHistory.get(telegramId) || [];
    if (history.length > 0) {
      const last = history[history.length - 1];
      const distanceKm = haversine(last.lat, last.lng, lat, lng) / 1000;
      if (distanceKm > PIN_MAX_DISTANCE_KM) {
        return { valid: false, reason: 'pin_too_far', distance: distanceKm };
      }
      // Skip GPS fingerprint check in PIN mode — position is virtual (HQ),
      // so null altitude/speed/heading is expected, not a sign of spoofing
    }
    // Update history for PIN mode too
    const pinHistory = positionHistory.get(telegramId) || [];
    pinHistory.push({ lat, lng, timestamp: now, ...gpsData });
    if (pinHistory.length > POSITION_HISTORY_SIZE) pinHistory.shift();
    positionHistory.set(telegramId, pinHistory);
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

    // ── Absolute impossible distance — fires regardless of time elapsed ──
    // Catches the "wait 24h, teleport across continents" exploit that bypasses
    // all speed-based checks (because speed = distance/time gets diluted).
    if (distanceKm > IMPOSSIBLE_DISTANCE_KM) {
      recordViolation(telegramId, {
        timestamp: now, speed: speedKmh, distance: distanceKm,
        from: { lat: last.lat, lng: last.lng }, to: { lat, lng },
        type: 'impossible_distance', timeGapS: timeDiffS,
      });
      // Reset history and continue — don't reject the update silently, the
      // violation has been recorded and will contribute to ban score.
      history.length = 0;
      history.push({ lat, lng, timestamp: now, ...gpsData });
      positionHistory.set(telegramId, history);
      return { valid: true };
    }

    // ── Session gap (>60s) — reset history, but still check for cross-session jumps ──
    if (timeDiffMs > SESSION_GAP_MS) {
      // Cosmic teleport (>500km/h) — same as before
      if (speedKmh > TELEPORT_SPEED_KMH && distanceKm > 5) {
        recordViolation(telegramId, {
          timestamp: now, speed: speedKmh, distance: distanceKm,
          from: { lat: last.lat, lng: last.lng }, to: { lat, lng },
          type: 'teleport',
        });
      }
      // Cross-session city jump: any >=100km gap, time-independent.
      // Previously required >200km/h which dropped to ~0 over long gaps,
      // letting spoofers slip through by waiting hours between jumps.
      else if (distanceKm >= CITY_JUMP_MIN_DISTANCE_KM) {
        recordViolation(telegramId, {
          timestamp: now, speed: speedKmh, distance: distanceKm,
          from: { lat: last.lat, lng: last.lng }, to: { lat, lng },
          type: 'city_jump', timeGapS: timeDiffS,
        });
      }
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

  // ── Boomerang detection: player returned to pre-jump position → likely jammer, not spoof ──
  const boom = pendingBoomerangs.get(telegramId);
  if (boom) {
    if (now - boom.timestamp > BOOMERANG_TIMEOUT_MS) {
      // Timed out — player didn't return, likely real spoof
      pendingBoomerangs.delete(telegramId);
    } else {
      const returnDist = haversine(lat, lng, boom.lat, boom.lng);
      if (returnDist <= BOOMERANG_RADIUS_M) {
        // Player returned near pre-jump position → jammer, reduce violation weight
        pendingBoomerangs.delete(telegramId);
        const key = `spoof:${telegramId}`;
        const record = suspiciousActivity.get(key);
        if (record) {
          // Mark recent teleport/speed violations as jammer
          for (let i = record.violations.length - 1; i >= 0; i--) {
            const v = record.violations[i];
            if (v.jammer) continue;
            if (now - v.timestamp > BOOMERANG_TIMEOUT_MS) break;
            if (v.type === 'teleport' || v.type === 'speed') {
              v.jammer = true;
              console.log(`[ANTISPOOF] Boomerang detected for ${telegramId}: returned ${Math.round(returnDist)}m from pre-jump, marking violation as jammer`);
            }
          }
        }
      }
    }
  }

  return { valid: true };
}

// ── Violation Recording ──
// All violation types contribute to auto-ban score (threshold = 10).
//   impossible_distance (>2000km jump, any time) = 8 pts → second jump = ban
//   fake_gps (null altitude/speed/heading)        = 4 pts
//   city_jump (>=100km cross-session)             = 6 pts → second jump = ban
//   teleport (>500km/h within session)            = 2 pts
//   speed (>300km/h within 30s)                   = 1 pt
const TYPE_WEIGHT = { impossible_distance: 8, fake_gps: 4, city_jump: 6, teleport: 2, speed: 1 };

function recordViolation(telegramId, violation) {
  const key = `spoof:${telegramId}`;
  const record = suspiciousActivity.get(key) || {
    violations: [],
    totalViolations: 0,
    weightedScore: 0,
    banned: false,
  };

  // Save pre-jump position for boomerang detection (jammer vs spoofer)
  if ((violation.type === 'teleport' || violation.type === 'speed') && violation.from) {
    pendingBoomerangs.set(telegramId, {
      lat: violation.from.lat, lng: violation.from.lng,
      timestamp: violation.timestamp,
    });
  }

  // Cluster detection: violations within 2 min = same jammer episode, don't stack
  const lastV = record.violations.length > 0 ? record.violations[record.violations.length - 1] : null;
  if (lastV && (violation.timestamp - lastV.timestamp) < CLUSTER_WINDOW_MS
      && lastV.type === violation.type && (violation.type === 'teleport' || violation.type === 'speed')) {
    // Update existing violation with worst values, don't add new entry
    lastV.speed = Math.max(lastV.speed || 0, violation.speed || 0);
    lastV.distance = Math.max(lastV.distance || 0, violation.distance || 0);
    lastV.to = violation.to;
    lastV.clustered = (lastV.clustered || 1) + 1;
    // Don't increment totalViolations — same incident
  } else {
    record.violations.push(violation);
    record.totalViolations++;
  }

  // Recalculate weighted score with time decay + boomerang discount
  const now = Date.now();
  const ONE_DAY = 86400000;
  let weightedScore = 0;
  for (const v of record.violations) {
    const age = now - v.timestamp;
    const tw = TYPE_WEIGHT[v.type] || 1;
    const jammerDiscount = v.jammer ? 0.1 : 1; // boomerang = likely jammer, 10% weight
    let decayed = tw * jammerDiscount;
    if (age < ONE_DAY) weightedScore += decayed;
    else if (age < 7 * ONE_DAY) weightedScore += decayed * 0.5;
    else weightedScore += decayed * 0.2;
  }
  record.weightedScore = weightedScore;

  if (record.violations.length > 50) record.violations.shift();
  suspiciousActivity.set(key, record);

  const typeLabels = { teleport: '🚀 Телепорт', speed: '⚡ Скорость', fake_gps: '📡 Фейк GPS', city_jump: '🏙️ Межгород', impossible_distance: '🌍 Невозможный прыжок' };
  const label = typeLabels[violation.type] || violation.type;
  console.log(`[ANTISPOOF] ${label} #${record.totalViolations} for ${telegramId}: speed=${violation.speed?.toFixed(0) || 0}km/h, dist=${violation.distance?.toFixed(2) || 0}km, weighted=${weightedScore.toFixed(1)}`);
  logPlayer(telegramId, 'spoof', `${label}: ${violation.speed?.toFixed(0) || 0} км/ч`, {
    speed: violation.speed, distance: violation.distance, type: violation.type,
    from: violation.from, to: violation.to,
    nullRatio: violation.nullRatio, nullCount: violation.nullCount,
  });

  if (record.weightedScore >= VIOLATION_THRESHOLD && !record.banned) {
    autoBan(telegramId, record);
  }
}

// ── Auto-Ban ──
// CRITICAL: update gameState FIRST (synchronous), THEN persist to DB.
// Previously the DB write came first via `await import(...)` + `await supabase.update(...)`,
// and the batch persist loop (every 30s) could run in between and OVERWRITE the DB
// with the stale gameState (is_banned=false), erasing the ban entirely. This caused
// 4 confirmed auto-ban failures on production.
async function autoBan(telegramId, record) {
  if (isAdmin(telegramId)) return;
  try {
    const banUntil = new Date(Date.now() + BAN_DAYS * 24 * 60 * 60 * 1000);
    const banReason = 'GPS спуфинг (автобан v4)';
    const banUntilISO = banUntil.toISOString();

    // 1) Update gameState IMMEDIATELY (synchronous — no await, no import delay).
    //    gameState is already imported at the top of this file via '../state/GameState.js'.
    //    The persist loop will see is_banned=true on next cycle and write it to DB.
    const p = gameState.getPlayerByTgId(Number(telegramId));
    if (p) {
      p.is_banned = true;
      p.ban_reason = banReason;
      p.ban_until = banUntilISO;
      gameState.markDirty('players', p.id);
    }

    // 2) Also write to DB directly as a safety net (in case persist hasn't run yet
    //    and the checkBan middleware reads from DB on the next request).
    const { supabase } = await import('../lib/supabase.js');
    await supabase.from('players').update({
      is_banned: true,
      ban_reason: banReason,
      ban_until: banUntilISO,
    }).eq('telegram_id', Number(telegramId));

    record.banned = true;
    suspiciousActivity.set(`spoof:${telegramId}`, record);

    console.log(`[ANTISPOOF] AUTO-BAN: ${telegramId} (weighted=${record.weightedScore.toFixed(1)}, total=${record.totalViolations})`);
    logPlayer(telegramId, 'ban', `Автобан v4: GPS спуфинг (score ${record.weightedScore.toFixed(1)})`, {
      violations: record.totalViolations, ban_until: banUntilISO,
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
  const typeLabels = { teleport: '🚀 Телепорт', speed: '⚡ Скорость', fake_gps: '📡 Фейк GPS', city_jump: '🏙️ Межгород', impossible_distance: '🌍 Невозможный прыжок' };
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

// ── Hourly digest ──
//
// Sends an antispoof activity summary to the admin chat every hour.
// Quiet hours: a single line confirming the system is alive.
// Active hours: type breakdown + top 5 players by score.
const DIGEST_WINDOW_MS = 3600000;

async function _sendTelegramMessage(token, text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_NOTIFY_ID, text }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error('[ANTISPOOF] digest send non-ok:', r.status, body.slice(0, 200));
    }
  } catch (e) {
    console.error('[ANTISPOOF] digest send error:', e.message, e.cause?.message || '');
  }
}

export async function sendHourlyDigest() {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) return;

  const now = Date.now();
  const cutoff = now - DIGEST_WINDOW_MS;

  // Collect all players with violations in the last hour window
  const players = [];
  for (const [key, record] of suspiciousActivity.entries()) {
    if (typeof key !== 'string' || !key.startsWith('spoof:')) continue;
    const tgId = key.substring(6);
    const recent = (record.violations || []).filter(v => v && v.timestamp >= cutoff);
    if (recent.length === 0) continue;
    const byType = {};
    for (const v of recent) byType[v.type] = (byType[v.type] || 0) + 1;
    players.push({
      tgId,
      byType,
      score: record.weightedScore || 0,
      banned: !!record.banned,
    });
  }

  const typeLabels = {
    teleport: '🚀 Тлп', speed: '⚡ Скр', fake_gps: '📡 Фейк',
    city_jump: '🏙 Мж', impossible_distance: '🌍 Прж',
  };

  if (players.length === 0) {
    await _sendTelegramMessage(BOT_TOKEN, '🛡 Антиспуф: за последний час нарушений не было.');
    return;
  }

  // Aggregate totals across all players
  const totals = {};
  let totalEvents = 0;
  for (const p of players) {
    for (const [type, cnt] of Object.entries(p.byType)) {
      totals[type] = (totals[type] || 0) + cnt;
      totalEvents += cnt;
    }
  }
  const typeBreakdown = Object.entries(totals)
    .map(([t, c]) => `${typeLabels[t] || t}:${c}`)
    .join(' ');

  let msg = `🛡 Антиспуф — последний час\n`;
  msg += `Всего: ${totalEvents} событий, ${players.length} игроков\n`;
  msg += `${typeBreakdown}\n\n`;

  // Top 5 players by current weighted score
  players.sort((a, b) => b.score - a.score);
  for (const p of players.slice(0, 5)) {
    const player = await getPlayerInfo(Number(p.tgId));
    const name = player?.game_username || '???';
    const banFlag = p.banned ? ' 🔴БАН' : (p.score >= VIOLATION_THRESHOLD * 0.5 ? ' ⚠️' : '');
    const typesStr = Object.entries(p.byType)
      .map(([t, c]) => `${typeLabels[t] || t}:${c}`)
      .join(' ');
    msg += `${name} (id${p.tgId})${banFlag}\n  score=${p.score.toFixed(1)}/${VIOLATION_THRESHOLD} | ${typesStr}\n`;
  }

  await _sendTelegramMessage(BOT_TOKEN, msg);
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
  const ts = new Date(lastSeen).getTime();
  if (isNaN(ts)) return;
  const existing = positionHistory.get(telegramId);
  // Re-seed if memory is empty OR last in-memory point is stale (>1h old).
  // Without this, a player who reconnects from a different country could
  // skip cross-session detection by having any leftover in-memory point.
  if (existing && existing.length > 0) {
    const lastTs = existing[existing.length - 1].timestamp || 0;
    if (Date.now() - lastTs < STALE_HISTORY_MS) return;
  }
  positionHistory.set(telegramId, [{ lat: lastLat, lng: lastLng, timestamp: ts, accuracy: null }]);
}
