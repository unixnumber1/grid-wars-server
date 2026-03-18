// ── Auth middleware: extract and validate telegram_id ──

export function requireTelegramId(req, res, next) {
  const telegramId = parseInt(req.body?.telegram_id || req.query?.telegram_id);
  if (!telegramId || isNaN(telegramId) || telegramId <= 0) {
    return res.status(400).json({ error: 'telegram_id is required' });
  }
  req.telegramId = telegramId;
  next();
}
