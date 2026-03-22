import { Router } from 'express';
import { supabase } from '../../lib/supabase.js';
import { haversine } from '../../lib/haversine.js';
import { LARGE_RADIUS } from '../../lib/formulas.js';
import { addXp } from '../../lib/xp.js';
import { gameState } from '../../lib/gameState.js';
import { io, connectedPlayers, lastAttackTime } from '../../server.js';
import { ts, getLang } from '../../config/i18n.js';
import {
  getZombieXp, getZombieBossXp,
  getZombieLoot, getZombieBossLoot,
  ADMIN_TG_ID,
} from '../../config/constants.js';
import { spawnScout, onScoutKilled, checkWaveComplete } from '../../game/mechanics/zombies.js';

export const zombiesRouter = Router();

const WEAPON_COOLDOWNS = { sword: 500, axe: 700, none: 200 };

function emitToNearbyPlayers(lat, lng, radiusM, event, data) {
  for (const [sid, info] of connectedPlayers) {
    if (!info.lat || !info.lng) continue;
    if (haversine(lat, lng, info.lat, info.lng) <= radiusM) io.to(sid).emit(event, data);
  }
}

zombiesRouter.post('/', async (req, res) => {
  const { action } = req.body || {};
  if (action === 'spawn-scout') return handleSpawnScout(req, res);
  if (action === 'attack') return handleAttack(req, res);
  return res.status(400).json({ error: 'Unknown action' });
});

// ── SPAWN SCOUT (admin only) ──
async function handleSpawnScout(req, res) {
  const { telegram_id } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'Missing telegram_id' });

  const player = gameState.getPlayerByTgId(Number(telegram_id));
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (Number(telegram_id) !== ADMIN_TG_ID) return res.status(403).json({ error: 'Admin only' });

  const lat = player.last_lat;
  const lng = player.last_lng;
  if (!lat || !lng) return res.status(400).json({ error: 'GPS not ready' });

  // Admin override: clear existing hordes for this player
  for (const [id, h] of gameState.zombieHordes) {
    if (h.player_id === Number(telegram_id)) {
      for (const z of gameState.zombies.values()) {
        if (z.horde_id === id) gameState.zombies.delete(z.id);
      }
      gameState.zombieHordes.delete(id);
    }
  }
  await supabase.from('zombie_hordes').update({ status: 'defeated' }).eq('player_id', Number(telegram_id)).in('status', ['scout', 'active']);
  await supabase.from('zombies').update({ alive: false }).eq('player_id', Number(telegram_id)).eq('alive', true);

  const result = await spawnScout(Number(telegram_id), lat, lng, io, connectedPlayers);
  return res.json(result);
}

// ── ATTACK ZOMBIE ──
async function handleAttack(req, res) {
  const { telegram_id, zombie_id, lat, lng } = req.body || {};
  if (!telegram_id || !zombie_id || lat == null || lng == null)
    return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(Number(telegram_id));
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const zombie = gameState.zombies.get(zombie_id);
  if (!zombie || !zombie.alive)
    return res.status(404).json({ error: 'Zombie not found' });

  // Check horde belongs to this player
  const horde = gameState.zombieHordes.get(zombie.horde_id);
  if (!horde || horde.player_id !== Number(telegram_id))
    return res.status(403).json({ error: 'Not your horde' });

  // Distance check
  const pLat = parseFloat(lat), pLng = parseFloat(lng);
  const dist = haversine(pLat, pLng, zombie.lat, zombie.lng);
  if (dist > LARGE_RADIUS) return res.status(400).json({ error: 'Too far', distance: Math.round(dist) });

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

  // Apply damage
  zombie.hp = Math.max(0, zombie.hp - damage);
  horde.last_attack_at = new Date().toISOString();
  gameState.markDirty('zombieHordes', horde.id);

  // Emit projectile
  emitToNearbyPlayers(zombie.lat, zombie.lng, 1000, 'projectile', {
    from_lat: pLat, from_lng: pLng,
    to_lat: zombie.lat, to_lng: zombie.lng,
    damage, crit: isCrit,
    target_type: 'zombie', target_id: zombie.id,
    attacker_id: Number(telegram_id),
    weapon_type: weaponType === 'none' ? 'fist' : weaponType,
  });

  if (zombie.hp <= 0) {
    // Zombie killed
    zombie.alive = false;
    gameState.zombies.delete(zombie.id);
    await supabase.from('zombies').update({ alive: false, hp: 0 }).eq('id', zombie.id);

    const isScout = zombie.type === 'scout';
    const isBoss = zombie.type === 'boss';
    let xpGained = 0;
    let loot = null;

    if (isScout) {
      xpGained = (player.level || 1) * 5;
      await onScoutKilled(horde, io, connectedPlayers);
    } else if (isBoss) {
      xpGained = getZombieBossXp(player.level || 1);
      loot = getZombieBossLoot();
    } else {
      xpGained = getZombieXp(player.level || 1);
      loot = getZombieLoot();
    }

    // Award XP
    let xpResult = null;
    if (xpGained > 0) {
      try { xpResult = await addXp(player.id, xpGained); } catch (_) {}
    }

    // Award loot
    if (loot && loot.count > 0) {
      if (loot.currency === 'shards') {
        player.crystals = (player.crystals || 0) + loot.count;
      } else {
        player.ether = (player.ether || 0) + loot.count;
      }
      gameState.markDirty('players', player.id);
    }

    // Emit kill
    emitToNearbyPlayers(zombie.lat, zombie.lng, 1000, 'zombie:killed', {
      zombie_id, is_boss: isBoss, is_scout: isScout,
      xp_gained: xpGained, loot,
    });
    io.emit('zombie:removed', { zombie_id, horde_id: horde.id });

    // Check wave complete
    if (!isScout) {
      await checkWaveComplete(horde, io, connectedPlayers);
    }

    return res.json({
      success: true, damage, crit: isCrit, killed: true,
      xp_gained: xpGained, xp: xpResult, loot,
      zombie_hp: 0, zombie_alive: false,
    });
  }

  // Zombie survived
  gameState.markDirty('zombies', zombie.id);

  emitToNearbyPlayers(zombie.lat, zombie.lng, 1000, 'zombie:hp_update', {
    zombie_id, hp: zombie.hp, max_hp: zombie.max_hp,
  });

  return res.json({
    success: true, damage, crit: isCrit, killed: false,
    zombie_hp: zombie.hp, zombie_alive: true,
  });
}
