import { Router } from 'express';
import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { haversine } from '../../lib/haversine.js';
import { logPlayer } from '../../lib/logger.js';
import { gameState } from '../../lib/gameState.js';
import { io, connectedPlayers, lastAttackTime, recordAttack, getAttackCooldown, logActivity } from '../../server.js';
import { calcHpRegen, LARGE_RADIUS, distanceMultiplier } from '../../lib/formulas.js';
import { addXp, XP_REWARDS } from '../../lib/xp.js';
import {
  MONUMENT_LEVELS, MONUMENT_ATTACK_RADIUS,
  WAVE_INTERVAL_SECONDS, spawnDefenderWave, defeatMonument, getPlayersNearMonument,
  getMonumentAttackers, calcRaidDps, checkWaveTrigger, checkWaveComplete,
} from '../../lib/monuments.js';
import { MONUMENT_WAVE_TRIGGERS, MONUMENT_HP, MONUMENT_SHIELD_HP } from '../../config/constants.js';
import { MONUMENT_SHIELD_DPS_THRESHOLD, MONUMENT_DPS_WINDOW_MS } from '../../config/constants.js';
import { sendTelegramNotification } from '../../lib/supabase.js';
import { ts, getLang } from '../../config/i18n.js';
import { getPlayerSkillEffects } from '../../config/skills.js';
import { WEAPON_COOLDOWNS, SMALL_RADIUS } from '../../config/constants.js';
import { withPlayerLock } from '../../lib/playerLock.js';
import { mapRouter } from './map.js';

export const monumentsRouter = Router();

// Lightweight list for monument world map
monumentsRouter.get('/all', (req, res) => {
  const list = [];
  for (const m of gameState.monuments.values()) {
    list.push({
      id: m.id,
      name: m.name,
      emoji: m.emoji || '🏛️',
      lat: m.lat,
      lng: m.lng,
      level: m.level,
      phase: m.phase,
    });
  }
  res.json(list);
});

function emitToNearbyPlayers(lat, lng, radiusM, event, data) {
  for (const [sid, info] of connectedPlayers) {
    if (!info.lat || !info.lng) continue;
    const d = haversine(lat, lng, info.lat, info.lng);
    if (d <= radiusM) io.to(sid).emit(event, data);
  }
}

// Emit only to players participating in the raid (have damage tracked)
function emitToRaidParticipants(monumentId, event, data) {
  const dmgMap = gameState.monumentDamage.get(monumentId);
  if (!dmgMap) return;
  for (const [sid, info] of connectedPlayers) {
    if (!info.telegram_id) continue;
    if (dmgMap.has(Number(info.telegram_id)) || dmgMap.has(String(info.telegram_id))) {
      io.to(sid).emit(event, data);
    }
  }
}

// ── POST /api/monuments ──
monumentsRouter.post('/', async (req, res) => {
  const { action } = req.body || {};
  if (action === 'start-raid') return handleStartRaid(req, res);
  if (action === 'attack-shield') return handleAttackShield(req, res);
  if (action === 'attack-monument') return handleAttackMonument(req, res);
  if (action === 'attack-defender') return handleAttackDefender(req, res);
  if (action === 'open-loot-box') return handleOpenLootBox(req, res);
  if (action === 'request') return handleMonumentRequest(req, res);
  return res.status(400).json({ error: 'Unknown action' });
});

// ── GET /api/monuments ──
monumentsRouter.get('/', async (req, res) => {
  const { monument_id, telegram_id } = req.query;
  if (!monument_id) return res.status(400).json({ error: 'monument_id required' });

  const monument = gameState.monuments.get(monument_id);
  if (!monument) return res.status(404).json({ error: 'Monument not found' });

  const defenders = [...gameState.monumentDefenders.values()].filter(d => d.monument_id === monument_id && d.alive);
  const damageMap = gameState.monumentDamage.get(monument_id);
  let myDamage = 0;
  let participants = 0;
  if (damageMap) {
    participants = damageMap.size;
    if (telegram_id) {
      myDamage = damageMap.get(Number(telegram_id)) || damageMap.get(String(telegram_id)) || 0;
    }
  }

  return res.json({
    monument,
    defenders: defenders.map(d => ({ id: d.id, emoji: d.emoji, hp: d.hp, max_hp: d.max_hp, lat: d.lat, lng: d.lng })),
    participants,
    my_damage: myDamage,
    wave: gameState.activeWaves.get(monument_id)?.wave_number || 0,
    dps_threshold: MONUMENT_SHIELD_DPS_THRESHOLD[monument.level] || 0,
  });
});

// ── start-raid ──
async function handleStartRaid(req, res) {
  const { telegram_id, monument_id, lat, lng } = req.body || {};
  if (!telegram_id || !monument_id || lat == null || lng == null)
    return res.status(400).json({ error: 'Missing fields' });

  const monument = gameState.monuments.get(monument_id);
  if (!monument) return res.status(404).json({ error: 'Monument not found' });

  const gsP = gameState.getPlayerByTgId(Number(telegram_id));
  if (!gsP?.last_lat || !gsP?.last_lng) return res.status(400).json({ error: 'Position unknown' });
  const dist = haversine(gsP.last_lat, gsP.last_lng, monument.lat, monument.lng);
  const _monRadFx = getPlayerSkillEffects(gameState.getPlayerSkills(telegram_id));
  if (dist > MONUMENT_ATTACK_RADIUS + (_monRadFx.attack_radius_bonus || 0))
    return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.too_far_short'), distance: Math.round(dist) });

  if (monument.phase === 'defeated')
    return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.monument_defeated') });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  // Set raid start if first participant
  if (!monument.raid_started_at) {
    monument.raid_started_at = new Date().toISOString();
    gameState.markDirty('monuments', monument.id);
  }

  // Add player to damage tracking if not present
  if (!gameState.monumentDamage.has(monument.id)) {
    gameState.monumentDamage.set(monument.id, new Map());
  }
  const dmgMap = gameState.monumentDamage.get(monument.id);
  if (!dmgMap.has(Number(telegram_id))) {
    dmgMap.set(Number(telegram_id), 0);
  }

  logActivity(player.game_username, `started raid on monument lv${monument.level}`);
  logPlayer(telegram_id, 'action', `Начал рейд на монумент lv${monument.level} "${monument.name}"`);

  const defenders = [...gameState.monumentDefenders.values()].filter(d => d.monument_id === monument.id && d.alive);

  return res.json({
    monument,
    defenders: defenders.map(d => ({ id: d.id, emoji: d.emoji, hp: d.hp, max_hp: d.max_hp, lat: d.lat, lng: d.lng })),
    participants: dmgMap.size,
    my_damage: dmgMap.get(Number(telegram_id)) || 0,
    wave: gameState.activeWaves.get(monument.id)?.wave_number || 0,
  });
}

// ── attack-shield ──
async function handleAttackShield(req, res) {
  const { telegram_id, monument_id, lat, lng } = req.body || {};
  if (!telegram_id || !monument_id || lat == null || lng == null)
    return res.status(400).json({ error: 'Missing fields' });

  const monument = gameState.monuments.get(monument_id);
  if (!monument) return res.status(404).json({ error: 'Monument not found' });
  if (monument.phase !== 'shield') return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.monument_not_shield') });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const lang = getLang(gameState, telegram_id);
  if (player.is_dead) return res.status(400).json({ error: ts(lang, 'err.dead') });

  if (!player.last_lat || !player.last_lng) return res.status(400).json({ error: 'Position unknown' });
  const dist = haversine(player.last_lat, player.last_lng, monument.lat, monument.lng);
  if (dist > MONUMENT_ATTACK_RADIUS + (getPlayerSkillEffects(gameState.getPlayerSkills(telegram_id)).attack_radius_bonus || 0)) return res.status(400).json({ error: ts(lang, 'err.too_far_short') });

  // Weapon cooldown (centralized: weapon + skill speed bonus)
  const cooldownMs = getAttackCooldown(telegram_id);
  const now = Date.now();
  const lastTime = lastAttackTime.get(String(telegram_id)) || 0;
  if (now - lastTime < cooldownMs)
    return res.status(429).json({ error: 'Cooldown', retry_after: cooldownMs - (now - lastTime) });
  recordAttack(telegram_id, now);

  // Calculate damage
  const attackerItems = gameState.getPlayerItems(player.id);
  const weapon = attackerItems.find(i => (i.type === 'sword' || i.type === 'axe') && i.equipped);
  const weaponType = weapon ? weapon.type : 'none';
  const _mSkFx = getPlayerSkillEffects(gameState.getPlayerSkills(telegram_id));
  const baseDmg = 10 + (weapon?.attack || 0);
  const multiplier = distanceMultiplier(dist, LARGE_RADIUS);
  let damage = Math.round(baseDmg * multiplier);
  if (_mSkFx.weapon_damage_bonus) damage = Math.round(damage * (1 + _mSkFx.weapon_damage_bonus));
  if (_mSkFx.pve_damage_bonus) damage = Math.round(damage * (1 + _mSkFx.pve_damage_bonus));
  let isCrit = false;

  if (weapon?.type === 'sword') {
    const critChance = (weapon.crit_chance || 0) + (_mSkFx.crit_chance_bonus || 0) * 100;
    if (Math.random() * 100 < critChance) {
      const wLvl = weapon.upgrade_level || 0;
      let critMul = 1.5;
      if (weapon.rarity === 'mythic') critMul = 1.5 + (wLvl / 90) * 0.7;
      else if (weapon.rarity === 'legendary') critMul = 1.5 + (wLvl / 100) * 1.5;
      damage = Math.floor(damage * critMul);
      isCrit = true;
    }
  }

  // Auto-join raid tracking (so shield attackers get notifications)
  if (!gameState.monumentDamage.has(monument.id)) {
    gameState.monumentDamage.set(monument.id, new Map());
  }
  const dmg = gameState.monumentDamage.get(monument.id);
  if (!dmg.has(Number(telegram_id))) dmg.set(Number(telegram_id), 0);

  // Apply damage directly to shield (no DPS threshold)
  monument.shield_hp = Math.max(0, monument.shield_hp - damage);
  gameState.markDirty('monuments', monument.id);

  // Emit projectile
  emitToNearbyPlayers(monument.lat, monument.lng, 1000, 'projectile', {
    from_lat: player.last_lat, from_lng: player.last_lng,
    to_lat: monument.lat, to_lng: monument.lng,
    damage, crit: isCrit,
    target_type: 'monument_shield', target_id: monument.id,
    weapon_type: weaponType,
    attacker_id: player.id,
  });

  // Shield broken?
  let shieldBroken = false;
  if (monument.shield_hp <= 0) {
    shieldBroken = true;
    monument.phase = 'open';
    monument.shield_broken_at = new Date().toISOString();
    monument.waves_triggered = [];
    gameState.markDirty('monuments', monument.id);

    // Start tracking for waves
    gameState.activeWaves.set(monument.id, { wave_number: 0, last_wave_at: now, last_attack_at: 0 });

    emitToRaidParticipants(monument.id, 'monument:shield_broken', {
      monument_id: monument.id,
      breaker_name: player.game_username || player.username || '?',
    });

    logActivity(player.game_username, `broke shield on monument lv${monument.level}`);
  }

  // Emit shield update
  emitToNearbyPlayers(monument.lat, monument.lng, 1000, 'monument:shield_update', {
    monument_id: monument.id,
    shield_hp: monument.shield_hp,
    max_shield_hp: monument.max_shield_hp,
  });

  return res.json({
    damage, crit: isCrit,
    shield_hp: monument.shield_hp, max_shield_hp: monument.max_shield_hp,
    shield_broken: shieldBroken, effective_cd: cooldownMs,
  });
}

// ── attack-monument ──
async function handleAttackMonument(req, res) {
  const { telegram_id, monument_id, lat, lng } = req.body || {};
  if (!telegram_id || !monument_id || lat == null || lng == null)
    return res.status(400).json({ error: 'Missing fields' });

  const monument = gameState.monuments.get(monument_id);
  if (!monument) return res.status(404).json({ error: 'Monument not found' });

  const lang2 = getLang(gameState, telegram_id);
  if (monument.phase !== 'open' && monument.phase !== 'wave') return res.status(400).json({ error: ts(lang2, 'err.monument_not_open') });
  if (monument.hp <= 0) return res.status(400).json({ error: ts(lang2, 'err.monument_not_open') });

  // Check if defenders alive — attacks go through but deal 0 damage
  const aliveDefenders = [...gameState.monumentDefenders.values()].filter(d => d.monument_id === monument_id && d.alive);
  const defendersAlive = aliveDefenders.length > 0;

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (player.is_dead) return res.status(400).json({ error: ts(lang2, 'err.dead') });

  if (!player.last_lat || !player.last_lng) return res.status(400).json({ error: 'Position unknown' });
  const dist = haversine(player.last_lat, player.last_lng, monument.lat, monument.lng);
  if (dist > MONUMENT_ATTACK_RADIUS + (getPlayerSkillEffects(gameState.getPlayerSkills(telegram_id)).attack_radius_bonus || 0)) return res.status(400).json({ error: ts(lang2, 'err.too_far_short') });

  // Weapon cooldown (centralized: weapon + skill speed bonus)
  const cooldownMs = getAttackCooldown(telegram_id);
  const now = Date.now();
  const lastTime = lastAttackTime.get(String(telegram_id)) || 0;
  if (now - lastTime < cooldownMs)
    return res.status(429).json({ error: 'Cooldown', retry_after: cooldownMs - (now - lastTime) });
  recordAttack(telegram_id, now);

  // Calculate damage (with crit + execution)
  const attackerItems = gameState.getPlayerItems(player.id);
  const weapon = attackerItems.find(i => (i.type === 'sword' || i.type === 'axe') && i.equipped);
  const weaponType = weapon ? weapon.type : 'none';
  const _mSkFx2 = getPlayerSkillEffects(gameState.getPlayerSkills(telegram_id));
  const baseDmg = 10 + (weapon?.attack || 0);
  const multiplier = distanceMultiplier(dist, LARGE_RADIUS);
  let damage = Math.round(baseDmg * multiplier);
  if (_mSkFx2.weapon_damage_bonus) damage = Math.round(damage * (1 + _mSkFx2.weapon_damage_bonus));
  if (_mSkFx2.pve_damage_bonus) damage = Math.round(damage * (1 + _mSkFx2.pve_damage_bonus));
  let isCrit = false, isExecution = false;

  if (weapon?.type === 'sword') {
    const critChance = (weapon.crit_chance || 0) + (_mSkFx2.crit_chance_bonus || 0) * 100;
    if (Math.random() * 100 < critChance) {
      const wLvl = weapon.upgrade_level || 0;
      let critMul = 1.5;
      if (weapon.rarity === 'mythic') critMul = 1.5 + (wLvl / 90) * 0.7;
      else if (weapon.rarity === 'legendary') critMul = 1.5 + (wLvl / 100) * 1.5;
      damage = Math.floor(damage * critMul);
      isCrit = true;
    }
  }

  // Axe crit from skill tree only (no execution on monuments)
  if (weapon?.type === 'axe' && !isCrit) {
    const axeCritChance = (_mSkFx2.crit_chance_bonus || 0) * 100;
    if (axeCritChance > 0 && Math.random() * 100 < axeCritChance) {
      damage = Math.floor(damage * 2);
      isCrit = true;
    }
  }

  // Defenders alive → 0 damage to monument, add threat to attacker
  if (defendersAlive) {
    for (const d of aliveDefenders) {
      if (!d._threat) d._threat = new Map();
      d._threat.set(Number(telegram_id), (d._threat.get(Number(telegram_id)) || 0) + damage + 50);
    }
    damage = 0;
    isCrit = false;
    isExecution = false;
  }

  // Apply damage
  monument.hp = Math.max(0, monument.hp - damage);
  gameState.markDirty('monuments', monument.id);

  // Track damage
  if (!gameState.monumentDamage.has(monument.id)) {
    gameState.monumentDamage.set(monument.id, new Map());
  }
  const dmgMap = gameState.monumentDamage.get(monument.id);
  const tgId = Number(telegram_id);
  dmgMap.set(tgId, (dmgMap.get(tgId) || 0) + damage);

  // Emit projectile
  emitToNearbyPlayers(monument.lat, monument.lng, 1000, 'projectile', {
    from_lat: player.last_lat, from_lng: player.last_lng,
    to_lat: monument.lat, to_lng: monument.lng,
    damage, crit: isCrit, execution: isExecution,
    target_type: 'monument', target_id: monument.id,
    weapon_type: weaponType,
    attacker_id: player.id,
  });

  // Emit HP update
  emitToNearbyPlayers(monument.lat, monument.lng, 1000, 'monument:hp_update', {
    monument_id: monument.id,
    hp: monument.hp,
    max_hp: monument.max_hp,
  });

  // Wave trigger on HP thresholds (75/50/25%)
  let waveSpawned = false;
  if (monument.hp > 0) {
    const waveNumber = checkWaveTrigger(monument);
    if (waveNumber) {
      if (!monument.waves_triggered) monument.waves_triggered = [];
      monument.waves_triggered.push(MONUMENT_WAVE_TRIGGERS[waveNumber - 1]);
      monument.invulnerable = true;
      gameState.markDirty('monuments', monument.id);
      await spawnDefenderWave(monument, waveNumber, io, connectedPlayers);
      waveSpawned = true;
    }
  }

  // Defeated?
  let defeated = false;
  if (monument.hp <= 0) {
    defeated = true;
    await defeatMonument(monument, io, connectedPlayers);
    logActivity(player.game_username, `defeated monument lv${monument.level} "${monument.name}"`);
  }

  return res.json({
    damage, crit: isCrit, execution: isExecution,
    hp: monument.hp, max_hp: monument.max_hp,
    defeated, defenders_alive: defendersAlive,
    wave_shield_hp: monument._wave_shield_hp || 0,
    my_damage: dmgMap.get(tgId) || 0, effective_cd: cooldownMs,
  });
}

// ── attack-defender ──
async function handleAttackDefender(req, res) {
  const { telegram_id, defender_id, lat, lng } = req.body || {};
  if (!telegram_id || !defender_id || lat == null || lng == null)
    return res.status(400).json({ error: 'Missing fields' });

  // Auto-join raid tracking early (before defender lookup to use monument_id)
  const _def = gameState.monumentDefenders.get(defender_id);
  if (_def?.monument_id) {
    if (!gameState.monumentDamage.has(_def.monument_id)) gameState.monumentDamage.set(_def.monument_id, new Map());
    const _dm = gameState.monumentDamage.get(_def.monument_id);
    if (!_dm.has(Number(telegram_id))) _dm.set(Number(telegram_id), 0);
  }

  const defender = gameState.monumentDefenders.get(defender_id);
  if (!defender || !defender.alive) return res.status(404).json({ error: 'Defender not found or dead' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const lang3 = getLang(gameState, telegram_id);
  if (player.is_dead) return res.status(400).json({ error: ts(lang3, 'err.dead') });

  if (!player.last_lat || !player.last_lng) return res.status(400).json({ error: 'Position unknown' });
  const dist = haversine(player.last_lat, player.last_lng, defender.lat, defender.lng);
  if (dist > MONUMENT_ATTACK_RADIUS + (getPlayerSkillEffects(gameState.getPlayerSkills(telegram_id)).attack_radius_bonus || 0)) return res.status(400).json({ error: ts(lang3, 'err.too_far_short') });

  // Weapon cooldown (centralized: weapon + skill speed bonus)
  const cooldownMs = getAttackCooldown(telegram_id);
  const now = Date.now();
  const lastTime = lastAttackTime.get(String(telegram_id)) || 0;
  if (now - lastTime < cooldownMs)
    return res.status(429).json({ error: 'Cooldown', retry_after: cooldownMs - (now - lastTime) });
  recordAttack(telegram_id, now);

  // Calculate damage
  const attackerItems = gameState.getPlayerItems(player.id);
  const weapon = attackerItems.find(i => (i.type === 'sword' || i.type === 'axe') && i.equipped);
  const weaponType = weapon ? weapon.type : 'none';
  const _mSkFx3 = getPlayerSkillEffects(gameState.getPlayerSkills(telegram_id));
  const baseDmg = 10 + (weapon?.attack || 0);
  const multiplier = 0.8 + Math.random() * 0.4;
  let damage = Math.round(baseDmg * multiplier);
  if (_mSkFx3.weapon_damage_bonus) damage = Math.round(damage * (1 + _mSkFx3.weapon_damage_bonus));
  if (_mSkFx3.pve_damage_bonus) damage = Math.round(damage * (1 + _mSkFx3.pve_damage_bonus));
  let isCrit = false;

  if (weapon?.type === 'sword') {
    const critChance = (weapon.crit_chance || 0) + (_mSkFx3.crit_chance_bonus || 0) * 100;
    if (Math.random() * 100 < critChance) {
      const wLvl = weapon.upgrade_level || 0;
      let critMul = 1.5;
      if (weapon.rarity === 'mythic') critMul = 1.5 + (wLvl / 90) * 0.7;
      else if (weapon.rarity === 'legendary') critMul = 1.5 + (wLvl / 100) * 1.5;
      damage = Math.floor(damage * critMul);
      isCrit = true;
    }
  }

  // Apply damage to defender
  defender.hp = Math.max(0, defender.hp - damage);

  // Add threat from attacker (attacking a defender generates 2× threat)
  if (!defender._threat) defender._threat = new Map();
  defender._threat.set(Number(telegram_id), (defender._threat.get(Number(telegram_id)) || 0) + damage * 2);

  // Emit projectile
  emitToNearbyPlayers(defender.lat, defender.lng, 1000, 'projectile', {
    from_lat: player.last_lat, from_lng: player.last_lng,
    to_lat: defender.lat, to_lng: defender.lng,
    damage, crit: isCrit,
    target_type: 'defender', target_id: defender.id,
    weapon_type: weaponType,
    attacker_id: player.id,
  });

  let killed = false;
  if (defender.hp <= 0) {
    killed = true;
    defender.alive = false;
    defender._died_at = Date.now();

    // Persist defender death
    supabase.from('monument_defenders').update({ alive: false, hp: 0 }).eq('id', defender.id).then(() => {}).catch(e => console.error('[monuments] DB error:', e.message));

    emitToRaidParticipants(defender.monument_id, 'monument:defender_killed', {
      defender_id: defender.id,
      killer_name: player.game_username || '?',
      monument_id: defender.monument_id,
    });

    // Check if all defenders for this monument are dead → clear wave
    const remainingAlive = [...gameState.monumentDefenders.values()]
      .filter(d => d.monument_id === defender.monument_id && d.alive);

    if (remainingAlive.length === 0) {
      const monument = gameState.monuments.get(defender.monument_id);
      if (monument && monument.phase !== 'defeated') {
        monument.phase = 'open';
        monument.invulnerable = false;
        monument._wave_shield_hp = 0;
        gameState.markDirty('monuments', monument.id);
        emitToRaidParticipants(defender.monument_id, 'monument:wave_cleared', {
          monument_id: defender.monument_id,
          wave: monument.waves_triggered?.length || 0,
        });
      }
    }

    // XP for killing defender
    try { await addXp(player.id, 50); } catch (_) {}
  }

  return res.json({
    damage, crit: isCrit, killed,
    defender_hp: defender.hp, defender_max_hp: defender.max_hp, effective_cd: cooldownMs,
  });
}

// ── open-loot-box ──
async function handleOpenLootBox(req, res) {
  const { telegram_id, box_id } = req.body || {};
  if (!telegram_id || !box_id) return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const lang4 = getLang(gameState, telegram_id);

  // Distance check — player must be within SMALL_RADIUS
  if (!player.last_lat || !player.last_lng) return res.status(400).json({ error: 'Position unknown' });

  return withPlayerLock(telegram_id, async () => {
    // Get loot box from DB (not cached in gameState)
    const { data: box, error: boxErr } = await supabase.from('monument_loot_boxes')
      .select('*')
      .eq('id', box_id)
      .maybeSingle();

    if (boxErr || !box) return res.status(404).json({ error: 'Loot box not found' });
    if (box.opened) return res.status(400).json({ error: 'Already opened' });
    if (Number(box.player_id) !== Number(telegram_id))
      return res.status(403).json({ error: ts(lang4, 'err.not_your_box') });
    if (new Date(box.expires_at) < new Date())
      return res.status(400).json({ error: ts(lang4, 'err.box_expired') });

    // Distance check — must be within SMALL_RADIUS of the loot box
    if (box.lat == null || box.lng == null) return res.status(400).json({ error: 'Loot box has no position' });
    const dist = haversine(player.last_lat, player.last_lng, box.lat, box.lng);
    if (!(dist <= SMALL_RADIUS)) return res.status(400).json({ error: ts(lang4, 'err.too_far_short'), distance: Math.round(dist) });

    // Mark as opened atomically — use .eq('opened', false) to prevent double-open
    const { data: updated, error: updErr } = await supabase.from('monument_loot_boxes')
      .update({ opened: true })
      .eq('id', box_id)
      .eq('opened', false)
      .select('id')
      .maybeSingle();
    if (updErr || !updated) return res.status(400).json({ error: 'Already opened' });

    // Invalidate loot box cache for this player so tick doesn't re-show opened box
    if (mapRouter._lbCache) mapRouter._lbCache.delete(Number(telegram_id));

    // Grant gems — read fresh from DB to avoid stale gameState
    const { data: freshPlayer } = await supabase.from('players').select('diamonds').eq('id', player.id).single();
    const currentDiamonds = freshPlayer?.diamonds ?? player.diamonds ?? 0;
    const newDiamonds = currentDiamonds + box.gems;
    await supabase.from('players').update({ diamonds: newDiamonds }).eq('id', player.id);
    player.diamonds = newDiamonds;
    gameState.markDirty('players', player.id);

    // Grant items and cores (skip items if inventory full)
    const { hasInventorySpace } = await import('../../game/mechanics/items.js');
    const items = typeof box.items === 'string' ? JSON.parse(box.items) : (box.items || []);
    const insertedItems = [];
    const insertedCores = [];
    for (const itemData of items) {
      // Core entry (added by addCoresToLootBoxes)
      if (itemData._type === 'core') {
        const coreRow = {
          owner_id: Number(telegram_id),
          mine_cell_id: null,
          slot_index: null,
          core_type: itemData.core_type,
          level: itemData.level || 0,
          created_at: new Date().toISOString(),
        };
        const { data: ins, error: insErr } = await supabase.from('cores').insert(coreRow).select().single();
        if (!insErr && ins) {
          gameState.upsertCore(ins);
          insertedCores.push(ins);
        }
        continue;
      }
      // Skip if inventory full
      if (gameState.loaded && !hasInventorySpace(gameState, player.id)) continue;
      const itemRow = {
        owner_id: player.id,
        type: itemData.type,
        rarity: itemData.rarity,
        name: itemData.name,
        emoji: itemData.emoji,
        attack: itemData.attack || 0,
        crit_chance: itemData.crit_chance || 0,
        defense: itemData.defense || 0,
        block_chance: itemData.block_chance || 0,
        stat_value: itemData.stat_value || itemData.attack || itemData.defense || 0,
        base_attack: itemData.base_attack || itemData.attack || 0,
        base_crit_chance: itemData.base_crit_chance || itemData.crit_chance || 0,
        base_defense: itemData.base_defense || itemData.defense || 0,
        upgrade_level: 0, plus: 0,
        equipped: false,
        on_market: false,
        obtained_at: new Date().toISOString(),
      };
      const { data: ins, error: insErr } = await supabase.from('items').insert(itemRow).select().single();
      if (!insErr && ins) {
        gameState.upsertItem(ins);
        insertedItems.push(ins);
      }
    }

    // XP
    const { getMonumentXp } = await import('../../game/mechanics/xp.js');
    let xpResult = null;
    try { xpResult = await addXp(player.id, getMonumentXp(box.monument_level)); } catch (_) {}

    logActivity(player.game_username, `opened monument loot box (lv${box.monument_level} ${box.box_type})`);
    logPlayer(telegram_id, 'action', `Открыл лутбокс монумента lv${box.monument_level}`);

    return res.json({
      success: true,
      gems: box.gems,
      items: insertedItems.map(i => ({ id: i.id, type: i.type, rarity: i.rarity, name: i.name, emoji: i.emoji, attack: i.attack, defense: i.defense, crit_chance: i.crit_chance })),
      cores: insertedCores.map(c => ({ id: c.id, core_type: c.core_type, level: c.level })),
      diamonds: newDiamonds,
      xp: xpResult,
    });
  });
}

// ── Monument Request ──
import { ADMIN_NOTIFY_ID } from '../../config/constants.js';
const ADMIN_TG_ID = ADMIN_NOTIFY_ID;

async function handleMonumentRequest(req, res) {
  const { telegram_id, lat, lng, name, emoji } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });
  const lang = getLang(gameState, telegram_id);
  if (lat == null || lng == null || !name || !emoji)
    return res.status(400).json({ error: ts(lang, 'monreq.fill_all') });
  const level = 1;
  if (name.length < 3 || name.length > 50)
    return res.status(400).json({ error: ts(lang, 'monreq.name_length') });

  const player = gameState.getPlayerByTgId(Number(telegram_id));
  if (!player) return res.status(404).json({ error: ts(lang, 'err.player_not_found') });

  // 1 request per day limit
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const { data: todayRequests } = await supabase
    .from('monument_requests').select('id')
    .eq('player_id', Number(telegram_id))
    .gte('created_at', today.toISOString());
  if (todayRequests?.length > 0)
    return res.status(400).json({ error: ts(lang, 'monreq.daily_limit') });

  const { data: request, error } = await supabase
    .from('monument_requests')
    .insert({ player_id: Number(telegram_id), lat, lng, name, emoji, level, status: 'pending' })
    .select().single();
  if (error) return res.status(500).json({ error: ts(lang, 'monreq.create_error') });

  sendAdminMonumentRequest(request, player).catch(e => console.error('[MONUMENT_REQ] admin notify error:', e.message));

  return res.json({ ok: true, request_id: request.id });
}

async function sendAdminMonumentRequest(request, player) {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) return;
  const gmapsUrl = `https://www.google.com/maps?q=${request.lat},${request.lng}`;
  const message =
    `🏛️ ЗАЯВКА НА МОНУМЕНТ #${request.id}\n\n` +
    `👤 Игрок: ${player.game_username || 'Неизвестно'}\n` +
    `🔖 Тег: @${player.username || 'нет'}\n` +
    `🆔 ID: ${player.telegram_id}\n\n` +
    `${request.emoji} Название: ${request.name}\n` +
    `📍 Координаты: ${request.lat}, ${request.lng}\n` +
    `🗺 Карта: ${gmapsUrl}\n\n` +
    `🕐 Время: ${new Date().toLocaleString('ru')}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Одобрить', callback_data: `approve_monument_${request.id}` },
        { text: '❌ Отклонить', callback_data: `reject_monument_${request.id}` },
      ],
      [
        { text: '📍 Посмотреть место', web_app: { url: `https://overthrow.ru:8443?fly_to=${request.lat},${request.lng}` } },
      ],
    ],
  };

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: ADMIN_TG_ID, text: message, reply_markup: keyboard, disable_web_page_preview: false }),
  });
}
