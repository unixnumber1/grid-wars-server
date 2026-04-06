import { Router } from 'express';
import { supabase, getPlayerByTelegramId, sendTelegramNotification, buildAttackButton } from '../../lib/supabase.js';
import { haversine } from '../../lib/haversine.js';
import { getCellId } from '../../lib/grid.js';
import { gameState } from '../../lib/gameState.js';
import { io, connectedPlayers, lastAttackTime, recordAttack, logActivity } from '../../server.js';
import { addXp } from '../../lib/xp.js';
import { ts, getLang } from '../../config/i18n.js';
import { SMALL_RADIUS, LARGE_RADIUS, WEAPON_COOLDOWNS } from '../../config/constants.js';
import { distanceMultiplier } from '../../lib/formulas.js';
import { getPlayerSkillEffects, isInShadow } from '../../config/skills.js';
import {
  FIRETRUCK_BUILD_COST, FIRETRUCK_COOLDOWN_MS, FIRETRUCK_LEVELS,
  FIREFIGHTER_HP, FIREFIGHTER_SPEED,
  getMaxFireTrucks, getSellRefundDiamonds,
  getBurningBuildingsInRadius, getExtinguishCost, getFireTruckRadius,
} from '../../game/mechanics/fireTrucks.js';
export const fireTrucksRouter = Router();

function emitToNearbyPlayers(lat, lng, radiusM, event, data) {
  for (const [sid, info] of connectedPlayers) {
    if (!info.lat || !info.lng) continue;
    if (haversine(lat, lng, info.lat, info.lng) <= radiusM) io.to(sid).emit(event, data);
  }
}

fireTrucksRouter.post('/', async (req, res) => {
  const { action } = req.body || {};
  if (action === 'build') return handleBuild(req, res);
  if (action === 'upgrade') return handleUpgrade(req, res);
  if (action === 'sell') return handleSell(req, res);
  if (action === 'hit') return handleHit(req, res);
  if (action === 'dispatch') return handleDispatch(req, res);
  if (action === 'extinguish-self') return handleExtinguishSelf(req, res);
  if (action === 'hit-firefighter') return handleHitFirefighter(req, res);
  return res.status(400).json({ error: 'Unknown action' });
});

// ── BUILD ──
async function handleBuild(req, res) {
  const { telegram_id, lat, lng } = req.body || {};
  if (!telegram_id || lat == null || lng == null) return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const tapLat = parseFloat(lat), tapLng = parseFloat(lng);
  const lang = getLang(gameState, telegram_id);
  if (!player.last_lat) return res.status(400).json({ error: ts(lang, 'err.gps_not_ready') });

  const dist = haversine(player.last_lat, player.last_lng, tapLat, tapLng);
  if (dist > SMALL_RADIUS) return res.status(400).json({ error: ts(lang, 'err.too_far', { distance: Math.round(dist), radius: SMALL_RADIUS }) });

  // Check HQ level and max fire trucks
  const hq = gameState.getHqByPlayerId(player.id);
  const hqLevel = hq?.level || 1;
  const maxTrucks = getMaxFireTrucks(hqLevel);
  if (maxTrucks === 0) return res.status(400).json({ error: ts(lang, 'err.hq_level_required', { level: 5 }) });

  const currentCount = [...gameState.fireTrucks.values()].filter(ft => ft.owner_id === player.id && ft.status !== 'destroyed').length;
  if (currentCount >= maxTrucks) return res.status(400).json({ error: ts(lang, 'err.max_fire_trucks', { max: maxTrucks }) });

  // Check diamonds
  if ((player.diamonds || 0) < FIRETRUCK_BUILD_COST)
    return res.status(400).json({ error: ts(lang, 'err.need_diamonds', { cost: FIRETRUCK_BUILD_COST }) });

  // Cell occupation check
  const cellId = getCellId(tapLat, tapLng);
  const cellOccupied =
    [...gameState.mines.values()].some(m => m.cell_id === cellId && m.status !== 'destroyed') ||
    [...gameState.headquarters.values()].some(h => h.cell_id === cellId) ||
    [...gameState.collectors.values()].some(c => c.cell_id === cellId) ||
    [...gameState.clanHqs.values()].some(c => c.cell_id === cellId) ||
    [...gameState.monuments.values()].some(m => m.cell_id === cellId) ||
    [...gameState.fireTrucks.values()].some(ft => ft.cell_id === cellId && ft.status !== 'destroyed');
  if (cellOccupied) return res.status(400).json({ error: ts(lang, 'err.cell_occupied') });

  // Deduct diamonds — read fresh from DB with optimistic lock
  const { data: freshP } = await supabase.from('players').select('diamonds').eq('id', player.id).single();
  const actualDiamonds = freshP?.diamonds ?? player.diamonds ?? 0;
  if (actualDiamonds < FIRETRUCK_BUILD_COST) return res.status(400).json({ error: ts(lang, 'err.need_diamonds', { cost: FIRETRUCK_BUILD_COST }) });
  const newDiamonds = actualDiamonds - FIRETRUCK_BUILD_COST;
  const { data: diamOk } = await supabase.from('players').update({ diamonds: newDiamonds }).eq('id', player.id).eq('diamonds', actualDiamonds).select('id').maybeSingle();
  if (!diamOk) return res.status(409).json({ error: ts(lang, 'err.conflict') });
  if (gameState.loaded) { const gp = gameState.getPlayerById(player.id); if (gp) { gp.diamonds = newDiamonds; gameState.markDirty('players', gp.id); } }

  const cfg = FIRETRUCK_LEVELS[1];
  const fireTruck = {
    owner_id: player.id,
    lat: tapLat, lng: tapLng, cell_id: cellId,
    level: 1,
    hp: cfg.hp, max_hp: cfg.hp,
    status: 'normal',
    created_at: new Date().toISOString(),
  };

  const { data: inserted, error } = await supabase.from('fire_trucks').insert(fireTruck).select().single();
  if (error) return res.status(500).json({ error: error.message });

  gameState.fireTrucks.set(inserted.id, inserted);
  logActivity(player.game_username, `built fire truck at ${tapLat.toFixed(4)},${tapLng.toFixed(4)}`);

  return res.json({ success: true, fire_truck: inserted, diamonds: newDiamonds });
}

// ── UPGRADE ──
async function handleUpgrade(req, res) {
  const { telegram_id, fire_truck_id } = req.body || {};
  if (!telegram_id || !fire_truck_id) return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const truck = gameState.fireTrucks.get(fire_truck_id);
  if (!truck || truck.owner_id !== player.id) return res.status(404).json({ error: 'Fire truck not found' });
  const lang = getLang(gameState, telegram_id);
  if (truck.level >= 10) return res.status(400).json({ error: ts(lang, 'err.max_level') });

  const nextLevel = truck.level + 1;
  const cost = FIRETRUCK_LEVELS[nextLevel].upgradeCost;

  const { data: freshP } = await supabase.from('players').select('diamonds').eq('id', player.id).single();
  const actualDiamonds = freshP?.diamonds ?? player.diamonds ?? 0;
  if (actualDiamonds < cost) return res.status(400).json({ error: ts(lang, 'err.need_diamonds', { cost }) });

  const newDiamonds = actualDiamonds - cost;
  const { data: diamOk } = await supabase.from('players').update({ diamonds: newDiamonds }).eq('id', player.id).eq('diamonds', actualDiamonds).select('id').maybeSingle();
  if (!diamOk) return res.status(409).json({ error: ts(lang, 'err.conflict') });
  if (gameState.loaded) { const gp = gameState.getPlayerById(player.id); if (gp) { gp.diamonds = newDiamonds; gameState.markDirty('players', gp.id); } }

  const newCfg = FIRETRUCK_LEVELS[nextLevel];
  truck.level = nextLevel;
  truck.max_hp = newCfg.hp;
  truck.hp = newCfg.hp;
  gameState.markDirty('fireTrucks', truck.id);

  await supabase.from('fire_trucks').update({ level: nextLevel, hp: newCfg.hp, max_hp: newCfg.hp }).eq('id', truck.id);

  return res.json({ success: true, level: nextLevel, hp: newCfg.hp, max_hp: newCfg.hp, diamonds: newDiamonds, radius: newCfg.radius });
}

// ── SELL ──
async function handleSell(req, res) {
  const { telegram_id, fire_truck_id } = req.body || {};
  if (!telegram_id || !fire_truck_id) return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const truck = gameState.fireTrucks.get(fire_truck_id);
  if (!truck || truck.owner_id !== player.id) return res.status(404).json({ error: 'Fire truck not found' });

  const refund = getSellRefundDiamonds(truck.level);
  const { data: freshP } = await supabase.from('players').select('diamonds').eq('id', player.id).single();
  const newDiamonds = (freshP?.diamonds ?? player.diamonds ?? 0) + refund;
  player.diamonds = newDiamonds;
  gameState.markDirty('players', player.id);
  await supabase.from('players').update({ diamonds: newDiamonds }).eq('id', player.id);

  // Kill active firefighters from this truck
  for (const [id, ff] of gameState.firefighters) {
    if (ff.truck_id === truck.id) gameState.firefighters.delete(id);
  }

  gameState.fireTrucks.delete(truck.id);
  await supabase.from('fire_trucks').delete().eq('id', truck.id);

  logActivity(player.game_username, `sold fire truck lv${truck.level} (refund ${refund} diamonds)`);
  return res.json({ success: true, diamonds: newDiamonds, refund });
}

// ── HIT (attack enemy fire truck) ──
async function handleHit(req, res) {
  const { telegram_id, fire_truck_id, lat, lng } = req.body || {};
  if (!telegram_id || !fire_truck_id || lat == null || lng == null)
    return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const truck = gameState.fireTrucks.get(fire_truck_id);
  if (!truck) return res.status(404).json({ error: 'Fire truck not found' });
  const lang = getLang(gameState, telegram_id);
  if (truck.owner_id === player.id) return res.status(400).json({ error: ts(lang, 'err.cant_attack_own') });
  if (truck.hp <= 0 || truck.status === 'burning') return res.status(400).json({ error: ts(lang, 'err.already_destroyed') });

  const pLat = parseFloat(lat), pLng = parseFloat(lng);
  const dist = haversine(pLat, pLng, truck.lat, truck.lng);
  const _skFx = getPlayerSkillEffects(gameState.getPlayerSkills(telegram_id));
  if (dist > LARGE_RADIUS + (_skFx.attack_radius_bonus || 0)) return res.status(400).json({ error: ts(lang, 'err.too_far_short'), distance: Math.round(dist) });

  // Weapon cooldown
  const items = gameState.getPlayerItems(player.id);
  const weapon = items.find(i => (i.type === 'sword' || i.type === 'axe') && i.equipped);
  const weaponType = weapon ? weapon.type : 'none';
  const cooldownMs = WEAPON_COOLDOWNS[weaponType] ?? 0;
  const now = Date.now();
  const last = lastAttackTime.get(String(telegram_id)) || 0;
  if (now - last < cooldownMs) return res.status(429).json({ error: 'Cooldown' });
  recordAttack(telegram_id, now);

  // Calculate damage
  const baseDmg = 10 + (weapon?.attack || 0);
  const mul = distanceMultiplier(dist, LARGE_RADIUS);
  let damage = Math.round(baseDmg * mul);
  if (_skFx.weapon_damage_bonus) damage = Math.round(damage * (1 + _skFx.weapon_damage_bonus));
  let isCrit = false;

  if (weapon?.type === 'sword') {
    const cc = (weapon.crit_chance || 0) + (_skFx.crit_chance_bonus || 0) * 100;
    if (Math.random() * 100 < cc) {
      const wLvl = weapon.upgrade_level || 0;
      let cm = 1.5;
      if (weapon.rarity === 'mythic') cm = 1.5 + (wLvl / 90) * 0.7;
      else if (weapon.rarity === 'legendary') cm = 1.5 + (wLvl / 100) * 1.5;
      damage = Math.floor(damage * cm);
      isCrit = true;
    }
  }

  truck.hp = Math.max(0, truck.hp - damage);
  gameState.markDirty('fireTrucks', truck.id);

  // Emit projectile
  emitToNearbyPlayers(truck.lat, truck.lng, 1000, 'projectile', {
    from_lat: pLat, from_lng: pLng,
    to_lat: truck.lat, to_lng: truck.lng,
    damage, crit: isCrit,
    target_type: 'fire_truck', target_id: truck.id,
    weapon_type: weaponType,
    attacker_id: isInShadow(player) ? 0 : player.id,
  });

  emitToNearbyPlayers(truck.lat, truck.lng, 1000, 'firetruck:hp_update', {
    fire_truck_id: truck.id, hp: truck.hp, max_hp: truck.max_hp,
  });

  let destroyed = false;
  const _ftShadow = isInShadow(player);

  if (truck.hp <= 0) {
    destroyed = true;
    const nowISO = new Date().toISOString();

    truck.status = 'burning';
    truck.burning_started_at = nowISO;
    gameState.markDirty('fireTrucks', truck.id);

    await supabase.from('fire_trucks').update({
      hp: 0, status: 'burning', burning_started_at: nowISO,
    }).eq('id', truck.id);

    // Notify owner
    const owner = gameState.getPlayerById(truck.owner_id);
    if (owner) {
      const ownerLang = owner.language || 'en';
      const msg = ts(ownerLang, 'notif.firetruck_burning');
      const notif = {
        id: globalThis.crypto.randomUUID(),
        player_id: owner.id, type: 'firetruck_burning', message: msg, read: false,
        created_at: nowISO,
      };
      gameState.addNotification(notif);
      supabase.from('notifications').insert(notif).then(() => {}).catch(e => console.error('[fireTrucks] error:', e.message));
      if (owner.telegram_id) sendTelegramNotification(owner.telegram_id, msg, buildAttackButton(truck.lat, truck.lng));
    }

    emitToNearbyPlayers(truck.lat, truck.lng, 1000, 'firetruck:burning', {
      fire_truck_id: truck.id,
      attacker_name: _ftShadow ? '???' : (player.game_username || '?'),
    });

    try { await addXp(player.id, 100); } catch (_) {}
    logActivity(player.game_username, `burned fire truck lv${truck.level}`);
  }

  return res.json({ damage, crit: isCrit, destroyed, hp: truck.hp, max_hp: truck.max_hp, status: truck.status });
}

// ── DISPATCH (send firefighters to extinguish burning buildings) ──
async function handleDispatch(req, res) {
  const { telegram_id, fire_truck_id } = req.body || {};
  if (!telegram_id || !fire_truck_id) return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const truck = gameState.fireTrucks.get(fire_truck_id);
  if (!truck || truck.owner_id !== player.id) return res.status(404).json({ error: 'Fire truck not found' });
  const lang = getLang(gameState, telegram_id);
  if (truck.status !== 'normal') return res.status(400).json({ error: ts(lang, 'err.truck_not_operational') });

  // Cooldown check
  const now = Date.now();
  if (truck.last_extinguish_at && now - new Date(truck.last_extinguish_at).getTime() < FIRETRUCK_COOLDOWN_MS) {
    const remaining = Math.ceil((FIRETRUCK_COOLDOWN_MS - (now - new Date(truck.last_extinguish_at).getTime())) / 60000);
    return res.status(400).json({ error: ts(lang, 'err.firetruck_cooldown', { minutes: remaining }) });
  }

  // Find burning buildings in radius
  const burningBuildings = getBurningBuildingsInRadius(truck);
  if (burningBuildings.length === 0) return res.status(400).json({ error: ts(lang, 'err.no_burning_buildings') });

  // Calculate coin cost
  const coinsCost = getExtinguishCost(burningBuildings);

  // Check coins
  if (coinsCost > 0) {
    const { data: freshP } = await supabase.from('players').select('coins').eq('id', player.id).single();
    const actualCoins = Number(freshP?.coins ?? player.coins ?? 0);
    if (actualCoins < coinsCost) return res.status(400).json({ error: ts(lang, 'err.not_enough_coins', { cost: coinsCost }) });

    // Deduct coins immediately
    const newCoins = actualCoins - coinsCost;
    player.coins = newCoins;
    gameState.markDirty('players', player.id);
    await supabase.from('players').update({ coins: newCoins }).eq('id', player.id);
  }

  // Set cooldown
  const nowISO = new Date().toISOString();
  truck.last_extinguish_at = nowISO;
  gameState.markDirty('fireTrucks', truck.id);
  await supabase.from('fire_trucks').update({ last_extinguish_at: nowISO }).eq('id', truck.id);

  // Spawn firefighters
  const firefighters = [];
  for (const building of burningBuildings) {
    const ff = {
      id: globalThis.crypto.randomUUID(),
      truck_id: truck.id,
      owner_id: truck.owner_id,
      origin_lat: truck.lat, origin_lng: truck.lng,
      current_lat: truck.lat, current_lng: truck.lng,
      target_lat: building.lat, target_lng: building.lng,
      target_type: building.type,
      target_id: building.id,
      hp: FIREFIGHTER_HP, max_hp: FIREFIGHTER_HP,
      speed: FIREFIGHTER_SPEED,
      phase: 'going',
      created_at: nowISO,
    };
    gameState.firefighters.set(ff.id, ff);
    firefighters.push(ff);
  }

  // Emit spawned events
  for (const ff of firefighters) {
    emitToNearbyPlayers(truck.lat, truck.lng, 1000, 'firefighter:spawned', ff);
  }

  logActivity(player.game_username, `dispatched ${firefighters.length} firefighters (cost ${coinsCost} coins)`);

  return res.json({
    success: true,
    coins_spent: coinsCost,
    firefighters_count: firefighters.length,
    cooldown_until: new Date(now + FIRETRUCK_COOLDOWN_MS).toISOString(),
  });
}

// ── EXTINGUISH-SELF (manual extinguish of own burning truck) ──
async function handleExtinguishSelf(req, res) {
  const { telegram_id, fire_truck_id, lat, lng } = req.body || {};
  if (!telegram_id || !fire_truck_id) return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const truck = gameState.fireTrucks.get(fire_truck_id);
  if (!truck || truck.owner_id !== player.id) return res.status(404).json({ error: 'Fire truck not found' });
  const lang = getLang(gameState, telegram_id);
  if (truck.status !== 'burning') return res.status(400).json({ error: ts(lang, 'err.not_burning') });

  // Check 24h not passed
  if (Date.now() - new Date(truck.burning_started_at).getTime() > 86400000) {
    gameState.fireTrucks.delete(truck.id);
    await supabase.from('fire_trucks').delete().eq('id', truck.id);
    return res.status(400).json({ error: ts(lang, 'err.too_late') });
  }

  // Check: either player is within 200m OR another truck covers this one
  const pLat = parseFloat(lat), pLng = parseFloat(lng);
  let canExtinguish = false;

  // Manual: player within 200m
  if (pLat && pLng && haversine(pLat, pLng, truck.lat, truck.lng) <= SMALL_RADIUS) {
    canExtinguish = true;
  }

  // OR: another non-burning truck of same owner covers this truck
  if (!canExtinguish) {
    for (const otherTruck of gameState.fireTrucks.values()) {
      if (otherTruck.id === truck.id) continue;
      if (otherTruck.owner_id !== truck.owner_id) continue;
      if (otherTruck.status !== 'normal') continue;
      const radius = getFireTruckRadius(otherTruck.level);
      if (haversine(otherTruck.lat, otherTruck.lng, truck.lat, truck.lng) <= radius) {
        canExtinguish = true;
        break;
      }
    }
  }

  if (!canExtinguish) return res.status(400).json({ error: ts(lang, 'err.too_far', { distance: 0, radius: SMALL_RADIUS }) });

  // Restore truck (free, 25% HP)
  const cfg = FIRETRUCK_LEVELS[truck.level] || FIRETRUCK_LEVELS[1];
  const restoredHp = Math.round(cfg.hp * 0.25);
  truck.status = 'normal';
  truck.burning_started_at = null;
  truck.hp = restoredHp;
  gameState.markDirty('fireTrucks', truck.id);

  await supabase.from('fire_trucks').update({
    status: 'normal', burning_started_at: null, hp: restoredHp,
  }).eq('id', truck.id);

  return res.json({ success: true, hp: restoredHp, max_hp: cfg.hp });
}

// ── HIT-FIREFIGHTER (attack enemy firefighter) ──
async function handleHitFirefighter(req, res) {
  const { telegram_id, firefighter_id, lat, lng } = req.body || {};
  if (!telegram_id || !firefighter_id || lat == null || lng == null)
    return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const ff = gameState.firefighters.get(firefighter_id);
  if (!ff) return res.status(404).json({ error: 'Firefighter not found' });
  const lang = getLang(gameState, telegram_id);
  if (ff.owner_id === player.id) return res.status(400).json({ error: ts(lang, 'err.cant_attack_own') });

  const pLat = parseFloat(lat), pLng = parseFloat(lng);
  const dist = haversine(pLat, pLng, ff.current_lat, ff.current_lng);
  if (dist > LARGE_RADIUS) return res.status(400).json({ error: ts(lang, 'err.too_far_short'), distance: Math.round(dist) });

  // Weapon cooldown
  const items = gameState.getPlayerItems(player.id);
  const weapon = items.find(i => (i.type === 'sword' || i.type === 'axe') && i.equipped);
  const weaponType = weapon ? weapon.type : 'none';
  const cooldownMs = WEAPON_COOLDOWNS[weaponType] ?? 0;
  const now = Date.now();
  const last = lastAttackTime.get(String(telegram_id)) || 0;
  if (now - last < cooldownMs) return res.status(429).json({ error: 'Cooldown' });
  recordAttack(telegram_id, now);

  // Calculate damage
  const _skFx = getPlayerSkillEffects(gameState.getPlayerSkills(telegram_id));
  const baseDmg = 10 + (weapon?.attack || 0);
  const mul = 0.8 + Math.random() * 0.4;
  let damage = Math.round(baseDmg * mul);
  if (_skFx.weapon_damage_bonus) damage = Math.round(damage * (1 + _skFx.weapon_damage_bonus));
  let isCrit = false;

  if (weapon?.type === 'sword') {
    const cc = (weapon.crit_chance || 0) + (_skFx.crit_chance_bonus || 0) * 100;
    if (Math.random() * 100 < cc) {
      const wLvl = weapon.upgrade_level || 0;
      let cm = 1.5;
      if (weapon.rarity === 'mythic') cm = 1.5 + (wLvl / 90) * 0.7;
      else if (weapon.rarity === 'legendary') cm = 1.5 + (wLvl / 100) * 1.5;
      damage = Math.floor(damage * cm);
      isCrit = true;
    }
  }

  ff.hp = Math.max(0, ff.hp - damage);

  // Emit projectile
  emitToNearbyPlayers(ff.current_lat, ff.current_lng, 1000, 'projectile', {
    from_lat: pLat, from_lng: pLng,
    to_lat: ff.current_lat, to_lng: ff.current_lng,
    damage, crit: isCrit,
    target_type: 'firefighter', target_id: ff.id,
    weapon_type: weaponType,
    attacker_id: isInShadow(player) ? 0 : player.id,
  });

  let killed = false;
  if (ff.hp <= 0) {
    killed = true;
    gameState.firefighters.delete(ff.id);

    emitToNearbyPlayers(ff.current_lat, ff.current_lng, 1000, 'firefighter:killed', {
      firefighter_id: ff.id,
      attacker_name: isInShadow(player) ? '???' : (player.game_username || '?'),
    });

    logActivity(player.game_username, `killed firefighter`);
  } else {
    emitToNearbyPlayers(ff.current_lat, ff.current_lng, 1000, 'firefighter:hp_update', {
      firefighter_id: ff.id, hp: ff.hp, max_hp: ff.max_hp,
    });
  }

  return res.json({ damage, crit: isCrit, killed, hp: ff.hp, max_hp: ff.max_hp });
}
