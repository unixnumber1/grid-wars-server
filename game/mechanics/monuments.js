import { supabase } from '../../lib/supabase.js';
import { gameState } from '../state/GameState.js';
import { haversine } from '../../lib/haversine.js';
import { generateItem } from './items.js';
import { getCoreDropConfig, randomCoreType, CORE_TYPES } from './cores.js';
import {
  MONUMENT_HP, MONUMENT_SHIELD_HP, MONUMENT_SHIELD_DPS_THRESHOLD,
  MONUMENT_DPS_WINDOW_MS,
  MONUMENT_WAVE_COUNTS, MONUMENT_DEFENDER_HP, MONUMENT_DEFENDER_DAMAGE,
  MONUMENT_DEFENDER_SPEED, MONUMENT_WAVE_REGEN_PERCENT, MONUMENT_WAVE_TRIGGERS,
  MONUMENT_DEFENDER_ATTACK_CD, WAVE_EMOJIS,
  MONUMENT_GEMS_LOOT, MONUMENT_ITEMS_LOOT,
  MONUMENT_RESPAWN_HOURS_PER_LEVEL,
} from '../../config/constants.js';

// ── Emojis for defenders ──
export const MONUMENT_EMOJIS = ['🐲','⛄️','😡','😈','👿','👹','👺','🤡','💩','👻','💀','☠️','👽','👾','🤖','🎃','👁️','🧠','🧟','🧌','🧞'];

// ── Level config ──
export const MONUMENT_LEVELS = {
  1:  { hp: 50000,     max_shield_hp: 8000,     defenders_per_wave: [1,2],  defender_hp: 300,    defender_attack: 40   },
  2:  { hp: 120000,    max_shield_hp: 20000,    defenders_per_wave: [1,3],  defender_hp: 500,    defender_attack: 70   },
  3:  { hp: 280000,    max_shield_hp: 50000,    defenders_per_wave: [2,4],  defender_hp: 900,    defender_attack: 110  },
  4:  { hp: 600000,    max_shield_hp: 120000,   defenders_per_wave: [2,5],  defender_hp: 1800,   defender_attack: 160  },
  5:  { hp: 1200000,   max_shield_hp: 300000,   defenders_per_wave: [3,7],  defender_hp: 3500,   defender_attack: 240  },
  6:  { hp: 2500000,   max_shield_hp: 700000,   defenders_per_wave: [3,8],  defender_hp: 7000,   defender_attack: 340  },
  7:  { hp: 5000000,   max_shield_hp: 1500000,  defenders_per_wave: [4,10], defender_hp: 14000,  defender_attack: 480  },
  8:  { hp: 10000000,  max_shield_hp: 3500000,  defenders_per_wave: [5,13], defender_hp: 28000,  defender_attack: 680  },
  9:  { hp: 22000000,  max_shield_hp: 6000000,  defenders_per_wave: [6,16], defender_hp: 55000,  defender_attack: 960  },
  10: { hp: 40000000,  max_shield_hp: 10000000, defenders_per_wave: [8,20], defender_hp: 110000, defender_attack: 1360 },
};

export const MONUMENT_ATTACK_RADIUS = 500;
export const SHIELD_RESPAWN_HOURS = 168; // 7 days
export const OPEN_PHASE_TIMEOUT_HOURS = 4; // regen shield if not destroyed in 4h
export const WAVE_INTERVAL_SECONDS = 60;

// ── DPS tracking helpers ──
export function getMonumentAttackers(monument) {
  if (!monument._attackers) monument._attackers = new Map();
  return monument._attackers;
}

export function calcRaidDps(monument) {
  const attackers = getMonumentAttackers(monument);
  const now = Date.now();
  let totalDps = 0;
  for (const [, info] of attackers) {
    if (now - info.lastAttackAt < MONUMENT_DPS_WINDOW_MS) {
      totalDps += info.dps;
    }
  }
  return totalDps;
}

// ── Weekly reset (Sunday midnight MSK) ──
export async function resetMonuments() {
  console.log('[MONUMENTS] Weekly reset starting...');
  await supabase.from('monument_defenders').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('monument_raid_damage').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('monument_loot_boxes').delete().eq('opened', true);
  await supabase.from('monuments').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  gameState.monuments.clear();
  gameState.monumentDefenders.clear();
  gameState.monumentDamage.clear();
  gameState.activeWaves.clear();
  console.log('[MONUMENTS] Weekly reset complete — monuments will respawn as players connect');
}

// ── Check if a wave should trigger based on HP thresholds ──
export function checkWaveTrigger(monument) {
  const hpPercent = (monument.hp / monument.max_hp) * 100;
  if (!monument.waves_triggered) monument.waves_triggered = [];
  for (let i = 0; i < MONUMENT_WAVE_TRIGGERS.length; i++) {
    const threshold = MONUMENT_WAVE_TRIGGERS[i];
    if (hpPercent <= threshold && !monument.waves_triggered.includes(threshold)) {
      return i + 1; // waveNumber 1/2/3
    }
  }
  return null;
}

// ── Check if all defenders of current wave are dead ──
export function checkWaveComplete(monument, gameState, io, connectedPlayers) {
  const aliveCount = [...gameState.monumentDefenders.values()]
    .filter(d => d.monument_id === monument.id && d.alive).length;
  if (aliveCount > 0) return false;
  if (monument.phase === 'defeated') return false;

  monument.phase = 'open';
  monument.invulnerable = false;
  gameState.markDirty('monuments', monument.id);

  // Emit to raid participants
  if (io && connectedPlayers) {
    const dmgMap = gameState.monumentDamage.get(monument.id);
    if (dmgMap) {
      for (const [sid, info] of connectedPlayers) {
        if (!info.telegram_id) continue;
        if (dmgMap.has(Number(info.telegram_id)) || dmgMap.has(String(info.telegram_id))) {
          io.to(sid).emit('monument:wave_cleared', {
            monument_id: monument.id,
            wave: monument.waves_triggered?.length || 0,
          });
        }
      }
    }
  }

  console.log(`[MONUMENTS] Wave cleared for monument lv${monument.level} "${monument.name}"`);
  return true;
}

// ── Spawn a wave of defenders ──
export async function spawnDefenderWave(monument, waveNumber, io, connectedPlayers) {
  const waveCounts = MONUMENT_WAVE_COUNTS[monument.level] || MONUMENT_WAVE_COUNTS[1];
  const count = waveCounts[waveNumber - 1] || waveCounts[0];
  const defHp = MONUMENT_DEFENDER_HP[monument.level] || MONUMENT_DEFENDER_HP[1];
  const waveEmojiList = WAVE_EMOJIS[waveNumber] || WAVE_EMOJIS[1];

  const defenders = [];
  for (let i = 0; i < count; i++) {
    const emoji = waveEmojiList[Math.floor(Math.random() * waveEmojiList.length)];
    const angle = Math.random() * 2 * Math.PI;
    const dist = 50 + Math.random() * 150;
    const cosLat = Math.cos(monument.lat * Math.PI / 180);
    const lat = monument.lat + (dist / 111320) * Math.cos(angle);
    const lng = monument.lng + (dist / (111320 * cosLat)) * Math.sin(angle);

    const defender = {
      id: globalThis.crypto.randomUUID(),
      monument_id: monument.id,
      emoji,
      hp: defHp,
      max_hp: defHp,
      attack: MONUMENT_DEFENDER_DAMAGE,
      wave: waveNumber,
      lat, lng,
      alive: true,
      last_attack: 0,
      speed: MONUMENT_DEFENDER_SPEED,
      attack_cd: MONUMENT_DEFENDER_ATTACK_CD,
    };
    defenders.push(defender);
    gameState.monumentDefenders.set(defender.id, defender);
  }

  // Set monument to wave phase
  monument.phase = 'wave';
  monument.invulnerable = true;
  monument._wave_started_at = Date.now();
  gameState.markDirty('monuments', monument.id);

  // Save to DB (fire-and-forget)
  supabase.from('monument_defenders').insert(defenders).then(() => {}).catch(e => console.error('[MONUMENTS] defender insert error:', e.message));

  // Emit to raid participants
  if (io && connectedPlayers) {
    const dmgMap = gameState.monumentDamage.get(monument.id);
    if (dmgMap) {
      for (const [sid, info] of connectedPlayers) {
        if (!info.telegram_id) continue;
        if (dmgMap.has(Number(info.telegram_id)) || dmgMap.has(String(info.telegram_id))) {
          io.to(sid).emit('monument:wave_started', {
            monument_id: monument.id,
            wave: waveNumber,
            message: `⚠️ Волна ${waveNumber}! ${count} защитников!`,
            defenders: defenders.map(d => ({ id: d.id, emoji: d.emoji, lat: d.lat, lng: d.lng, hp: d.hp, max_hp: d.max_hp })),
          });
        }
      }
    }
  }

  console.log(`[MONUMENTS] Wave ${waveNumber} spawned for monument lv${monument.level}: ${count} defenders (HP: ${defHp})`);
  return defenders;
}

// ── Defeat monument — distribute loot ──
export async function defeatMonument(monument, io, connectedPlayers) {
  monument.phase = 'defeated';
  monument.hp = 0;

  // Dynamic respawn: hours = current level (lv10 resets to 24h)
  const respawnHours = MONUMENT_RESPAWN_HOURS_PER_LEVEL[monument.level] || 168;
  monument.respawn_at = new Date(Date.now() + respawnHours * 60 * 60 * 1000).toISOString();
  monument.last_defeated_at = new Date().toISOString();

  // Next level: lv1→lv2, ..., lv9→lv10, lv10→lv1
  monument._pending_level = monument.level >= 10 ? 1 : monument.level + 1;

  gameState.markDirty('monuments', monument.id);

  // Get all participants and their damage
  const damageMap = gameState.monumentDamage.get(monument.id) || new Map();
  const participants = [...damageMap.entries()]
    .map(([player_id, damage]) => ({ player_id, damage }))
    .sort((a, b) => b.damage - a.damage);

  if (participants.length === 0) return;

  const totalDamage = participants.reduce((s, p) => s + p.damage, 0);
  const gemsConfig = MONUMENT_GEMS_LOOT[monument.level];
  const itemsConfig = MONUMENT_ITEMS_LOOT[monument.level];

  // Roll gems once for the entire raid
  const totalGems = gemsConfig
    ? gemsConfig.min + Math.floor(Math.random() * (gemsConfig.max - gemsConfig.min + 1))
    : 1;

  // Build flat item pool sorted by rarity (best first) for proportional distribution
  const RARITY_ORDER = ['legendary', 'mythic', 'epic', 'rare', 'uncommon', 'common'];
  const itemPool = [];
  if (itemsConfig?.pool) {
    for (const entry of itemsConfig.pool) {
      if (entry.chance && Math.random() > entry.chance) continue;
      for (let j = 0; j < entry.count; j++) itemPool.push(entry.rarity);
    }
  }
  itemPool.sort((a, b) => RARITY_ORDER.indexOf(a) - RARITY_ORDER.indexOf(b));
  const totalPoolSize = itemPool.length;
  const lowestRarity = itemsConfig?.pool?.at(-1)?.rarity || 'rare';

  const lootBoxes = [];

  for (let i = 0; i < participants.length; i++) {
    const { player_id, damage } = participants[i];
    const player = gameState.getPlayerByTgId(player_id) || gameState.getPlayerById(player_id);
    if (!player) continue;

    const contribution = damage / totalDamage;
    const isTop = i === 0;
    const box_type = isTop ? 'trophy' : 'gift';

    // Gems proportional to damage (from shared pool)
    const playerGems = Math.max(1, Math.floor(totalGems * contribution));

    // Items — splice from pool proportionally (top players get best rarity first)
    const playerItemCount = Math.max(1, Math.floor(totalPoolSize * contribution));
    const playerRarities = itemPool.splice(0, playerItemCount);
    // If pool exhausted but player deserves minimum 1 — give lowest rarity
    if (playerRarities.length === 0) {
      playerRarities.push(lowestRarity);
    }
    const items = playerRarities.map(rarity => {
      const types = ['sword', 'axe', 'shield'];
      return generateItem(types[Math.floor(Math.random() * 3)], rarity);
    });

    // Trophy bonus for top-1 damage dealer
    if (isTop && itemsConfig?.trophyBonus) {
      const tb = itemsConfig.trophyBonus;
      if (!tb.chance || Math.random() <= tb.chance) {
        for (let j = 0; j < tb.count; j++) {
          const types = ['sword', 'axe', 'shield'];
          items.push(generateItem(types[Math.floor(Math.random() * 3)], tb.rarity));
        }
      }
    }

    // Create loot box near monument (slightly offset)
    const angle = (i / participants.length) * 2 * Math.PI;
    const cosLat = Math.cos(monument.lat * Math.PI / 180);
    const boxLat = monument.lat + (30 / 111320) * Math.cos(angle);
    const boxLng = monument.lng + (30 / (111320 * cosLat)) * Math.sin(angle);

    const box = {
      id: globalThis.crypto.randomUUID(),
      monument_id: monument.id,
      player_id: Number(player.telegram_id),
      player_name: player.game_username || player.username || '?',
      player_avatar: player.avatar || '🎮',
      box_type,
      monument_level: monument.level,
      gems: playerGems,
      items: JSON.stringify(items),
      opened: false,
      lat: boxLat,
      lng: boxLng,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
    lootBoxes.push(box);

    // Notify player
    if (io && connectedPlayers) {
      const socketId = _findPlayerSocket(connectedPlayers, player.telegram_id);
      if (socketId) {
        io.to(socketId).emit('monument:loot_dropped', {
          box_id: box.id,
          box_type,
          monument_level: monument.level,
          lat: boxLat,
          lng: boxLng,
          preview: { gems: playerGems, items_count: items.length },
        });
      }
    }
  }

  // Leftover pool items (from rounding) go to top player
  if (itemPool.length > 0 && lootBoxes.length > 0) {
    const topBox = lootBoxes[0];
    const topItems = JSON.parse(topBox.items);
    for (const rarity of itemPool) {
      const types = ['sword', 'axe', 'shield'];
      topItems.push(generateItem(types[Math.floor(Math.random() * 3)], rarity));
    }
    topBox.items = JSON.stringify(topItems);
  }

  // Save all boxes to DB
  supabase.from('monument_loot_boxes').insert(lootBoxes).then(() => {}).catch(e => console.error('[MONUMENTS] loot insert error:', e.message));

  // Also persist monument damage to DB
  const damageRows = [];
  for (const [pid, dmg] of damageMap) {
    damageRows.push({
      id: globalThis.crypto.randomUUID(),
      monument_id: monument.id,
      player_id: pid,
      damage_dealt: dmg,
      shield_damage: 0,
    });
  }
  if (damageRows.length) {
    supabase.from('monument_raid_damage').insert(damageRows).then(() => {}).catch(e => console.error('[monuments] DB error:', e.message));
  }

  // Emit defeat only to raid participants
  if (io && connectedPlayers) {
    const defeatedPayload = {
      monument_id: monument.id,
      level: monument.level,
      name: monument.name,
      winner_name: participants[0] ? (gameState.getPlayerByTgId(participants[0].player_id)?.game_username || '?') : '?',
      loot_boxes: lootBoxes.map(b => ({
        id: b.id,
        player_id: b.player_id,
        player_name: b.player_name,
        player_avatar: b.player_avatar,
        box_type: b.box_type,
        lat: b.lat,
        lng: b.lng,
      })),
    };
    for (const [sid, info] of connectedPlayers) {
      if (!info.telegram_id) continue;
      if (damageMap.has(Number(info.telegram_id)) || damageMap.has(String(info.telegram_id))) {
        io.to(sid).emit('monument:defeated', defeatedPayload);
      }
    }
  }

  // Clean up defenders BEFORE async operations to prevent race conditions
  for (const [did, d] of gameState.monumentDefenders) {
    if (d.monument_id === monument.id) {
      gameState.monumentDefenders.delete(did);
    }
  }
  gameState.activeWaves.delete(monument.id);

  // Add cores to loot boxes (proportionally by damage)
  await addCoresToLootBoxes(monument, participants, totalDamage, lootBoxes);

  gameState.monumentDamage.delete(monument.id);

  console.log(`[MONUMENTS] Monument lv${monument.level} "${monument.name}" defeated! ${participants.length} participants. Respawn in ${respawnHours}h as lv${monument._pending_level}`);
}

// ── Add cores into loot boxes (created when box is opened) ──
async function addCoresToLootBoxes(monument, participants, totalDamage, lootBoxes) {
  const dropCfg = getCoreDropConfig(monument.level);
  if (Math.random() >= dropCfg.chance) {
    console.log(`[CORES] Монумент lv${monument.level} — ядра не выпали (шанс ${Math.round(dropCfg.chance * 100)}%)`);
    return;
  }

  const totalCores = dropCfg.min + Math.floor(Math.random() * (dropCfg.max - dropCfg.min + 1));

  // Distribute cores proportionally by damage; top-1 always gets at least one
  let remaining = totalCores;

  for (let i = 0; i < participants.length && remaining > 0; i++) {
    const { player_id, damage } = participants[i];
    const box = lootBoxes.find(b => Number(b.player_id) === Number(player_id));
    if (!box) continue;

    // Top-1 guaranteed at least 1 core; others get proportional share (may be 0)
    let count;
    if (i === 0) {
      count = Math.max(1, Math.round(totalCores * (damage / totalDamage)));
    } else {
      count = Math.round(totalCores * (damage / totalDamage));
    }
    count = Math.min(remaining, count);
    if (count === 0) continue;

    const items = typeof box.items === 'string' ? JSON.parse(box.items) : (box.items || []);
    for (let j = 0; j < count; j++) {
      const coreType = randomCoreType();
      items.push({ _type: 'core', core_type: coreType, level: 0, emoji: CORE_TYPES[coreType].emoji, name: CORE_TYPES[coreType].name });
    }
    box.items = JSON.stringify(items);
    remaining -= count;

    // Update the already-inserted DB row
    supabase.from('monument_loot_boxes').update({ items: box.items }).eq('id', box.id).then(() => {}).catch(e => console.error('[monuments] DB error:', e.message));
  }

  // Remaining cores go to top player
  if (remaining > 0 && lootBoxes.length > 0) {
    const topBox = lootBoxes[0];
    const items = typeof topBox.items === 'string' ? JSON.parse(topBox.items) : (topBox.items || []);
    for (let j = 0; j < remaining; j++) {
      const coreType = randomCoreType();
      items.push({ _type: 'core', core_type: coreType, level: 0, emoji: CORE_TYPES[coreType].emoji, name: CORE_TYPES[coreType].name });
    }
    topBox.items = JSON.stringify(items);
    supabase.from('monument_loot_boxes').update({ items: topBox.items }).eq('id', topBox.id).then(() => {}).catch(e => console.error('[monuments] DB error:', e.message));
  }

  console.log(`[CORES] Монумент lv${monument.level} — ${totalCores} ядер добавлены в лут-боксы`);
}

// ── Helper: find socket ID for a telegram_id ──
function _findPlayerSocket(connectedPlayers, telegramId) {
  if (!connectedPlayers) return null;
  for (const [sid, info] of connectedPlayers) {
    if (String(info.telegram_id) === String(telegramId)) return sid;
  }
  return null;
}

// ── Get players near a monument (for defender attacks) ──
export function getPlayersNearMonument(monument, connectedPlayers) {
  const nearby = [];
  if (!connectedPlayers) return nearby;
  for (const [sid, info] of connectedPlayers) {
    if (!info.lat || !info.lng || !info.telegram_id) continue;
    const dist = haversine(monument.lat, monument.lng, info.lat, info.lng);
    if (dist <= MONUMENT_ATTACK_RADIUS) {
      const player = gameState.getPlayerByTgId(info.telegram_id);
      if (!player) continue;
      if (player.is_dead) continue;
      const maxHp = 1000 + (player.bonus_hp || 0);
      const hp = player.hp ?? maxHp;
      if (hp <= 0) continue;
      // Check not shielded
      if (player.shield_until && new Date(player.shield_until) > new Date()) continue;
      // Return the ORIGINAL player ref (not a copy) + socketId
      player._socketId = sid;
      nearby.push(player);
    }
  }
  return nearby;
}
