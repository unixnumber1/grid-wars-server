// ═══════════════════════════════════════════════════════
//  Telegram Mini App initData verification (HMAC-SHA256)
//  https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// ═══════════════════════════════════════════════════════

import crypto from 'crypto';

const BOT_TOKEN = process.env.BOT_TOKEN;
const AUTH_MAX_AGE_SEC = 86400; // 24 hours

// Paths that don't require initData verification
const SKIP_PATHS = [
  '/api/telegram-webhook',
  '/api/health',
];

/**
 * Verify Telegram Mini App initData string.
 * Returns { valid: true, user: { id, ... } } or { valid: false, reason: string }
 */
export function verifyInitData(initDataStr) {
  if (!initDataStr || !BOT_TOKEN) return { valid: false, reason: 'missing_data' };

  try {
    const params = new URLSearchParams(initDataStr);
    const hash = params.get('hash');
    if (!hash) return { valid: false, reason: 'no_hash' };

    // Build data_check_string: sorted key=value pairs excluding hash
    const entries = [];
    for (const [key, val] of params.entries()) {
      if (key !== 'hash') entries.push([key, val]);
    }
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

    // HMAC chain: secret_key = HMAC-SHA256("WebAppData", BOT_TOKEN)
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    try {
      if (!crypto.timingSafeEqual(Buffer.from(computedHash, 'hex'), Buffer.from(hash, 'hex')))
        return { valid: false, reason: 'hash_mismatch' };
    } catch {
      return { valid: false, reason: 'hash_mismatch' };
    }

    // Check auth_date freshness
    const authDate = parseInt(params.get('auth_date'), 10);
    if (authDate) {
      const age = Math.floor(Date.now() / 1000) - authDate;
      if (age > AUTH_MAX_AGE_SEC) return { valid: false, reason: 'expired' };
    }

    // Extract user
    const userStr = params.get('user');
    if (!userStr) return { valid: false, reason: 'no_user' };
    const user = JSON.parse(userStr);
    if (!user.id) return { valid: false, reason: 'no_user_id' };

    return { valid: true, user, authDate };
  } catch (e) {
    return { valid: false, reason: 'parse_error: ' + e.message };
  }
}

/**
 * Express middleware: verifies X-Telegram-Init-Data header.
 * Sets req.verifiedTgId on success.
 * If initData present and valid — overrides telegram_id from verified payload.
 * If initData present but invalid — rejects with 403.
 * If initData absent — allows through (for backward compat) but marks as unverified.
 */
export function verifyTelegramAuth(req, res, next) {
  // Skip whitelisted paths
  const fullPath = (req.originalUrl || req.url || '').split('?')[0];
  if (SKIP_PATHS.some(p => fullPath === p || fullPath.startsWith(p + '/'))) return next();

  const initData = req.headers['x-telegram-init-data'];

  // No initData — block POST/PUT/DELETE (mutations require auth), allow GET
  if (!initData) {
    if (req.method !== 'GET') {
      console.warn(`[AUTH] Blocked unauthenticated ${req.method} ${fullPath} from ${req.ip}`);
      return res.status(403).json({ error: 'Auth required', reason: 'missing_init_data' });
    }
    req.authVerified = false;
    return next();
  }

  const result = verifyInitData(initData);
  if (!result.valid) {
    // initData was provided but is invalid — reject (likely tampered)
    return res.status(403).json({ error: 'Invalid auth', reason: result.reason });
  }

  // Verified — override telegram_id so existing routes use verified value
  req.verifiedTgId = result.user.id;
  req.verifiedUser = result.user; // full user: id, username, first_name, last_name, language_code
  req.authVerified = true;
  if (req.body) req.body.telegram_id = result.user.id;
  if (req.query) req.query.telegram_id = String(result.user.id);

  next();
}
