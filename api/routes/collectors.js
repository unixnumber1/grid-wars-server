import { Router } from 'express';
import { supabase, getPlayerByTelegramId, sendTelegramNotification } from '../../lib/supabase.js';
import { haversine } from '../../lib/haversine.js';
import { getCellId, getCellCenter } from '../../lib/grid.js';
import { getMineIncome, SMALL_RADIUS, LARGE_RADIUS } from '../../lib/formulas.js';
import { gameState } from '../../lib/gameState.js';
import { io, connectedPlayers, lastAttackTime, logActivity } from '../../server.js';
import { addXp } from '../../lib/xp.js';
import { ts, getLang } from '../../config/i18n.js';
import {
  COLLECTOR_COST_DIAMONDS, COLLECTOR_SELL_DIAMONDS, COLLECTOR_RADIUS,
  COLLECTOR_DELIVERY_COMMISSION, COLLECTOR_LEVELS, COLLECTOR_EXTINGUISH_COST,
  COLLECTOR_MAX_MINE_LEVEL, getCollectorCapacity, getCollectorMines,
} from '../../lib/collectors.js';

export const collectorsRouter = Router();

const WEAPON_COOLDOWNS = { sword: 500, axe: 700, none: 200 };
const COURIER_SPEED_PLAYER = 0.0002; // 🚶 ~20 km/h (player courier = pedestrian)

function emitToNearbyPlayers(lat, lng, radiusM, event, data) {
  for (const [sid, info] of connectedPlayers) {
    if (!info.lat || !info.lng) continue;
    if (haversine(lat, lng, info.lat, info.lng) <= radiusM) io.to(sid).emit(event, data);
  }
}

collectorsRouter.post('/', async (req, res) => {
  const { action } = req.body || {};
  if (action === 'build') return handleBuild(req, res);
  if (action === 'upgrade') return handleUpgrade(req, res);
  if (action === 'deliver') return handleDeliver(req, res);
  if (action === 'sell') return handleSell(req, res);
  if (action === 'hit') return handleHit(req, res);
  if (action === 'extinguish') return handleExtinguish(req, res);
  if (action === 'set-mode') return handleSetMode(req, res);
  return res.status(400).json({ error: 'Unknown action' });
});

// ── BUILD ──
async function handleBuild(req, res) {
  const { telegram_id, lat, lng } = req.body || {};
  if (!telegram_id || lat == null || lng == null) return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  // Use tap coordinates (body.lat/lng) for distance check and placement
  const tapLat = parseFloat(lat), tapLng = parseFloat(lng);
  const lang = getLang(gameState, telegram_id);
  if (!player.last_lat) return res.status(400).json({ error: ts(lang, 'err.gps_not_ready') });

  // Distance check: player position to tap point
  const dist = haversine(player.last_lat, player.last_lng, tapLat, tapLng);
  if (dist > SMALL_RADIUS) return res.status(400).json({ error: ts(lang, 'err.too_far', { distance: Math.round(dist), radius: SMALL_RADIUS }) });

  // Check max collectors limit based on HQ level (lv/2 rounded down)
  const hq = gameState.getHqByPlayerId(player.id);
  const hqLevel = hq?.level || 1;
  const maxCollectors = Math.floor(hqLevel / 2);
  const currentCount = [...gameState.collectors.values()].filter(c => c.owner_id === player.id).length;
  if (currentCount >= maxCollectors)
    return res.status(400).json({ error: ts(lang, 'err.max_collectors', { max: maxCollectors, hqLevel }) });

  // Check diamonds
  if ((player.diamonds || 0) < COLLECTOR_COST_DIAMONDS)
    return res.status(400).json({ error: ts(lang, 'err.need_diamonds', { cost: COLLECTOR_COST_DIAMONDS }) });

  // Cell ID from tap coordinates
  const cellId = getCellId(tapLat, tapLng);

  // Check cell not occupied by ANY building type
  const cellOccupied =
    [...gameState.mines.values()].some(m => m.cell_id === cellId && m.status !== 'destroyed') ||
    [...gameState.headquarters.values()].some(h => h.cell_id === cellId) ||
    [...gameState.collectors.values()].some(c => c.cell_id === cellId) ||
    [...gameState.clanHqs.values()].some(c => c.cell_id === cellId) ||
    [...gameState.monuments.values()].some(m => m.cell_id === cellId);
  if (cellOccupied) return res.status(400).json({ error: ts(lang, 'err.cell_occupied') });

  // Check nearby mines of this player (using tap position)
  const nearbyMines = [];
  for (const m of gameState.mines.values()) {
    if (m.owner_id === player.id && m.status !== 'destroyed' && haversine(tapLat, tapLng, m.lat, m.lng) <= COLLECTOR_RADIUS) {
      nearbyMines.push(m);
    }
  }
  if (nearbyMines.length === 0) return res.status(400).json({ error: ts(lang, 'err.no_mines_nearby', { radius: COLLECTOR_RADIUS }) });

  // Deduct diamonds — read fresh from DB
  const { data: freshBuild } = await supabase.from('players').select('diamonds').eq('id', player.id).single();
  const actualDiamonds = freshBuild?.diamonds ?? player.diamonds ?? 0;
  if (actualDiamonds < COLLECTOR_COST_DIAMONDS) return res.status(400).json({ error: ts(lang, 'err.need_diamonds', { cost: COLLECTOR_COST_DIAMONDS }) });
  const newDiamonds = actualDiamonds - COLLECTOR_COST_DIAMONDS;
  player.diamonds = newDiamonds;
  gameState.markDirty('players', player.id);
  await supabase.from('players').update({ diamonds: newDiamonds }).eq('id', player.id);

  const cfg = COLLECTOR_LEVELS[1];
  const collector = {
    owner_id: player.id,
    lat: tapLat, lng: tapLng, cell_id: cellId,
    level: 1,
    hp: cfg.hp, max_hp: cfg.hp,
    stored_coins: 0,
    last_collected_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  const { data: inserted, error } = await supabase.from('collectors').insert(collector).select().single();
  if (error) return res.status(500).json({ error: error.message });

  gameState.collectors.set(inserted.id, inserted);
  logActivity(player.game_username, `built collector at ${tapLat.toFixed(4)},${tapLng.toFixed(4)}`);

  return res.json({ success: true, collector: inserted, diamonds: newDiamonds, mines_in_range: nearbyMines.length });
}

// ── UPGRADE ──
async function handleUpgrade(req, res) {
  const { telegram_id, collector_id } = req.body || {};
  if (!telegram_id || !collector_id) return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const collector = gameState.collectors.get(collector_id);
  if (!collector || collector.owner_id !== player.id) return res.status(404).json({ error: 'Collector not found' });
  const lang = getLang(gameState, telegram_id);
  if (collector.level >= 10) return res.status(400).json({ error: ts(lang, 'err.max_level') });

  const nextLevel = collector.level + 1;
  const diamondCosts = [0,0,30,50,75,100,130,160,200,250,300];
  const cost = diamondCosts[nextLevel] || 50;

  if ((player.diamonds || 0) < cost) return res.status(400).json({ error: ts(lang, 'err.need_diamonds', { cost }) });

  // Deduct diamonds
  const newDiamonds = (player.diamonds || 0) - cost;
  player.diamonds = newDiamonds;
  gameState.markDirty('players', player.id);
  await supabase.from('players').update({ diamonds: newDiamonds }).eq('id', player.id);

  const newCfg = COLLECTOR_LEVELS[nextLevel];
  collector.level = nextLevel;
  collector.max_hp = newCfg.hp;
  collector.hp = newCfg.hp;
  gameState.markDirty('collectors', collector.id);

  await supabase.from('collectors').update({ level: nextLevel, hp: newCfg.hp, max_hp: newCfg.hp }).eq('id', collector.id);

  return res.json({ success: true, level: nextLevel, hp: newCfg.hp, max_hp: newCfg.hp, diamonds: newDiamonds });
}

// ── DELIVER (order courier delivery to player) ──
async function handleDeliver(req, res) {
  const { telegram_id, collector_id } = req.body || {};
  if (!telegram_id || !collector_id) return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.last_lat || !player.last_lng) return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.gps_not_ready') });

  const collector = gameState.collectors.get(collector_id);
  if (!collector || collector.owner_id !== player.id) return res.status(404).json({ error: 'Collector not found' });
  if (collector.status === 'burning') return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.collector_burning') });
  if ((collector.stored_coins || 0) <= 0) return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.nothing_to_deliver') });

  const gross = collector.stored_coins;
  const commission = 0;
  const net = gross;

  // Clear collector storage
  collector.stored_coins = 0;
  gameState.markDirty('collectors', collector.id);

  // Create courier from collector to player position
  const nowISO = new Date().toISOString();
  const courier = {
    id: globalThis.crypto.randomUUID(),
    type: 'delivery',
    owner_id: player.id,
    item_id: null,
    listing_id: null,
    to_market_id: null,
    start_lat: collector.lat,
    start_lng: collector.lng,
    current_lat: collector.lat,
    current_lng: collector.lng,
    target_lat: player.last_lat,
    target_lng: player.last_lng,
    hp: 5000, max_hp: 5000,
    speed: COURIER_SPEED_PLAYER,
    status: 'moving',
    created_at: nowISO,
    // Store coins in courier for drop
    _coins: net,
  };

  const { data: insertedCourier, error: cErr } = await supabase.from('couriers').insert({
    type: courier.type, owner_id: courier.owner_id,
    start_lat: courier.start_lat, start_lng: courier.start_lng,
    current_lat: courier.current_lat, current_lng: courier.current_lng,
    target_lat: courier.target_lat, target_lng: courier.target_lng,
    hp: courier.hp, max_hp: courier.max_hp, speed: courier.speed, status: courier.status,
    created_at: nowISO,
  }).select().single();

  if (cErr) return res.status(500).json({ error: cErr.message });

  // Store coins amount in courier_drops metadata when it arrives
  // For now store in memory on the courier object
  const courierObj = { ...insertedCourier, _coins: net };
  gameState.upsertCourier(courierObj);

  // Persist collector coins=0
  await supabase.from('collectors').update({ stored_coins: 0 }).eq('id', collector.id);

  logActivity(player.game_username, `ordered delivery from collector (${net} coins)`);

  return res.json({ success: true, gross, commission, net, courier_id: insertedCourier.id });
}

// ── SELL ──
async function handleSell(req, res) {
  const { telegram_id, collector_id } = req.body || {};
  if (!telegram_id || !collector_id) return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const collector = gameState.collectors.get(collector_id);
  if (!collector || collector.owner_id !== player.id) return res.status(404).json({ error: 'Collector not found' });

  // Refund diamonds — read fresh from DB
  const { data: freshP } = await supabase.from('players').select('diamonds').eq('id', player.id).single();
  const newDiamonds = (freshP?.diamonds ?? player.diamonds ?? 0) + COLLECTOR_SELL_DIAMONDS;
  player.diamonds = newDiamonds;
  gameState.markDirty('players', player.id);

  // If has stored coins, add to player
  if (collector.stored_coins > 0) {
    player.coins = (player.coins || 0) + collector.stored_coins;
    gameState.markDirty('players', player.id);
    await supabase.from('players').update({ coins: player.coins, diamonds: newDiamonds }).eq('id', player.id);
  } else {
    await supabase.from('players').update({ diamonds: newDiamonds }).eq('id', player.id);
  }

  // Delete collector
  gameState.collectors.delete(collector.id);
  await supabase.from('collectors').delete().eq('id', collector.id);

  return res.json({ success: true, diamonds: newDiamonds, coins_returned: collector.stored_coins || 0 });
}

// ── HIT (attack enemy collector) ──
async function handleHit(req, res) {
  const { telegram_id, collector_id, lat, lng } = req.body || {};
  if (!telegram_id || !collector_id || lat == null || lng == null)
    return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const collector = gameState.collectors.get(collector_id);
  if (!collector) return res.status(404).json({ error: 'Collector not found' });
  const lang = getLang(gameState, telegram_id);
  if (collector.owner_id === player.id) return res.status(400).json({ error: ts(lang, 'err.cant_attack_own_collector') });
  if (collector.hp <= 0 || collector.status === 'burning') return res.status(400).json({ error: ts(lang, 'err.already_destroyed') });

  const pLat = parseFloat(lat), pLng = parseFloat(lng);
  const dist = haversine(pLat, pLng, collector.lat, collector.lng);
  if (dist > LARGE_RADIUS) return res.status(400).json({ error: ts(lang, 'err.too_far_short'), distance: Math.round(dist) });

  // Weapon cooldown
  const items = gameState.getPlayerItems(player.id);
  const weapon = items.find(i => (i.type === 'sword' || i.type === 'axe') && i.equipped);
  const weaponType = weapon ? weapon.type : 'none';
  const cooldownMs = WEAPON_COOLDOWNS[weaponType] ?? 0;
  const now = Date.now();
  const last = lastAttackTime.get(String(telegram_id)) || 0;
  if (now - last < cooldownMs) return res.status(429).json({ error: 'Cooldown' });
  lastAttackTime.set(String(telegram_id), now);

  // Calculate damage
  const baseDmg = 10 + (weapon?.attack || 0);
  const mul = 0.8 + Math.random() * 0.4;
  let damage = Math.round(baseDmg * mul);
  let isCrit = false;

  if (weapon?.type === 'sword') {
    const cc = weapon.crit_chance || 0;
    if (Math.random() * 100 < cc) {
      const wLvl = weapon.upgrade_level || 0;
      let cm = 1.5;
      if (weapon.rarity === 'mythic') cm = 1.5 + (wLvl / 90) * 0.7;
      else if (weapon.rarity === 'legendary') cm = 1.5 + (wLvl / 100) * 1.5;
      damage = Math.floor(damage * cm);
      isCrit = true;
    }
  }

  collector.hp = Math.max(0, collector.hp - damage);
  gameState.markDirty('collectors', collector.id);

  // Emit projectile
  emitToNearbyPlayers(collector.lat, collector.lng, 1000, 'projectile', {
    from_lat: pLat, from_lng: pLng,
    to_lat: collector.lat, to_lng: collector.lng,
    damage, crit: isCrit,
    target_type: 'collector', target_id: collector.id,
    weapon_type: weaponType,
    attacker_id: player.id,
  });

  emitToNearbyPlayers(collector.lat, collector.lng, 1000, 'collector:hp_update', {
    collector_id: collector.id, hp: collector.hp, max_hp: collector.max_hp,
  });

  let destroyed = false;
  let stolenCoins = 0;

  if (collector.hp <= 0) {
    destroyed = true;
    stolenCoins = collector.stored_coins || 0;
    const nowISO = new Date().toISOString();

    // Set burning status (24h to extinguish)
    collector.status = 'burning';
    collector.burning_started_at = nowISO;
    collector.stored_coins = 0;
    gameState.markDirty('collectors', collector.id);

    // Transfer coins to attacker
    if (stolenCoins > 0) {
      player.coins = (player.coins || 0) + stolenCoins;
      gameState.markDirty('players', player.id);
      await supabase.from('players').update({ coins: player.coins }).eq('id', player.id);
    }

    // Persist burning status immediately
    await supabase.from('collectors').update({
      hp: 0, status: 'burning', burning_started_at: nowISO, stored_coins: 0,
    }).eq('id', collector.id);

    // Notify owner
    const owner = gameState.getPlayerById(collector.owner_id);
    if (owner) {
      const ownerLang = owner.language || 'en';
      const msg = ts(ownerLang, 'notif.collector_burning', { coins: stolenCoins });
      const notif = {
        id: globalThis.crypto.randomUUID(),
        player_id: owner.id, type: 'collector_burning', message: msg, read: false,
        created_at: nowISO,
      };
      gameState.addNotification(notif);
      supabase.from('notifications').insert(notif).then(() => {}).catch(() => {});
      if (owner.telegram_id) sendTelegramNotification(owner.telegram_id, msg);
    }

    // Emit burning event
    emitToNearbyPlayers(collector.lat, collector.lng, 1000, 'collector:burning', {
      collector_id: collector.id,
      attacker_name: player.game_username || '?',
      stolen_coins: stolenCoins,
    });

    // XP
    try { await addXp(player.id, 100); } catch (_) {}

    logActivity(player.game_username, `burned collector (stole ${stolenCoins} coins)`);
  }

  return res.json({ damage, crit: isCrit, destroyed, stolen_coins: stolenCoins, hp: collector.hp, max_hp: collector.max_hp, status: collector.status });
}

// ── EXTINGUISH (put out burning collector) ──
async function handleExtinguish(req, res) {
  const { telegram_id, collector_id } = req.body || {};
  if (!telegram_id || !collector_id) return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const collector = gameState.collectors.get(collector_id);
  if (!collector || collector.owner_id !== player.id) return res.status(404).json({ error: 'Collector not found' });
  const lang = getLang(gameState, telegram_id);
  if (collector.status !== 'burning') return res.status(400).json({ error: ts(lang, 'err.not_burning') });

  // Check 24h not passed
  if (Date.now() - new Date(collector.burning_started_at).getTime() > 86400000) {
    gameState.collectors.delete(collector.id);
    await supabase.from('collectors').delete().eq('id', collector.id);
    return res.status(400).json({ error: ts(lang, 'err.too_late') });
  }

  // Check diamonds
  const cost = COLLECTOR_EXTINGUISH_COST;
  const { data: freshP } = await supabase.from('players').select('diamonds').eq('id', player.id).single();
  const actualDiamonds = freshP?.diamonds ?? player.diamonds ?? 0;
  if (actualDiamonds < cost) return res.status(400).json({ error: ts(lang, 'err.need_diamonds', { cost }) });

  // Deduct diamonds
  const newDiamonds = actualDiamonds - cost;
  player.diamonds = newDiamonds;
  gameState.markDirty('players', player.id);
  await supabase.from('players').update({ diamonds: newDiamonds }).eq('id', player.id);

  // Restore collector
  const cfg = COLLECTOR_LEVELS[collector.level] || COLLECTOR_LEVELS[1];
  const restoredHp = Math.round(cfg.hp * 0.25);
  collector.status = 'normal';
  collector.burning_started_at = null;
  collector.hp = restoredHp;
  gameState.markDirty('collectors', collector.id);

  await supabase.from('collectors').update({
    status: 'normal', burning_started_at: null, hp: restoredHp,
  }).eq('id', collector.id);

  return res.json({ success: true, hp: restoredHp, max_hp: cfg.hp, diamonds: newDiamonds });
}

// ── SET MODE (collect or upgrade) ──
async function handleSetMode(req, res) {
  const { telegram_id, collector_id, mode } = req.body || {};
  if (!telegram_id || !collector_id || !mode) return res.status(400).json({ error: 'Missing fields' });
  if (mode !== 'collect' && mode !== 'upgrade') return res.status(400).json({ error: 'Invalid mode' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const collector = gameState.collectors.get(collector_id);
  if (!collector || collector.owner_id !== player.id) return res.status(404).json({ error: 'Collector not found' });

  collector.mode = mode;
  gameState.markDirty('collectors', collector.id);
  await supabase.from('collectors').update({ mode }).eq('id', collector.id);

  return res.json({ success: true, mode });
}
