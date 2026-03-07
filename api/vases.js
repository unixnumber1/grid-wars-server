import { supabase, getPlayerByTelegramId } from '../lib/supabase.js';
import { haversine } from '../lib/haversine.js';
import { spawnVasesForClusters } from '../lib/vases.js';

const ADMIN_TG_ID = 560013667;

// ── SPAWN (admin only) ──────────────────────────────────────────────────────
async function handleSpawn(req, res) {
  const { telegram_id } = req.body;
  if (parseInt(telegram_id, 10) !== ADMIN_TG_ID)
    return res.status(403).json({ error: 'Forbidden' });

  const spawned = await spawnVasesForClusters(supabase);
  await supabase.from('app_settings')
    .upsert({ key: 'last_vases_spawn', value: Date.now().toString() }, { onConflict: 'key' });
  return res.json({ spawned });
}

// ── BREAK (player) ──────────────────────────────────────────────────────────
async function handleBreak(req, res) {
  const { telegram_id, vase_id, lat, lng } = req.body;
  if (!telegram_id || !vase_id || lat == null || lng == null)
    return res.status(400).json({ error: 'telegram_id, vase_id, lat, lng required' });

  const { player, error } = await getPlayerByTelegramId(telegram_id);
  if (error)   return res.status(500).json({ error });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { data: vase } = await supabase
    .from('vases').select('*').eq('id', vase_id).maybeSingle();
  if (!vase)            return res.status(404).json({ error: 'Vase not found' });
  if (vase.broken_by)   return res.status(400).json({ error: 'Already broken' });
  if (new Date(vase.expires_at) < new Date())
    return res.status(400).json({ error: 'Vase expired' });

  const dist = haversine(parseFloat(lat), parseFloat(lng), vase.lat, vase.lng);
  if (dist > 100)
    return res.status(400).json({ error: `Подойди ближе (${Math.round(dist)}м > 100м)` });

  // Award diamonds
  const newDiamonds = (player.diamonds || 0) + vase.diamonds_reward;
  await Promise.all([
    supabase.from('players')
      .update({ diamonds: newDiamonds })
      .eq('id', player.id),
    supabase.from('vases')
      .update({ broken_by: player.id, broken_at: new Date().toISOString() })
      .eq('id', vase_id),
  ]);

  // Notify online players (fire-and-forget)
  const onlineThreshold = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const { data: online } = await supabase
    .from('players').select('telegram_id')
    .gte('last_seen', onlineThreshold)
    .neq('id', player.id);

  const msg = `🏺 Ваза разбита! @${player.username || 'Игрок'} забрал ${vase.diamonds_reward} 💎`;
  for (const p of (online || [])) {
    fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: p.telegram_id, text: msg }),
    }).catch(() => {});
  }

  return res.json({ diamonds: vase.diamonds_reward, totalDiamonds: newDiamonds });
}

// ── CRON (Vercel cron, GET /api/vases) ─────────────────────────────────────
async function handleCron(req, res) {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).json({ error: 'Unauthorized' });

  // Remove broken and expired vases
  await supabase.from('vases').delete().lt('expires_at', new Date().toISOString());
  await supabase.from('vases').delete().not('broken_by', 'is', null);

  const spawned = await spawnVasesForClusters(supabase);

  await supabase.from('app_settings')
    .upsert({ key: 'last_vases_spawn', value: Date.now().toString() }, { onConflict: 'key' });

  // Notify online players
  const onlineThreshold = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const { data: online } = await supabase
    .from('players').select('telegram_id')
    .gte('last_seen', onlineThreshold);

  for (const p of (online || [])) {
    fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: p.telegram_id,
        text: '🏺 Древние вазы появились на карте! Найди и разбей их первым!',
      }),
    }).catch(() => {});
  }

  return res.json({ success: true, spawned });
}

// ── ROUTER ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Cron: Vercel sends GET with Authorization header
  if (req.method === 'GET') return handleCron(req, res);

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body || {};
  if (action === 'spawn') return handleSpawn(req, res);
  if (action === 'break') return handleBreak(req, res);
  return res.status(400).json({ error: `Unknown action: ${action}` });
}
