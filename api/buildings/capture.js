import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { haversine } from '../../lib/haversine.js';

const CAPTURE_RADIUS = 50; // meters
const BOT_TOKEN = process.env.BOT_TOKEN;

async function sendTelegramNotification(telegramId, text) {
  if (!BOT_TOKEN || !telegramId) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramId, text }),
    });
  } catch (err) {
    console.error('[capture] Telegram notification error:', err);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { telegram_id, mine_id, lat, lng } = req.body;

  if (!telegram_id || !mine_id || lat == null || lng == null) {
    return res.status(400).json({ error: 'telegram_id, mine_id, lat, lng are required' });
  }

  const playerLat = parseFloat(lat);
  const playerLng = parseFloat(lng);

  const { player: attacker, error: attackerError } = await getPlayerByTelegramId(telegram_id);
  if (attackerError) return res.status(500).json({ error: attackerError });
  if (!attacker)     return res.status(404).json({ error: 'Player not found' });

  // Fetch mine with owner's telegram_id for notification
  const { data: mine, error: mineError } = await supabase
    .from('mines')
    .select('*, players!mines_owner_id_fkey(telegram_id, username)')
    .eq('id', mine_id)
    .maybeSingle();

  if (mineError) {
    console.error('[capture] mine fetch error:', mineError);
    return res.status(500).json({ error: mineError.message });
  }
  if (!mine) return res.status(404).json({ error: 'Mine not found' });

  if (mine.owner_id === attacker.id) {
    return res.status(400).json({ error: 'You already own this mine' });
  }

  const dist = haversine(playerLat, playerLng, mine.lat, mine.lng);
  if (dist > CAPTURE_RADIUS) {
    return res.status(403).json({
      error: `Too far to capture (${Math.round(dist)}m, must be within ${CAPTURE_RADIUS}m)`,
    });
  }

  const { data: updatedMine, error: updateError } = await supabase
    .from('mines')
    .update({ owner_id: attacker.id, last_collected: new Date().toISOString() })
    .eq('id', mine_id)
    .select()
    .single();

  if (updateError) {
    console.error('[capture] update error:', updateError);
    return res.status(500).json({ error: 'Failed to capture mine' });
  }

  const prevOwnerTelegramId = mine.players?.telegram_id;
  if (prevOwnerTelegramId) {
    const attackerName = req.body.username || 'Someone';
    await sendTelegramNotification(
      prevOwnerTelegramId,
      `\u2694\ufe0f Your mine (level ${mine.level}) was captured by ${attackerName}!`
    );
  }

  return res.status(200).json({ mine: updatedMine });
}
