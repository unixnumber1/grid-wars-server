import { getPlayerByTelegramId } from '../../lib/supabase.js';
import { ensureMarketNearPlayer } from '../../lib/markets.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telegram_id, lat, lng } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  if (lat == null || lng == null) return res.json({ success: true, created: false });

  await ensureMarketNearPlayer(parseFloat(lat), parseFloat(lng));
  return res.json({ success: true });
}
