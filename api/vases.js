import { supabase, getPlayerByTelegramId } from '../lib/supabase.js';
import { haversine } from '../lib/haversine.js';
import { spawnVasesForClusters } from '../lib/vases.js';
import { rollItem } from '../lib/items.js';

const ADMIN_TG_ID = 560013667;

// ── SPAWN (admin only) — one vase per HQ ────────────────────────────────────
async function handleSpawn(req, res) {
  const { telegram_id } = req.body;
  if (parseInt(telegram_id, 10) !== ADMIN_TG_ID)
    return res.status(403).json({ error: 'Forbidden' });

  const { data: allHQ } = await supabase.from('headquarters').select('lat, lng');
  if (!allHQ?.length) return res.json({ spawned: 0 });

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const newVases  = allHQ.map(hq => {
    const angle    = Math.random() * Math.PI * 2;
    const distM    = 30 + Math.random() * 20; // 30-50m
    const lat      = hq.lat + (distM / 111000) * Math.cos(angle);
    const lng      = hq.lng + (distM / (111000 * Math.cos(hq.lat * Math.PI / 180))) * Math.sin(angle);
    return {
      lat,
      lng,
      expires_at:       expiresAt,
      diamonds_reward:  Math.floor(Math.random() * 5) + 1,
    };
  });

  await supabase.from('vases').insert(newVases);
  await supabase.from('app_settings')
    .upsert({ key: 'last_vases_spawn', value: Date.now().toString() }, { onConflict: 'key' });
  return res.json({ spawned: newVases.length });
}

// ── BREAK (player) ──────────────────────────────────────────────────────────
async function handleBreak(req, res) {
  const { telegram_id, vase_id, lat, lng } = req.body;
  if (!telegram_id || !vase_id || lat == null || lng == null)
    return res.status(400).json({ error: 'telegram_id, vase_id, lat, lng required' });

  const { player, error } = await getPlayerByTelegramId(telegram_id, 'id,username,diamonds');
  if (error)   return res.status(500).json({ error });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { data: vase } = await supabase
    .from('vases').select('id,lat,lng,diamonds_reward,broken_by,expires_at').eq('id', vase_id).maybeSingle();
  if (!vase)            return res.status(404).json({ error: 'Vase not found' });
  if (vase.broken_by)   return res.status(400).json({ error: 'Already broken' });
  if (new Date(vase.expires_at) < new Date())
    return res.status(400).json({ error: 'Vase expired' });

  const LARGE_RADIUS = 500;
  const dist = haversine(parseFloat(lat), parseFloat(lng), vase.lat, vase.lng);
  if (dist > LARGE_RADIUS)
    return res.status(400).json({ error: `Подойди ближе (${Math.round(dist)}м > ${LARGE_RADIUS}м)` });

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

  // Roll and insert item
  const rolled = rollItem();
  const { data: newItem } = await supabase
    .from('items')
    .insert({
      type:        rolled.type,
      rarity:      rolled.rarity,
      name:        rolled.name,
      emoji:       rolled.emoji,
      stat_value:  rolled.stat,
      owner_id:    player.id,
      equipped:    false,
    })
    .select()
    .single();

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

  return res.json({
    diamonds:      vase.diamonds_reward,
    totalDiamonds: newDiamonds,
    item: newItem ? {
      id:         newItem.id,
      type:       rolled.type,
      rarity:     rolled.rarity,
      name:       rolled.name,
      emoji:      rolled.emoji,
      stat_value: rolled.stat,
    } : null,
  });
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
