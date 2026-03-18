// Input validation and ban check middleware

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateRequest(req, res, next) {
  const body = req.body;
  if (!body) return next();

  // Validate UUID fields — reject non-UUID strings before they hit PostgreSQL
  const uuidFields = ['mine_id', 'item_id', 'player_id', 'listing_id', 'monument_id', 'collector_id', 'clan_id', 'node_id'];
  for (const field of uuidFields) {
    if (body[field] != null && typeof body[field] === 'string' && !UUID_RE.test(body[field])) {
      return res.status(400).json({ error: `Invalid ${field}` });
    }
  }

  // Validate telegram_id
  if (body.telegram_id !== undefined) {
    const id = parseInt(body.telegram_id);
    if (isNaN(id) || id <= 0 || id > 9999999999) {
      return res.status(400).json({ error: 'Invalid telegram_id' });
    }
    body.telegram_id = id;
  }

  // Validate coordinates
  if (body.lat !== undefined || body.lng !== undefined) {
    const lat = parseFloat(body.lat);
    const lng = parseFloat(body.lng);
    if (body.lat !== undefined && (isNaN(lat) || lat < -90 || lat > 90)) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }
    if (body.lng !== undefined && (isNaN(lng) || lng < -180 || lng > 180)) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }
    if (body.lat !== undefined) body.lat = lat;
    if (body.lng !== undefined) body.lng = lng;
  }

  // Validate numeric fields (skip null — many game fields are nullable)
  const numericFields = ['level', 'amount', 'price', 'quantity'];
  for (const field of numericFields) {
    if (body[field] != null) {
      const val = parseFloat(body[field]);
      if (isNaN(val) || val < 0) {
        return res.status(400).json({ error: `Invalid ${field}` });
      }
      body[field] = val;
    }
  }

  // Sanitize string fields (strip HTML tags, skip null — game objects often have nullable name/description)
  const stringFields = ['username', 'action', 'name', 'description'];
  for (const field of stringFields) {
    if (body[field] != null) {
      if (typeof body[field] !== 'string') {
        return res.status(400).json({ error: `Invalid ${field}` });
      }
      body[field] = body[field].replace(/<[^>]*>/g, '').trim();
      if (body[field].length > 500) {
        return res.status(400).json({ error: `${field} too long` });
      }
    }
  }

  next();
}

// Ban check middleware for API routes
export async function checkBan(req, res, next) {
  const telegramId = parseInt(req.body?.telegram_id || req.query?.telegram_id);
  if (!telegramId) return next();

  try {
    const { gameState } = await import('../lib/gameState.js');
    if (!gameState.loaded) return next();

    const player = gameState.getPlayerByTgId(telegramId);
    if (player?.is_banned) {
      const bannedForever = !player.ban_until;
      const stillBanned = bannedForever || new Date(player.ban_until) > new Date();
      if (stillBanned) {
        return res.status(403).json({
          error: '\u0410\u043A\u043A\u0430\u0443\u043D\u0442 \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D',
          reason: player.ban_reason || '\u041D\u0430\u0440\u0443\u0448\u0435\u043D\u0438\u0435 \u043F\u0440\u0430\u0432\u0438\u043B',
          banned: true,
        });
      }
    }
  } catch (_) {}

  next();
}
