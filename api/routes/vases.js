import { Router } from 'express';
import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { haversine } from '../../lib/haversine.js';
import { logPlayer } from '../../lib/logger.js';
import { spawnVasesForCity } from '../../game/mechanics/vases.js';
import { rollVaseItem } from '../../lib/items.js';
import { addXp, XP_REWARDS } from '../../lib/xp.js';
import { gameState } from '../../lib/gameState.js';
import { ts, getLang } from '../../config/i18n.js';
import { getAllCityKeys, getCityBounds, getCityPlayerCount } from '../../lib/geocity.js';

export const vasesRouter = Router();

const ADMIN_TG_ID = 560013667;

// ── SPAWN (admin only) — one vase per HQ ────────────────────────────────────
async function handleSpawn(req, res) {
  const { telegram_id } = req.body;
  if (parseInt(telegram_id, 10) !== ADMIN_TG_ID)
    return res.status(403).json({ error: 'Forbidden' });

  // Delete expired/broken vases, spawn fresh wave for all cities
  const nowISO = new Date().toISOString();
  await Promise.all([
    supabase.from('vases').delete().not('broken_by', 'is', null),
    supabase.from('vases').delete().lt('expires_at', nowISO),
  ]);
  if (gameState.loaded) {
    for (const [id, v] of gameState.vases) {
      if (v.broken_by || new Date(v.expires_at) <= new Date()) gameState.vases.delete(id);
    }
  }

  let totalSpawned = 0;
  const cityKeys = getAllCityKeys();
  for (const cityKey of cityKeys) {
    const pc = Math.max(getCityPlayerCount(cityKey), 1); // at least 1 to ensure spawn
    const cb = await getCityBounds(cityKey);
    if (!cb?.boundingbox) continue;
    totalSpawned += await spawnVasesForCity(cityKey, cb.boundingbox, pc);
  }

  await supabase.from('app_settings')
    .upsert({ key: 'last_vases_spawn', value: Date.now().toString() }, { onConflict: 'key' });
  return res.json({ spawned: totalSpawned });
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

  // Use server-side position for distance check (prevent position spoofing)
  const gsPlayer = gameState.getPlayerByTgId(Number(telegram_id));
  if (!gsPlayer?.last_lat || !gsPlayer?.last_lng) return res.status(400).json({ error: 'Position unknown' });
  const BREAK_RADIUS = 200;
  const dist = haversine(gsPlayer.last_lat, gsPlayer.last_lng, vase.lat, vase.lng);
  if (dist > BREAK_RADIUS)
    return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.vase_too_far', { radius: BREAK_RADIUS }) });

  // Mark vase as broken first (optimistic lock — only succeeds if not yet broken)
  const { data: vaseLocked } = await supabase.from('vases')
    .update({ broken_by: player.id, broken_at: new Date().toISOString() })
    .eq('id', vase_id).is('broken_by', null)
    .select('id').maybeSingle();
  if (!vaseLocked) return res.status(400).json({ error: 'Already broken' });

  // Update gameState
  if (gameState.loaded) {
    const gv = gameState.vases.get(vase_id);
    if (gv) { gv.broken_by = player.id; gameState.markDirty('vases', vase_id); }
  }

  // Award diamonds (optimistic lock to prevent double-credit)
  const { data: freshP } = await supabase.from('players').select('diamonds').eq('id', player.id).single();
  const oldDiamonds = freshP?.diamonds ?? player.diamonds ?? 0;
  const newDiamonds = oldDiamonds + vase.diamonds_reward;
  const { data: diamOk } = await supabase.from('players')
    .update({ diamonds: newDiamonds })
    .eq('id', player.id).eq('diamonds', oldDiamonds)
    .select('id').maybeSingle();
  if (!diamOk) console.error('[vase] diamond update conflict for', player.id);
  logPlayer(telegram_id, 'action', `Разбил вазу (+${vase.diamonds_reward}💎)`, { diamonds: vase.diamonds_reward });

  if (gameState.loaded) {
    const gp = gameState.getPlayerById(player.id);
    if (gp) { gp.diamonds = newDiamonds; gameState.markDirty('players', gp.id); }
  }

  // Roll and insert item (skip if inventory full)
  const { hasInventorySpace } = await import('../../game/mechanics/items.js');
  const inventoryFull = gameState.loaded && !hasInventorySpace(gameState, player.id);
  const rolled = !inventoryFull ? rollVaseItem() : null;
  let newItem = null;
  if (rolled) {
    const insertBase = {
      type:       rolled.type,
      rarity:     rolled.rarity,
      name:       rolled.name,
      emoji:      rolled.emoji,
      stat_value: rolled.stat_value,
      owner_id:   player.id,
      equipped:   false,
      plus: 0,
    };
    const insertFull = {
      ...insertBase,
      attack:      rolled.attack || 0,
      crit_chance: rolled.crit_chance || 0,
      defense:     rolled.defense || 0,
      base_attack: rolled.base_attack || 0,
      base_crit_chance: rolled.base_crit_chance || 0,
      base_defense: rolled.base_defense || 0,
      block_chance: rolled.block_chance || 0,
      upgrade_level: 0, plus: 0,
    };

    ({ data: newItem } = await supabase
      .from('items').insert(insertFull).select().single());
    if (!newItem) {
      ({ data: newItem } = await supabase
        .from('items').insert(insertBase).select().single());
    }
    if (gameState.loaded && newItem) gameState.upsertItem(newItem);
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

// ── CRON (GET /api/vases) ─────────────────────────────────────
async function handleCron(req, res) {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).json({ error: 'Unauthorized' });

  // Delete ALL old vases — new wave replaces everything
  await supabase.from('vases').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (gameState.loaded) gameState.clearAllVases();

  let spawned = 0;
  const cityKeys = getAllCityKeys();
  for (const cityKey of cityKeys) {
    const pc = Math.max(getCityPlayerCount(cityKey), 1);
    const cb = await getCityBounds(cityKey);
    if (!cb?.boundingbox) continue;
    spawned += await spawnVasesForCity(cityKey, cb.boundingbox, pc);
  }

  await supabase.from('app_settings')
    .upsert({ key: 'last_vases_spawn', value: Date.now().toString() }, { onConflict: 'key' });

  // Notify online players
  const onlineThreshold = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const { data: online } = await supabase
    .from('players').select('telegram_id')
    .gte('last_seen', onlineThreshold)
    .limit(1000);

  for (const p of (online || [])) {
    fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: p.telegram_id,
        text: ts(getLang(gameState, p.telegram_id), 'notif.vases_spawned'),
      }),
    }).catch(e => console.error('[vases] error:', e.message));
  }

  return res.json({ success: true, spawned });
}

// ── ROUTES ──────────────────────────────────────────────────────────────────
vasesRouter.get('/', handleCron);

vasesRouter.post('/', async (req, res) => {
  const { action } = req.body || {};
  if (action === 'spawn') return handleSpawn(req, res);
  if (action === 'break') return handleBreak(req, res);
  return res.status(400).json({ error: `Unknown action: ${action}` });
});
