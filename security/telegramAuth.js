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

    if (computedHash !== hash) return { valid: false, reason: 'hash_mismatch' };

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
 * Rejects with 403 on failure (unless path is in SKIP_PATHS).
 */
export function verifyTelegramAuth(req, res, next) {
  // Skip non-API and whitelisted paths
  if (SKIP_PATHS.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();

  const initData = req.headers['x-telegram-init-data'];

  if (!initData) {
    return res.status(403).json({ error: 'Auth required' });
  }

  const result = verifyInitData(initData);
  if (!result.valid) {
    return res.status(403).json({ error: 'Invalid auth', reason: result.reason });
  }

  // Set verified telegram_id — routes MUST use this instead of req.body.telegram_id
  req.verifiedTgId = result.user.id;

  // Also override body.telegram_id so existing routes work without changes
  if (req.body) req.body.telegram_id = result.user.id;
  if (req.query) req.query.telegram_id = String(result.user.id);

  next();
}
