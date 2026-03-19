import { supabase } from '../../lib/supabase.js';
import { gameState } from '../state/GameState.js';
import { haversine } from '../../lib/haversine.js';
import { getCellId, getCellCenter } from '../../lib/grid.js';
import { generateItem } from './items.js';
import {
  MONUMENT_HP, MONUMENT_SHIELD_HP, MONUMENT_SHIELD_DPS_THRESHOLD,
  MONUMENT_DPS_WINDOW_MS,
} from '../../config/constants.js';

// ── Emojis for defenders ──
export const MONUMENT_EMOJIS = ['🐲','⛄️','😡','😈','👿','👹','👺','🤡','💩','👻','💀','☠️','👽','👾','🤖','🎃','👁️','🧠','🧟','🧌','🧞'];

// ── Level config ──
export const MONUMENT_LEVELS = {
  1:  { hp: 50000,     max_shield_hp: 8000,     defenders_per_wave: [1,2],  defender_hp: 300,    defender_attack: 20,  gems: [30,60]    },
  2:  { hp: 120000,    max_shield_hp: 20000,    defenders_per_wave: [1,3],  defender_hp: 500,    defender_attack: 35,  gems: [60,100]   },
  3:  { hp: 280000,    max_shield_hp: 50000,    defenders_per_wave: [2,4],  defender_hp: 900,    defender_attack: 55,  gems: [100,200]  },
  4:  { hp: 600000,    max_shield_hp: 120000,   defenders_per_wave: [2,5],  defender_hp: 1800,   defender_attack: 80,  gems: [200,350]  },
  5:  { hp: 1200000,   max_shield_hp: 300000,   defenders_per_wave: [3,7],  defender_hp: 3500,   defender_attack: 120, gems: [350,600]  },
  6:  { hp: 2500000,   max_shield_hp: 700000,   defenders_per_wave: [3,8],  defender_hp: 7000,   defender_attack: 170, gems: [600,1000] },
  7:  { hp: 5000000,   max_shield_hp: 1500000,  defenders_per_wave: [4,10], defender_hp: 14000,  defender_attack: 240, gems: [1000,1500]},
  8:  { hp: 10000000,  max_shield_hp: 3500000,  defenders_per_wave: [5,13], defender_hp: 28000,  defender_attack: 340, gems: [1500,2500]},
  9:  { hp: 22000000,  max_shield_hp: 6000000,  defenders_per_wave: [6,16], defender_hp: 55000,  defender_attack: 480, gems: [2500,3500]},
  10: { hp: 40000000,  max_shield_hp: 10000000, defenders_per_wave: [8,20], defender_hp: 110000, defender_attack: 680, gems: [3500,5000]},
};

// ── Loot table by monument level ──
export const MONUMENT_LOOT_TABLE = {
  1:  [{ rarity: 'rare', count: 1 }, { rarity: 'epic', count: 1 }],
  2:  [{ rarity: 'rare', count: 1 }, { rarity: 'epic', count: 2 }],
  3:  [{ rarity: 'epic', count: 2 }, { rarity: 'epic', count: 1 }],
  4:  [{ rarity: 'epic', count: 2 }, { rarity: 'mythic', count: 1 }],
  5:  [{ rarity: 'mythic', count: 2 }, { rarity: 'mythic', count: 1 }],
  6:  [{ rarity: 'mythic', count: 2 }, { rarity: 'legendary', count: 1, chance: 0.3 }],
  7:  [{ rarity: 'legendary', count: 1 }, { rarity: 'mythic', count: 1 }],
  8:  [{ rarity: 'legendary', count: 2 }],
  9:  [{ rarity: 'legendary', count: 3 }],
  10: [{ rarity: 'legendary', count: 4 }, { rarity: 'legendary', count: 1 }],
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

// ── Weighted random level ──
function randomMonumentLevel() {
  const r = Math.random() * 100;
  if (r < 50) return 1 + Math.floor(Math.random() * 3);       // 1-3: 50%
  if (r < 85) return 4 + Math.floor(Math.random() * 4);       // 4-7: 35%
  return 8 + Math.floor(Math.random() * 3);                    // 8-10: 15%
}

// ── Forbidden places filter ──
function isForbiddenPlace(tags) {
  if (!tags) return false;
  if (tags.religion) return true;
  if (tags.amenity === 'place_of_worship') return true;
  if (['war_memorial', 'battlefield', 'wayside_cross', 'wayside_shrine'].includes(tags.historic)) return true;
  if (tags.historic === 'memorial' && tags.memorial === 'war_memorial') return true;
  if (['church', 'cathedral', 'mosque', 'temple', 'chapel'].includes(tags.building)) return true;
  return false;
}

// ── Spawn monuments via Overpass API ──
export async function spawnMonuments() {
  console.log('[MONUMENTS] Starting spawn...');

  // Gather all HQ positions as anchor points
  const allHqs = [...gameState.headquarters.values()].map(h => ({ lat: h.lat, lng: h.lng }));
  if (!allHqs.length) {
    console.log('[MONUMENTS] No HQs found, skipping spawn');
    return;
  }

  // Existing monuments
  const existingMonuments = [...gameState.monuments.values()];
  const MIN_DISTANCE_BETWEEN = 1000; // 1km min between monuments
  const MAX_DISTANCE = 5000;

  let spawned = 0;

  // Cluster HQs within 5km
  const clusters = [];
  for (const hq of allHqs) {
    if (!hq.lat || !hq.lng) continue;
    const existing = clusters.find(c => haversine(hq.lat, hq.lng, c.lat, c.lng) <= MAX_DISTANCE);
    if (existing) {
      existing.count++;
      existing.lat = (existing.lat * (existing.count - 1) + hq.lat) / existing.count;
      existing.lng = (existing.lng * (existing.count - 1) + hq.lng) / existing.count;
    } else {
      clusters.push({ lat: hq.lat, lng: hq.lng, count: 1 });
    }
  }

  for (const cluster of clusters) {
    // Check if already have monuments near this cluster
    const nearbyMonuments = existingMonuments.filter(m => haversine(cluster.lat, cluster.lng, m.lat, m.lng) <= MAX_DISTANCE);
    if (nearbyMonuments.length >= 3) continue; // max 3 per cluster

    // Query Overpass for urban landmarks (no religious/memorial places)
    const query = `
      [out:json][timeout:15];
      (
        nwr["tourism"="attraction"](around:${MAX_DISTANCE},${cluster.lat},${cluster.lng});
        nwr["tourism"="museum"](around:${MAX_DISTANCE},${cluster.lat},${cluster.lng});
        nwr["tourism"="gallery"](around:${MAX_DISTANCE},${cluster.lat},${cluster.lng});
        nwr["tourism"="viewpoint"](around:${MAX_DISTANCE},${cluster.lat},${cluster.lng});
        nwr["historic"="castle"](around:${MAX_DISTANCE},${cluster.lat},${cluster.lng});
        nwr["historic"="fort"](around:${MAX_DISTANCE},${cluster.lat},${cluster.lng});
        nwr["historic"="ruins"](around:${MAX_DISTANCE},${cluster.lat},${cluster.lng});
        nwr["historic"="archaeological_site"](around:${MAX_DISTANCE},${cluster.lat},${cluster.lng});
        nwr["historic"="manor"](around:${MAX_DISTANCE},${cluster.lat},${cluster.lng});
        nwr["historic"="palace"](around:${MAX_DISTANCE},${cluster.lat},${cluster.lng});
        nwr["historic"="monument"]["name"](around:${MAX_DISTANCE},${cluster.lat},${cluster.lng});
        nwr["historic"="memorial"]["name"](around:${MAX_DISTANCE},${cluster.lat},${cluster.lng});
        nwr["amenity"="theatre"](around:${MAX_DISTANCE},${cluster.lat},${cluster.lng});
        nwr["amenity"="arts_centre"](around:${MAX_DISTANCE},${cluster.lat},${cluster.lng});
        nwr["amenity"="fountain"]["name"](around:${MAX_DISTANCE},${cluster.lat},${cluster.lng});
        nwr["leisure"="park"]["name"](around:${MAX_DISTANCE},${cluster.lat},${cluster.lng});
        nwr["building"="civic"]["name"](around:${MAX_DISTANCE},${cluster.lat},${cluster.lng});
      );
      out center 100;
    `;

    let osmPoints = [];
    try {
      const resp = await fetch(
        `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`,
        { signal: AbortSignal.timeout(20000) }
      );
      if (resp.ok) {
        const data = await resp.json();
        osmPoints = (data.elements || [])
          .filter(el => (el.lat && el.lon) || (el.center?.lat && el.center?.lon))
          .filter(el => !isForbiddenPlace(el.tags || {}))
          .filter(el => el.tags?.name)
          .map(el => {
            const lat = el.center?.lat ?? el.lat;
            const lng = el.center?.lon ?? el.lon;
            return { lat, lng, name: el.tags.name };
          });
      }
    } catch (e) {
      console.error('[MONUMENTS] Overpass error:', e.message);
    }

    // Fallback: urban infrastructure (intersections, public buildings) — never random coords
    if (!osmPoints.length) {
      console.log(`[MONUMENTS] No landmarks near cluster ${cluster.lat.toFixed(4)},${cluster.lng.toFixed(4)}, trying urban fallback`);
      const fallbackQuery = `
        [out:json][timeout:15];
        (
          node["highway"="traffic_signals"](around:${MAX_DISTANCE},${cluster.lat},${cluster.lng});
          nwr["building"="public"](around:${MAX_DISTANCE},${cluster.lat},${cluster.lng});
          nwr["building"="civic"](around:${MAX_DISTANCE},${cluster.lat},${cluster.lng});
          nwr["amenity"="community_centre"](around:${MAX_DISTANCE},${cluster.lat},${cluster.lng});
          nwr["leisure"="park"]["name"](around:${MAX_DISTANCE},${cluster.lat},${cluster.lng});
        );
        out center 50;
      `;
      try {
        const resp2 = await fetch(
          `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(fallbackQuery)}`,
          { signal: AbortSignal.timeout(20000) }
        );
        if (resp2.ok) {
          const data2 = await resp2.json();
          osmPoints = (data2.elements || [])
            .filter(el => (el.lat && el.lon) || (el.center?.lat && el.center?.lon))
            .filter(el => !isForbiddenPlace(el.tags || {}))
            .map(el => ({
              lat: el.center?.lat ?? el.lat,
              lng: el.center?.lon ?? el.lon,
              name: el.tags?.name || null,
            }));
        }
      } catch (e) {
        console.error('[MONUMENTS] Fallback Overpass error:', e.message);
      }
    }

    if (!osmPoints.length) {
      console.log(`[MONUMENTS] No urban points found near ${cluster.lat.toFixed(4)},${cluster.lng.toFixed(4)}, skipping cluster`);
      continue;
    }

    // Sort by distance from cluster center
    osmPoints.sort((a, b) => haversine(cluster.lat, cluster.lng, a.lat, a.lng) - haversine(cluster.lat, cluster.lng, b.lat, b.lng));

    const toSpawn = 3 - nearbyMonuments.length;
    let spawnedInCluster = 0;

    for (const pt of osmPoints) {
      if (spawnedInCluster >= toSpawn) break;

      const dist = haversine(cluster.lat, cluster.lng, pt.lat, pt.lng);
      if (dist < 200 || dist > MAX_DISTANCE) continue;

      // Check min distance from existing monuments
      const allMonuments = [...existingMonuments, ...([...gameState.monuments.values()])];
      const tooClose = allMonuments.some(m => haversine(pt.lat, pt.lng, m.lat, m.lng) < MIN_DISTANCE_BETWEEN);
      if (tooClose) continue;

      // Snap to hex cell center
      const cellId = getCellId(pt.lat, pt.lng);
      const [cLat, cLng] = getCellCenter(cellId);

      // Check cell not taken by another monument
      const cellTaken = allMonuments.some(m => m.cell_id === cellId);
      if (cellTaken) continue;

      // Replace mine in this cell if any
      const existingMine = gameState.getMineByCellId(cellId);
      if (existingMine) {
        gameState.removeMine(existingMine.id);
        supabase.from('mines').delete().eq('id', existingMine.id).then(() => {}).catch(() => {});
        if (existingMine.owner_id) {
          const notif = {
            id: globalThis.crypto.randomUUID(),
            player_id: existingMine.owner_id,
            type: 'mine_destroyed_by_monument',
            message: `🏛️ Монумент заменил вашу шахту Ур.${existingMine.level}!`,
            read: false,
            created_at: new Date().toISOString(),
          };
          gameState.addNotification(notif);
          supabase.from('notifications').insert(notif).then(() => {}).catch(() => {});
        }
      }

      const level = randomMonumentLevel();
      const cfg = MONUMENT_LEVELS[level];

      const monument = {
        lat: cLat,
        lng: cLng,
        cell_id: cellId,
        level,
        name: pt.name || 'Древний монумент',
        hp: cfg.hp,
        max_hp: cfg.hp,
        shield_hp: cfg.max_shield_hp,
        max_shield_hp: cfg.max_shield_hp,
        phase: 'shield',
      };

      const { data: inserted, error } = await supabase.from('monuments').insert(monument).select().single();
      if (error) {
        console.error('[MONUMENTS] insert error:', error.message);
        continue;
      }

      gameState.monuments.set(inserted.id, inserted);
      existingMonuments.push(inserted);
      spawnedInCluster++;
      spawned++;
      console.log(`[MONUMENTS] Spawned lv${level} "${inserted.name}" at ${pt.lat.toFixed(4)},${pt.lng.toFixed(4)}`);
    }
  }

  console.log(`[MONUMENTS] Spawn complete: ${spawned} new monuments`);
}

// ── Weekly reset (Sunday midnight MSK) ──
export async function resetMonuments() {
  console.log('[MONUMENTS] Weekly reset starting...');

  // Delete all from DB
  await supabase.from('monument_defenders').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('monument_raid_damage').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('monument_loot_boxes').delete().eq('opened', true);
  await supabase.from('monuments').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  // Clear gameState
  gameState.monuments.clear();
  gameState.monumentDefenders.clear();
  gameState.monumentDamage.clear();
  gameState.activeWaves.clear();

  // Spawn new
  await spawnMonuments();
  console.log('[MONUMENTS] Weekly reset complete');
}

// ── Spawn a wave of defenders ──
export async function spawnDefenderWave(monument, waveNumber, io, connectedPlayers) {
  const levelConfig = MONUMENT_LEVELS[monument.level];
  const [minCount, maxCount] = levelConfig.defenders_per_wave;
  const count = Math.min(maxCount, minCount + Math.floor(waveNumber / 3));

  const defenders = [];
  for (let i = 0; i < count; i++) {
    const emoji = MONUMENT_EMOJIS[Math.floor(Math.random() * MONUMENT_EMOJIS.length)];
    const angle = Math.random() * 2 * Math.PI;
    const dist = 50 + Math.random() * 150;
    const cosLat = Math.cos(monument.lat * Math.PI / 180);
    const lat = monument.lat + (dist / 111320) * Math.cos(angle);
    const lng = monument.lng + (dist / (111320 * cosLat)) * Math.sin(angle);

    const defender = {
      id: globalThis.crypto.randomUUID(),
      monument_id: monument.id,
      emoji,
      hp: levelConfig.defender_hp,
      max_hp: levelConfig.defender_hp,
      attack: levelConfig.defender_attack,
      wave: waveNumber,
      lat, lng,
      alive: true,
    };
    defenders.push(defender);
    gameState.monumentDefenders.set(defender.id, defender);
  }

  // Save to DB (fire-and-forget)
  supabase.from('monument_defenders').insert(defenders).then(() => {}).catch(e => console.error('[MONUMENTS] defender insert error:', e.message));

  // Emit only to raid participants
  if (io && connectedPlayers) {
    const dmgMap = gameState.monumentDamage.get(monument.id);
    if (dmgMap) {
      for (const [sid, info] of connectedPlayers) {
        if (!info.telegram_id) continue;
        if (dmgMap.has(Number(info.telegram_id)) || dmgMap.has(String(info.telegram_id))) {
          io.to(sid).emit('monument:wave_spawn', {
            monument_id: monument.id,
            wave: waveNumber,
            defenders: defenders.map(d => ({ id: d.id, emoji: d.emoji, lat: d.lat, lng: d.lng, hp: d.hp, max_hp: d.max_hp })),
          });
        }
      }
    }
  }

  console.log(`[MONUMENTS] Wave ${waveNumber} spawned for monument lv${monument.level}: ${count} defenders`);
  return defenders;
}

// ── Defeat monument — distribute loot ──
export async function defeatMonument(monument, io, connectedPlayers) {
  monument.phase = 'defeated';
  monument.hp = 0;
  monument.respawn_at = new Date(Date.now() + SHIELD_RESPAWN_HOURS * 60 * 60 * 1000).toISOString();
  gameState.markDirty('monuments', monument.id);

  // Get all participants and their damage
  const damageMap = gameState.monumentDamage.get(monument.id) || new Map();
  const participants = [...damageMap.entries()]
    .map(([player_id, damage]) => ({ player_id, damage }))
    .sort((a, b) => b.damage - a.damage);

  if (participants.length === 0) return;

  const totalDamage = participants.reduce((s, p) => s + p.damage, 0);
  const levelConfig = MONUMENT_LEVELS[monument.level];
  const lootTable = MONUMENT_LOOT_TABLE[monument.level];

  const lootBoxes = [];

  for (let i = 0; i < participants.length; i++) {
    const { player_id, damage } = participants[i];
    const player = gameState.getPlayerByTgId(player_id) || gameState.getPlayerById(player_id);
    if (!player) continue;

    const contribution = damage / totalDamage;
    const isTop = i === 0;
    const box_type = isTop ? 'trophy' : 'gift';

    // Gems proportional to damage
    const [minGems, maxGems] = levelConfig.gems;
    const totalGems = minGems + Math.floor(Math.random() * (maxGems - minGems));
    const playerGems = Math.max(1, Math.floor(totalGems * contribution));

    // Items — top player gets more
    const items = [];
    for (const lootEntry of lootTable) {
      const cnt = isTop ? lootEntry.count : Math.max(1, Math.floor(lootEntry.count * contribution * 2));
      if (lootEntry.chance && Math.random() > lootEntry.chance) continue;
      for (let j = 0; j < cnt; j++) {
        const types = ['sword', 'axe', 'shield'];
        const type = types[Math.floor(Math.random() * types.length)];
        items.push(generateItem(type, lootEntry.rarity));
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
    supabase.from('monument_raid_damage').insert(damageRows).then(() => {}).catch(() => {});
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

  // Clean up defenders
  for (const [did, d] of gameState.monumentDefenders) {
    if (d.monument_id === monument.id) {
      gameState.monumentDefenders.delete(did);
    }
  }
  gameState.activeWaves.delete(monument.id);
  gameState.monumentDamage.delete(monument.id);

  console.log(`[MONUMENTS] Monument lv${monument.level} "${monument.name}" defeated! ${participants.length} participants`);
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
