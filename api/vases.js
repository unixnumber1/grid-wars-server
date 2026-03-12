import { supabase, getPlayerByTelegramId } from '../lib/supabase.js';
import { haversine } from '../lib/haversine.js';
import { spawnVasesForAllHQs } from '../lib/vases.js';
import { rollVaseItem } from '../lib/items.js';
import { addXp, XP_REWARDS } from '../lib/xp.js';

const ADMIN_TG_ID = 560013667;

// ── SPAWN (admin only) — one vase per HQ ────────────────────────────────────
async function handleSpawn(req, res) {
  const { telegram_id } = req.body;
  if (parseInt(telegram_id, 10) !== ADMIN_TG_ID)
    return res.status(403).json({ error: 'Forbidden' });

  // Delete all old vases, spawn new wave
  await supabase.from('vases').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  const spawned = await spawnVasesForAllHQs(supabase);

  await supabase.from('app_settings')
    .upsert({ key: 'last_vases_spawn', value: Date.now().toString() }, { onConflict: 'key' });
  return res.json({ spawned });
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

  const BREAK_RADIUS = 200;
  const dist = haversine(parseFloat(lat), parseFloat(lng), vase.lat, vase.lng);
  if (dist > BREAK_RADIUS)
    return res.status(400).json({ error: 'Ваза слишком далеко! Подойди ближе (200м)' });

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

  // Roll and insert item — try with new columns, fallback without
  const rolled = rollVaseItem();
  const insertBase = {
    type:       rolled.type,
    rarity:     rolled.rarity,
    name:       rolled.name,
    emoji:      rolled.emoji,
    stat_value: rolled.stat_value,
    owner_id:   player.id,
    equipped:   false,
  };
  const insertFull = {
    ...insertBase,
    attack:      rolled.attack || 0,
    crit_chance: rolled.crit_chance || 0,
    defense:     rolled.defense || 0,
  };

  let { data: newItem } = await supabase
    .from('items').insert(insertFull).select().single();
  if (!newItem) {
    ({ data: newItem } = await supabase
      .from('items').insert(insertBase).select().single());
  }

  // Award XP for breaking vase
  let xpResult = null;
  try {
    xpResult = await addXp(player.id, XP_REWARDS.BREAK_VASE);
  } catch (e) {
    console.error('[vases] XP ERROR:', e.message);
  }

  return res.json({
    diamonds:      vase.diamonds_reward,
    totalDiamonds: newDiamonds,
    xp:            xpResult,
    item: newItem ? {
      id:          newItem.id,
      type:        rolled.type,
      rarity:      rolled.rarity,
      name:        rolled.name,
      emoji:       rolled.emoji,
      stat_value:  rolled.stat_value,
      attack:      rolled.attack || 0,
      crit_chance: rolled.crit_chance || 0,
      defense:     rolled.defense || 0,
    } : null,
  });
}

// ── CRON (Vercel cron, GET /api/vases) ─────────────────────────────────────
async function handleCron(req, res) {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).json({ error: 'Unauthorized' });

  // Delete ALL old vases — new wave replaces everything
  await supabase.from('vases').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  const spawned = await spawnVasesForAllHQs(supabase);

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
