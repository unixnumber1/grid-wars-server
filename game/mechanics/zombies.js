import { gameState } from '../state/GameState.js';
import { haversine } from '../../lib/haversine.js';
import { supabase } from '../../lib/supabase.js';
import {
  ZOMBIE_SCOUT_HP, ZOMBIE_SCOUT_SPEED, ZOMBIE_SCOUT_EMOJI,
  ZOMBIE_NORMAL_SPEED, ZOMBIE_NORMAL_DAMAGE,
  ZOMBIE_BOSS_SPEED, ZOMBIE_BOSS_DAMAGE_MULTIPLIER,
  ZOMBIE_BOSS_EMOJI, ZOMBIE_EMOJIS,
  ZOMBIE_SPAWN_RADIUS,
  getZombieCount, getZombieBossCount, getZombieFormation,
  getZombieHp, getZombieBossHp,
  ZOMBIE_HORDE_TIMEOUT,
} from '../../config/constants.js';

// ── Spawn scout (starts a horde) ──
export async function spawnScout(playerTelegramId, centerLat, centerLng, io, connectedPlayers) {
  // Check no active horde for this player
  for (const h of gameState.zombieHordes.values()) {
    if (h.player_id === playerTelegramId && (h.status === 'scout' || h.status === 'active')) {
      return { error: 'Already have an active horde' };
    }
  }

  const nowISO = new Date().toISOString();
  const horde = {
    id: globalThis.crypto.randomUUID(),
    player_id: playerTelegramId,
    wave: 0,
    status: 'scout',
    center_lat: centerLat,
    center_lng: centerLng,
    last_attack_at: nowISO,
    created_at: nowISO,
  };

  await supabase.from('zombie_hordes').insert(horde);
  gameState.zombieHordes.set(horde.id, horde);

  // Spawn scout within 200m (50-150m away)
  const angle = Math.random() * Math.PI * 2;
  const dist = 50 + Math.random() * 100;
  const lat = centerLat + (dist / 111320) * Math.cos(angle);
  const lng = centerLng + (dist / (111320 * Math.cos(centerLat * Math.PI / 180))) * Math.sin(angle);

  const scout = {
    id: globalThis.crypto.randomUUID(),
    horde_id: horde.id,
    player_id: playerTelegramId,
    type: 'scout',
    emoji: ZOMBIE_SCOUT_EMOJI,
    hp: ZOMBIE_SCOUT_HP,
    max_hp: ZOMBIE_SCOUT_HP,
    attack: 0,
    lat, lng,
    speed: ZOMBIE_SCOUT_SPEED,
    alive: true,
    created_at: nowISO,
  };

  await supabase.from('zombies').insert(scout);
  gameState.zombies.set(scout.id, scout);

  // Notify player
  pushToPlayer(io, connectedPlayers, playerTelegramId, 'zombie:scout_spawned', {
    zombie_id: scout.id, horde_id: horde.id,
    lat: scout.lat, lng: scout.lng,
    emoji: scout.emoji, hp: scout.hp, max_hp: scout.max_hp,
  });

  console.log(`[ZOMBIES] Scout spawned for player ${playerTelegramId}`);
  return { ok: true, horde_id: horde.id, scout_id: scout.id };
}

// ── Scout killed → start wave 1 ──
export async function onScoutKilled(horde, io, connectedPlayers) {
  horde.status = 'active';
  horde.wave = 1;
  horde.last_attack_at = new Date().toISOString();
  gameState.markDirty('zombieHordes', horde.id);
  await supabase.from('zombie_hordes').update({ status: 'active', wave: 1 }).eq('id', horde.id);

  pushToPlayer(io, connectedPlayers, horde.player_id, 'zombie:horde_started', {
    horde_id: horde.id,
  });

  setTimeout(() => spawnWave(horde, io, connectedPlayers), 3000);
}

// ── Spawn a wave ──
export async function spawnWave(horde, io, connectedPlayers) {
  if (horde.status !== 'active') return;

  const wave = horde.wave;
  const normalCount = getZombieCount(wave);
  const bossCount = getZombieBossCount(wave);
  const formation = getZombieFormation(wave);
  const nowISO = new Date().toISOString();

  console.log(`[ZOMBIES] Wave ${wave}: ${normalCount} zombies + ${bossCount} bosses (${formation})`);

  const spawnedZombies = [];
  const normalHp = getZombieHp(wave);
  const positions = getFormationPositions(horde.center_lat, horde.center_lng, normalCount, formation);

  // Normal zombies
  for (let i = 0; i < normalCount; i++) {
    const pos = positions[i];
    const zombie = {
      id: globalThis.crypto.randomUUID(),
      horde_id: horde.id,
      player_id: horde.player_id,
      type: 'normal',
      emoji: ZOMBIE_EMOJIS[Math.floor(Math.random() * ZOMBIE_EMOJIS.length)],
      hp: normalHp,
      max_hp: normalHp,
      attack: ZOMBIE_NORMAL_DAMAGE,
      lat: pos.lat, lng: pos.lng,
      speed: ZOMBIE_NORMAL_SPEED,
      alive: true,
      created_at: nowISO,
    };
    gameState.zombies.set(zombie.id, zombie);
    spawnedZombies.push(zombie);
  }

  // Bosses
  for (let i = 0; i < bossCount; i++) {
    const angle = (Math.PI * 2 * i) / Math.max(bossCount, 1) + (Math.random() - 0.5) * 0.5;
    const dist = ZOMBIE_SPAWN_RADIUS * 0.8 + Math.random() * ZOMBIE_SPAWN_RADIUS * 0.3;
    const pos = calcPos(horde.center_lat, horde.center_lng, dist, angle);
    const bossHp = getZombieBossHp(wave);
    const boss = {
      id: globalThis.crypto.randomUUID(),
      horde_id: horde.id,
      player_id: horde.player_id,
      type: 'boss',
      emoji: ZOMBIE_BOSS_EMOJI,
      hp: bossHp,
      max_hp: bossHp,
      attack: ZOMBIE_NORMAL_DAMAGE * ZOMBIE_BOSS_DAMAGE_MULTIPLIER,
      lat: pos.lat, lng: pos.lng,
      speed: ZOMBIE_BOSS_SPEED,
      alive: true,
      created_at: nowISO,
    };
    gameState.zombies.set(boss.id, boss);
    spawnedZombies.push(boss);
  }

  // Batch insert to DB
  if (spawnedZombies.length > 0) {
    await supabase.from('zombies').insert(spawnedZombies);
  }

  horde.last_attack_at = nowISO;
  gameState.markDirty('zombieHordes', horde.id);

  pushToPlayer(io, connectedPlayers, horde.player_id, 'zombie:wave_spawned', {
    horde_id: horde.id,
    wave,
    zombies: spawnedZombies.map(z => ({
      id: z.id, type: z.type, emoji: z.emoji,
      lat: z.lat, lng: z.lng,
      hp: z.hp, max_hp: z.max_hp,
    })),
  });
}

// ── Check if wave is complete → start next ──
export async function checkWaveComplete(horde, io, connectedPlayers) {
  const alive = [...gameState.zombies.values()]
    .filter(z => z.horde_id === horde.id && z.alive);

  if (alive.length > 0) return false;

  horde.wave++;
  horde.last_attack_at = new Date().toISOString();
  gameState.markDirty('zombieHordes', horde.id);

  pushToPlayer(io, connectedPlayers, horde.player_id, 'zombie:wave_cleared', {
    horde_id: horde.id,
    next_wave: horde.wave,
  });

  setTimeout(() => spawnWave(horde, io, connectedPlayers), 5000);
  return true;
}

// ── Timeout: horde disperses if not attacked for 2 min ──
export async function checkHordeTimeout(horde, io, connectedPlayers) {
  if (horde.status !== 'active' && horde.status !== 'scout') return;

  const lastAttack = typeof horde.last_attack_at === 'string'
    ? new Date(horde.last_attack_at).getTime()
    : (horde.last_attack_at || 0);

  if (Date.now() - lastAttack < ZOMBIE_HORDE_TIMEOUT) return;

  console.log(`[ZOMBIES] Horde ${horde.id} timed out for player ${horde.player_id}`);

  // Kill all alive zombies in this horde
  for (const z of gameState.zombies.values()) {
    if (z.horde_id === horde.id && z.alive) {
      z.alive = false;
      gameState.zombies.delete(z.id);
    }
  }
  await supabase.from('zombies').update({ alive: false }).eq('horde_id', horde.id);

  horde.status = 'timeout';
  gameState.markDirty('zombieHordes', horde.id);
  await supabase.from('zombie_hordes').update({ status: 'timeout' }).eq('id', horde.id);

  pushToPlayer(io, connectedPlayers, horde.player_id, 'zombie:horde_timeout', {
    horde_id: horde.id,
  });

  // Tell all nearby players to remove markers
  io.emit('zombie:remove_all', { horde_id: horde.id });

  gameState.zombieHordes.delete(horde.id);
}

// ── Formation positions ──
function getFormationPositions(centerLat, centerLng, count, formation) {
  const positions = [];
  const R = ZOMBIE_SPAWN_RADIUS; // 700m
  const jitter = () => (Math.random() - 0.5) * R * 0.4; // big random offset

  if (formation === 'cluster') {
    const baseAngle = Math.random() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const angle = baseAngle + (Math.random() - 0.5) * 1.5;
      const dist = R * 0.5 + Math.random() * R * 0.6;
      const p = calcPos(centerLat, centerLng, dist, angle);
      positions.push(calcPos(p.lat, p.lng, Math.abs(jitter()) * 0.3, Math.random() * Math.PI * 2));
    }
  } else if (formation === 'line') {
    const baseAngle = Math.random() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const spread = (i - count / 2) * 15 + (Math.random() - 0.5) * 30;
      const dist = R * 0.7 + Math.random() * R * 0.4;
      positions.push(calcPos(centerLat, centerLng, dist, baseAngle + spread * 0.005));
    }
  } else if (formation === 'two_sides') {
    for (let i = 0; i < count; i++) {
      const side = i < count / 2 ? 0 : Math.PI;
      const angle = side + (Math.random() - 0.5) * 1.2;
      const dist = R * 0.6 + Math.random() * R * 0.5;
      positions.push(calcPos(centerLat, centerLng, dist, angle));
    }
  } else if (formation === 'three_sides') {
    for (let i = 0; i < count; i++) {
      const side = Math.floor(i / (count / 3)) * (Math.PI * 2 / 3);
      const angle = side + (Math.random() - 0.5) * 1.0;
      const dist = R * 0.6 + Math.random() * R * 0.5;
      positions.push(calcPos(centerLat, centerLng, dist, angle));
    }
  } else {
    // surround / chaos — scattered all around
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = R * 0.5 + Math.random() * R * 0.6;
      positions.push(calcPos(centerLat, centerLng, dist, angle));
    }
  }

  return positions;
}

function calcPos(lat, lng, distM, angle) {
  return {
    lat: lat + (distM / 111320) * Math.cos(angle),
    lng: lng + (distM / (111320 * Math.cos(lat * Math.PI / 180))) * Math.sin(angle),
  };
}

// Helper: push to a single player by telegram_id
function pushToPlayer(io, connectedPlayers, telegramId, event, data) {
  for (const [sid, info] of connectedPlayers) {
    if (String(info.telegram_id) === String(telegramId)) {
      io.to(sid).emit(event, data);
      break;
    }
  }
}
