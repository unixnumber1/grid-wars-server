import { Router } from 'express';
import { supabase, getPlayerByTelegramId, rateLimit } from '../lib/supabase.js';
import { rateLimitMw } from '../lib/rateLimit.js';
import { haversine } from '../lib/haversine.js';
import { gameState } from '../lib/gameState.js';
import { io, connectedPlayers, lastAttackTime, logActivity } from '../server.js';
import { calcHpRegen, LARGE_RADIUS } from '../lib/formulas.js';
import { addXp, XP_REWARDS } from '../lib/xp.js';
import {
  MONUMENT_LEVELS, MONUMENT_LOOT_TABLE, MONUMENT_ATTACK_RADIUS,
  WAVE_INTERVAL_SECONDS, spawnDefenderWave, defeatMonument, getPlayersNearMonument,
} from '../lib/monuments.js';
import { CORE_TYPES, getCoreDropChance, randomCoreType } from '../lib/cores.js';

export const monumentsRouter = Router();

const WEAPON_COOLDOWNS = { sword: 500, axe: 700, none: 200 };

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
monumentsRouter.post('/', rateLimitMw('attack'), async (req, res) => {
  const { action } = req.body || {};
  if (action === 'start-raid') return handleStartRaid(req, res);
  if (action === 'attack-shield') return handleAttackShield(req, res);
  if (action === 'attack-monument') return handleAttackMonument(req, res);
  if (action === 'attack-defender') return handleAttackDefender(req, res);
  if (action === 'open-loot-box') return handleOpenLootBox(req, res);
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
  });
});

// ── start-raid ──
async function handleStartRaid(req, res) {
  const { telegram_id, monument_id, lat, lng } = req.body || {};
  if (!telegram_id || !monument_id || lat == null || lng == null)
    return res.status(400).json({ error: 'Missing fields' });

  const monument = gameState.monuments.get(monument_id);
  if (!monument) return res.status(404).json({ error: 'Monument not found' });

  const pLat = parseFloat(lat), pLng = parseFloat(lng);
  const dist = haversine(pLat, pLng, monument.lat, monument.lng);
  if (dist > MONUMENT_ATTACK_RADIUS)
    return res.status(400).json({ error: 'Слишком далеко', distance: Math.round(dist) });

  if (monument.phase === 'defeated')
    return res.status(400).json({ error: 'Монумент повержен' });

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
  if (monument.phase !== 'shield') return res.status(400).json({ error: 'Монумент не в фазе щита' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const pLat = parseFloat(lat), pLng = parseFloat(lng);
  const dist = haversine(pLat, pLng, monument.lat, monument.lng);
  if (dist > MONUMENT_ATTACK_RADIUS) return res.status(400).json({ error: 'Слишком далеко' });

  // Weapon cooldown
  const attackerItems = gameState.getPlayerItems(player.id);
  const weapon = attackerItems.find(i => (i.type === 'sword' || i.type === 'axe') && i.equipped);
  const weaponType = weapon ? weapon.type : 'none';
  const cooldownMs = WEAPON_COOLDOWNS[weaponType] || 1500;
  const now = Date.now();
  const lastTime = lastAttackTime.get(String(telegram_id)) || 0;
  if (now - lastTime < cooldownMs)
    return res.status(429).json({ error: 'Cooldown', retry_after: cooldownMs - (now - lastTime) });
  lastAttackTime.set(String(telegram_id), now);

  // Calculate damage
  const baseDmg = 10 + (weapon?.attack || 0);
  const multiplier = 0.8 + Math.random() * 0.4;
  let damage = Math.round(baseDmg * multiplier);
  let isCrit = false;

  if (weapon?.type === 'sword') {
    const critChance = weapon.crit_chance || 0;
    if (Math.random() * 100 < critChance) {
      const wLvl = weapon.upgrade_level || 0;
      let critMul = 1.5;
      if (weapon.rarity === 'mythic') critMul = 1.5 + (wLvl / 90) * 0.7;
      else if (weapon.rarity === 'legendary') critMul = 1.5 + (wLvl / 100) * 1.5;
      damage = Math.floor(damage * critMul);
      isCrit = true;
    }
  }

  // Apply damage to shield
  monument.shield_hp = Math.max(0, monument.shield_hp - damage);
  gameState.markDirty('monuments', monument.id);

  // Auto-join raid tracking (so shield attackers get notifications)
  if (!gameState.monumentDamage.has(monument.id)) {
    gameState.monumentDamage.set(monument.id, new Map());
  }
  const dmg = gameState.monumentDamage.get(monument.id);
  if (!dmg.has(Number(telegram_id))) dmg.set(Number(telegram_id), 0);

  // Emit projectile
  emitToNearbyPlayers(monument.lat, monument.lng, 1000, 'projectile', {
    from_lat: pLat, from_lng: pLng,
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
    gameState.markDirty('monuments', monument.id);

    // Start first wave of defenders
    gameState.activeWaves.set(monument.id, { wave_number: 1, last_wave_at: now, last_attack_at: 0, last_hp_decile: 10 });
    await spawnDefenderWave(monument, 1, io, connectedPlayers);

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
    damage, crit: isCrit, shield_hp: monument.shield_hp, max_shield_hp: monument.max_shield_hp,
    shield_broken: shieldBroken,
  });
}

// ── attack-monument ──
async function handleAttackMonument(req, res) {
  const { telegram_id, monument_id, lat, lng } = req.body || {};
  if (!telegram_id || !monument_id || lat == null || lng == null)
    return res.status(400).json({ error: 'Missing fields' });

  const monument = gameState.monuments.get(monument_id);
  if (!monument) return res.status(404).json({ error: 'Monument not found' });
  if (monument.phase !== 'open') return res.status(400).json({ error: 'Монумент не открыт для атаки' });

  // Check no alive defenders
  const aliveDefenders = [...gameState.monumentDefenders.values()].filter(d => d.monument_id === monument_id && d.alive);
  if (aliveDefenders.length > 0) return res.status(400).json({ error: 'Сначала убейте защитников!', defenders_alive: aliveDefenders.length });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const pLat = parseFloat(lat), pLng = parseFloat(lng);
  const dist = haversine(pLat, pLng, monument.lat, monument.lng);
  if (dist > MONUMENT_ATTACK_RADIUS) return res.status(400).json({ error: 'Слишком далеко' });

  // Weapon cooldown
  const attackerItems = gameState.getPlayerItems(player.id);
  const weapon = attackerItems.find(i => (i.type === 'sword' || i.type === 'axe') && i.equipped);
  const weaponType = weapon ? weapon.type : 'none';
  const cooldownMs = WEAPON_COOLDOWNS[weaponType] || 1500;
  const now = Date.now();
  const lastTime = lastAttackTime.get(String(telegram_id)) || 0;
  if (now - lastTime < cooldownMs)
    return res.status(429).json({ error: 'Cooldown', retry_after: cooldownMs - (now - lastTime) });
  lastAttackTime.set(String(telegram_id), now);

  // Calculate damage (with crit + execution)
  const baseDmg = 10 + (weapon?.attack || 0);
  const multiplier = 0.8 + Math.random() * 0.4;
  let damage = Math.round(baseDmg * multiplier);
  let isCrit = false, isExecution = false;

  if (weapon?.type === 'sword') {
    const critChance = weapon.crit_chance || 0;
    if (Math.random() * 100 < critChance) {
      const wLvl = weapon.upgrade_level || 0;
      let critMul = 1.5;
      if (weapon.rarity === 'mythic') critMul = 1.5 + (wLvl / 90) * 0.7;
      else if (weapon.rarity === 'legendary') critMul = 1.5 + (wLvl / 100) * 1.5;
      damage = Math.floor(damage * critMul);
      isCrit = true;
    }
  }

  if (weapon?.type === 'axe') {
    const wLvl = weapon.upgrade_level || 0;
    let execChance = 0;
    if (weapon.rarity === 'mythic') execChance = 7 + (wLvl / 90) * 10;
    else if (weapon.rarity === 'legendary') execChance = 13 + (wLvl / 100) * 7;
    if (execChance > 0 && monument.hp < monument.max_hp * 0.1 && Math.random() * 100 < execChance) {
      damage = monument.hp;
      isExecution = true;
    }
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
    from_lat: pLat, from_lng: pLng,
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

  // Wave spawn on every 10% HP threshold crossed
  let waveSpawned = false;
  if (monument.hp > 0) {
    const wave = gameState.activeWaves.get(monument.id);
    if (wave) {
      const hpPct = Math.floor(monument.hp / monument.max_hp * 10); // 0-10 (deciles)
      const prevPct = wave.last_hp_decile ?? 10;
      if (hpPct < prevPct) {
        // Crossed a 10% threshold — spawn a wave
        wave.last_hp_decile = hpPct;
        wave.wave_number++;
        wave.last_wave_at = Date.now();
        await spawnDefenderWave(monument, wave.wave_number, io, connectedPlayers);
        waveSpawned = true;
      }
    }
  }

  // Defeated?
  let defeated = false;
  let coreDrop = null;
  if (monument.hp <= 0) {
    defeated = true;
    await defeatMonument(monument, io, connectedPlayers);
    logActivity(player.game_username, `defeated monument lv${monument.level} "${monument.name}"`);

    // Core drop chance for top damage dealer
    try {
      const dropChance = getCoreDropChance(monument.level);
      if (Math.random() < dropChance) {
        const coreType = randomCoreType();
        // Find top damage dealer
        const topEntry = [...dmgMap.entries()].sort((a, b) => b[1] - a[1])[0];
        const topPlayerId = topEntry ? topEntry[0] : tgId;
        const topPlayer = gameState.getPlayerByTgId(topPlayerId);

        if (topPlayer) {
          const coreData = {
            owner_id: Number(topPlayer.telegram_id),
            mine_cell_id: null,
            slot_index: null,
            core_type: coreType,
            level: 0,
            created_at: new Date().toISOString(),
          };
          const { data: inserted } = await supabase.from('cores').insert(coreData).select().single();
          if (inserted) {
            gameState.upsertCore(inserted);
            coreDrop = {
              core_type: coreType,
              emoji: CORE_TYPES[coreType].emoji,
              name: CORE_TYPES[coreType].name,
              monument_level: monument.level,
              player_id: topPlayerId,
            };

            // Notify top player via socket
            for (const [sid, info] of connectedPlayers) {
              if (String(info.telegram_id) === String(topPlayerId)) {
                io.to(sid).emit('core:dropped', coreDrop);
                break;
              }
            }
            console.log(`[CORES] ${CORE_TYPES[coreType].emoji} core dropped from monument lv${monument.level}`);
          }
        }
      }
    } catch (e) {
      console.error('[CORES] drop error:', e.message);
    }
  }

  return res.json({
    damage, crit: isCrit, execution: isExecution,
    hp: monument.hp, max_hp: monument.max_hp,
    defeated,
    my_damage: dmgMap.get(tgId) || 0,
    core_drop: coreDrop,
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

  const pLat = parseFloat(lat), pLng = parseFloat(lng);
  const dist = haversine(pLat, pLng, defender.lat, defender.lng);
  if (dist > MONUMENT_ATTACK_RADIUS) return res.status(400).json({ error: 'Слишком далеко' });

  // Weapon cooldown
  const attackerItems = gameState.getPlayerItems(player.id);
  const weapon = attackerItems.find(i => (i.type === 'sword' || i.type === 'axe') && i.equipped);
  const weaponType = weapon ? weapon.type : 'none';
  const cooldownMs = WEAPON_COOLDOWNS[weaponType] || 1500;
  const now = Date.now();
  const lastTime = lastAttackTime.get(String(telegram_id)) || 0;
  if (now - lastTime < cooldownMs)
    return res.status(429).json({ error: 'Cooldown', retry_after: cooldownMs - (now - lastTime) });
  lastAttackTime.set(String(telegram_id), now);

  // Calculate damage
  const baseDmg = 10 + (weapon?.attack || 0);
  const multiplier = 0.8 + Math.random() * 0.4;
  let damage = Math.round(baseDmg * multiplier);
  let isCrit = false;

  if (weapon?.type === 'sword') {
    const critChance = weapon.crit_chance || 0;
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

  // Emit projectile
  emitToNearbyPlayers(defender.lat, defender.lng, 1000, 'projectile', {
    from_lat: pLat, from_lng: pLng,
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

    // Persist defender death
    supabase.from('monument_defenders').update({ alive: false, hp: 0 }).eq('id', defender.id).then(() => {}).catch(() => {});

    emitToNearbyPlayers(defender.lat, defender.lng, 1000, 'monument:defender_killed', {
      defender_id: defender.id,
      killer_name: player.game_username || '?',
      monument_id: defender.monument_id,
    });

    // Check if all defenders for this monument are dead
    const aliveDefenders = [...gameState.monumentDefenders.values()]
      .filter(d => d.monument_id === defender.monument_id && d.alive);

    if (aliveDefenders.length === 0) {
      emitToRaidParticipants(defender.monument_id, 'monument:vulnerable', {
        monument_id: defender.monument_id,
      });
    }

    // XP for killing defender
    try { await addXp(player.id, 50); } catch (_) {}
  }

  return res.json({
    damage, crit: isCrit, killed,
    defender_hp: defender.hp, defender_max_hp: defender.max_hp,
  });
}

// ── open-loot-box ──
async function handleOpenLootBox(req, res) {
  const { telegram_id, box_id } = req.body || {};
  if (!telegram_id || !box_id) return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  // Get loot box from DB (not cached in gameState)
  const { data: box, error: boxErr } = await supabase.from('monument_loot_boxes')
    .select('*')
    .eq('id', box_id)
    .maybeSingle();

  if (boxErr || !box) return res.status(404).json({ error: 'Loot box not found' });
  if (box.opened) return res.status(400).json({ error: 'Already opened' });
  if (Number(box.player_id) !== Number(telegram_id))
    return res.status(403).json({ error: 'Не твоя коробка' });
  if (new Date(box.expires_at) < new Date())
    return res.status(400).json({ error: 'Коробка просрочена' });

  // Mark as opened
  await supabase.from('monument_loot_boxes').update({ opened: true }).eq('id', box_id);

  // Grant gems
  const currentDiamonds = player.diamonds || 0;
  const newDiamonds = currentDiamonds + box.gems;
  player.diamonds = newDiamonds;
  gameState.markDirty('players', player.id);
  await supabase.from('players').update({ diamonds: newDiamonds }).eq('id', player.id);

  // Grant items
  const items = typeof box.items === 'string' ? JSON.parse(box.items) : (box.items || []);
  const insertedItems = [];
  for (const itemData of items) {
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
      upgrade_level: 0,
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
  let xpResult = null;
  try { xpResult = await addXp(player.id, 200 + box.monument_level * 50); } catch (_) {}

  logActivity(player.game_username, `opened monument loot box (lv${box.monument_level} ${box.box_type})`);

  return res.json({
    success: true,
    gems: box.gems,
    items: insertedItems.map(i => ({ id: i.id, type: i.type, rarity: i.rarity, name: i.name, emoji: i.emoji, attack: i.attack, defense: i.defense, crit_chance: i.crit_chance })),
    diamonds: newDiamonds,
    xp: xpResult,
  });
}
