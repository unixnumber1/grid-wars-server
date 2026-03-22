import { supabase } from '../../lib/supabase.js';
import { gameState } from '../state/GameState.js';
import { log } from '../../lib/log.js';
import { BOT_TYPES, getRandomBotType } from '../mechanics/bots.js';
import { haversine } from '../../lib/haversine.js';
import { getMineIncome, getMineHp, getMineHpRegen, calcMineHpRegen, xpForLevel, SMALL_RADIUS, LARGE_RADIUS } from '../../config/formulas.js';
import { getCellsInRange } from '../../lib/grid.js';
import { dailyMarketCheck } from '../mechanics/market.js';
import { getShieldRegen, MONUMENT_SHIELD_DPS_THRESHOLD } from '../../config/constants.js';
import { ts } from '../../config/i18n.js';
import { calcRaidDps } from '../mechanics/monuments.js';
import { checkHordeTimeout } from '../mechanics/zombies.js';
import { ZOMBIE_ATTACK_RANGE, ZOMBIE_NORMAL_DAMAGE } from '../../config/constants.js';

const TICK_INTERVAL = 5000;
const BOTS_PER_ZONE = 10;
const BOT_TTL_MS = 5 * 60 * 1000;
const GLOBAL_BOT_CAP = 20;
const SPEED_METERS = { slow: 15, medium: 30, fast: 55, very_fast: 90 };
const DRAIN_LIMITS = { goblin: 150 };

let _tickCount = 0;
let _lastDailyMarketCheck = 0; // timestamp of last daily market check
let _io = null;

function hasChanged(prev, curr) {
  return JSON.stringify(prev) !== JSON.stringify(curr);
}

export function startGameLoop(io, connectedPlayers) {
  _io = io;
  log('[gameLoop] Starting game loop, interval:', TICK_INTERVAL, 'ms');

  setInterval(async () => {
    if (connectedPlayers.size === 0) return;

    const nowMs = Date.now();
    const nowISO = new Date(nowMs).toISOString();
    _tickCount++;

    try {
      // ── 1. Move bots globally ──────────────────────────────
      await moveBots(nowMs, nowISO);

      // ── 2. Monument shield regen ─────────────────────────
      processMonumentShieldRegen();

      // ── 3. Move couriers ───────────────────────────────────
      await moveCouriers(nowMs, nowISO);

      // ── 3b. Move zombies + check timeout ──────────────────
      moveZombies(nowMs, connectedPlayers);
      if (_tickCount % 12 === 0) { // every ~1 min
        for (const horde of [...gameState.zombieHordes.values()]) {
          await checkHordeTimeout(horde, _io, connectedPlayers);
        }
      }

      // ── 4. Periodic cleanup every 60 ticks (~5 min) ───────
      if (_tickCount % 60 === 0) {
        await periodicCleanup(nowMs, nowISO);
      }

      // ── 5. Send state to each connected player ─────────────
      for (const [socketId, playerInfo] of connectedPlayers) {
        if (!playerInfo.lat || !playerInfo.lng) continue;

        try {
          const state = await buildPlayerState(playerInfo, nowMs, nowISO);
          if (state && hasChanged(playerInfo.lastState, state)) {
            io.to(socketId).emit('tick', state);
            playerInfo.lastState = state;
          }
        } catch (e) {
          // Skip this player on error
        }
      }
    } catch (e) {
      console.error('[gameLoop] tick error:', e.message);
    }
  }, TICK_INTERVAL);
}

function processMonumentShieldRegen() {
  for (const [id, monument] of gameState.monuments) {
    if (monument.phase !== 'shield') continue;
    if (monument.shield_hp >= monument.max_shield_hp) continue;
    const totalDps = calcRaidDps(monument);
    const threshold = MONUMENT_SHIELD_DPS_THRESHOLD[monument.level] || 0;
    if (totalDps < threshold) {
      const regenPerSec = getShieldRegen(monument.level);
      const regenAmount = Math.floor(regenPerSec * 5); // 5s tick
      monument.shield_hp = Math.min(monument.max_shield_hp, monument.shield_hp + regenAmount);
      gameState.markDirty('monuments', id);
    }
  }
}

async function moveBots(nowMs, nowISO) {
  try {
    const lastMove = parseInt(gameState.getSetting('last_bots_move') || '0');
    if (nowMs - lastMove < 8000) return;
    gameState.setSetting('last_bots_move', nowMs.toString());

    const allBots = gameState.getAllAliveBots(nowISO);
    if (!allBots.length) {
      gameState.purgeExpiredBots(nowISO);
      return;
    }

    const allMines = [...gameState.mines.values()];
    const mineMap = {};
    for (const m of allMines) mineMap[m.id] = m;

    const updates = [];
    const minesToDrain = new Map();

    for (const bot of allBots) {
      const cfg = BOT_TYPES[bot.type] || {};
      const speedM = SPEED_METERS[cfg.speed || bot.speed] || 30;
      const cosLat = Math.cos(bot.lat * Math.PI / 180);
      const stepLat = speedM / 111000;
      const stepLng = speedM / (111000 * (cosLat || 1));
      const spawnLat = bot.spawn_lat ?? bot.lat;
      const spawnLng = bot.spawn_lng ?? bot.lng;

      let newLat = bot.lat, newLng = bot.lng;
      let newDir = bot.direction ?? Math.random() * Math.PI * 2;
      let newStatus = bot.status || 'roaming';
      let newTarget = bot.target_mine_id;
      let newDrained = bot.drained_amount || 0;
      const isUndead = bot.category === 'undead';

      function smoothStep(dir) {
        const shouldTurn = Math.random() < 0.05;
        const turnAmount = (Math.random() - 0.5) * 0.3;
        const d = shouldTurn ? dir + turnAmount : dir;
        return { lat: bot.lat + Math.cos(d) * stepLat, lng: bot.lng + Math.sin(d) * stepLng, dir: d };
      }

      if (isUndead && newStatus === 'attacking' && newTarget) {
        const target = mineMap[newTarget];
        if (!target) {
          newStatus = 'roaming'; newTarget = null;
          const ss = smoothStep(newDir); newLat = ss.lat; newLng = ss.lng; newDir = ss.dir;
        } else {
          const dLat = target.lat - bot.lat, dLng = target.lng - bot.lng;
          const distM = haversine(bot.lat, bot.lng, target.lat, target.lng);
          newDir = Math.atan2(dLng, dLat);
          if (distM < 100) { // drain only within 100m
            const drainAmt = (bot.drain_per_sec || cfg.drain_per_sec || 0) * 3;
            newDrained += drainAmt;
            if (drainAmt > 0) minesToDrain.set(newTarget, (minesToDrain.get(newTarget) || 0) + drainAmt);
            newLat = bot.lat + (Math.random() - 0.5) * stepLat * 0.3;
            newLng = bot.lng + (Math.random() - 0.5) * stepLng * 0.3;
            // Random chance to flee with loot (higher chance the more stolen)
            if (newDrained > 0 && Math.random() < 0.03) {
              newStatus = 'leaving'; newTarget = null;
            }
          } else {
            newLat = bot.lat + Math.cos(newDir) * stepLat;
            newLng = bot.lng + Math.sin(newDir) * stepLng;
          }
        }
      } else if (isUndead && newStatus === 'leaving') {
        const ss = smoothStep(newDir); newLat = ss.lat; newLng = ss.lng; newDir = ss.dir;
        if (Math.random() < 0.09) newStatus = 'roaming';
      } else {
        const ss = smoothStep(newDir); newLat = ss.lat; newLng = ss.lng; newDir = ss.dir;
        if (isUndead && allMines.length > 0 && Math.random() < 0.15) {
          // Aggro to mines within 500m
          const nearbyMines = allMines.filter(m => haversine(bot.lat, bot.lng, m.lat, m.lng) <= 500);
          if (nearbyMines.length > 0) {
            const target = nearbyMines[Math.floor(Math.random() * nearbyMines.length)];
            newStatus = 'attacking'; newTarget = target.id; newDrained = 0;
            newDir = Math.atan2(target.lng - bot.lng, target.lat - bot.lat);
          }
        }
      }

      const distFromSpawn = haversine(spawnLat, spawnLng, newLat, newLng);
      if (distFromSpawn > 3000) {
        const backAngle = Math.atan2(spawnLng - bot.lng, spawnLat - bot.lat) + (Math.random() - 0.5) * 0.5;
        newLat = bot.lat + Math.cos(backAngle) * stepLat;
        newLng = bot.lng + Math.sin(backAngle) * stepLng;
        newDir = backAngle;
      }

      // Keep base emoji — frontend handles visual state indicators
      let newEmoji = cfg.emoji || bot.emoji;

      updates.push({ id: bot.id, lat: newLat, lng: newLng, direction: newDir, status: newStatus, target_mine_id: newTarget, drained_amount: newDrained, emoji: newEmoji });
    }

    // Update in-memory gameState instead of writing to DB
    for (const u of updates) {
      const bot = gameState.bots.get(u.id);
      if (bot) {
        Object.assign(bot, { lat: u.lat, lng: u.lng, direction: u.direction, status: u.status, target_mine_id: u.target_mine_id, drained_amount: u.drained_amount, emoji: u.emoji });
        gameState.markDirty('bots', u.id);
      }
    }

    if (minesToDrain.size > 0) {
      for (const mineId of minesToDrain.keys()) {
        const mine = gameState.mines.get(mineId);
        if (mine) {
          mine.last_collected = nowISO;
          gameState.markDirty('mines', mineId);
        }
      }
    }

    gameState.purgeExpiredBots(nowISO);
  } catch (e) {
    console.error('[gameLoop] bot move error:', e.message);
  }
}

async function moveCouriers(nowMs, nowISO) {
  try {
    const couriers = gameState.getMovingCouriers();
    if (!couriers.length) return;

    const cUpdates = [];
    const cArrived = [];

    for (const c of couriers) {
      const routeLat = c.target_lat - c.start_lat;
      const routeLng = c.target_lng - c.start_lng;
      const routeDist = Math.sqrt(routeLat * routeLat + routeLng * routeLng);
      if (routeDist < 0.0001) { cArrived.push(c); continue; }
      const speedDegPerSec = (c.speed || 0.0002) / 4;
      const elapsedSec = (nowMs - new Date(c.created_at).getTime()) / 1000;
      const traveled = speedDegPerSec * elapsedSec;
      const progress = Math.min(traveled / routeDist, 1.0);
      const maxSec = c.type === 'to_market' ? 1800 : (c.speed <= 0.0003 ? 3600 : 300); // pedestrian 1h, truck 5min, seller 30min
      if (progress >= 0.99 || elapsedSec > maxSec) { cArrived.push(c); continue; }
      const newLat = c.start_lat + routeLat * progress;
      const newLng = c.start_lng + routeLng * progress;
      cUpdates.push({ id: c.id, current_lat: newLat, current_lng: newLng });
    }

    // Update positions in memory
    for (const u of cUpdates) {
      const c = gameState.couriers.get(u.id);
      if (c) { c.current_lat = u.current_lat; c.current_lng = u.current_lng; gameState.markDirty('couriers', c.id); }
    }

    // Mark arrived couriers as delivered in memory
    for (const c of cArrived) {
      const courier = gameState.couriers.get(c.id);
      if (courier) { courier.status = 'delivered'; gameState.markDirty('couriers', c.id); }
    }

    for (const dc of cArrived) {
      try {
        if (dc.type === 'to_market' && dc.listing_id) {
          const listing = gameState.getListingById(dc.listing_id);
          if (listing && listing.status === 'pending') {
            listing.status = 'active';
            gameState.markDirty('marketListings', listing.id);
          }
          if (dc.item_id) {
            const item = gameState.getItemById(dc.item_id);
            if (item) { item.held_by_courier = null; item.held_by_market = dc.to_market_id || null; gameState.markDirty('items', item.id); }
          }
          // Write side-effects to DB
          supabase.from('market_listings').update({ status: 'active' }).eq('id', dc.listing_id).eq('status', 'pending').then(() => {}).catch(() => {});
          if (dc.item_id) supabase.from('items').update({ held_by_courier: null, held_by_market: dc.to_market_id || null }).eq('id', dc.item_id).then(() => {}).catch(() => {});
        } else if (dc.type === 'delivery' && dc._coins > 0) {
          // Collector coin delivery — create a coin drop on the ground
          const owner = gameState.getPlayerById(dc.owner_id);
          const dropLat = (owner?.last_lat ?? dc.target_lat) + (Math.random() - 0.5) * 0.0004;
          const dropLng = (owner?.last_lng ?? dc.target_lng) + (Math.random() - 0.5) * 0.0004;
          const drop = {
            id: globalThis.crypto.randomUUID(),
            courier_id: dc.id,
            item_id: null,
            listing_id: null,
            owner_id: dc.owner_id, // for pickup ownership check
            lat: dropLat,
            lng: dropLng,
            drop_type: 'coin_delivery',
            picked_up: false,
            expires_at: new Date(nowMs + 30 * 24 * 60 * 60 * 1000).toISOString(),
            created_at: nowISO,
            _coins: dc._coins, // in-memory only for pickup
          };
          gameState.upsertDrop(drop);
          supabase.from('courier_drops').insert({
            id: drop.id, courier_id: dc.id, owner_id: dc.owner_id, lat: dropLat, lng: dropLng,
            drop_type: 'coin_delivery', picked_up: false,
            expires_at: drop.expires_at, created_at: nowISO,
          }).then(() => {}).catch(() => {});
          const coinDelLang = gameState.getPlayerById(dc.owner_id)?.language || 'en';
          const notif = {
            id: globalThis.crypto.randomUUID(),
            player_id: dc.owner_id,
            type: 'collector_delivery',
            message: ts(coinDelLang, 'notif.coin_delivery', { coins: dc._coins }),
            read: false,
            created_at: nowISO,
          };
          gameState.addNotification(notif);
          supabase.from('notifications').insert(notif).then(() => {}).catch(() => {});
        } else if (dc.type === 'delivery') {
          const buyer = gameState.getPlayerById(dc.owner_id);
          const dropLat = (buyer?.last_lat ?? dc.target_lat) + (Math.random() - 0.5) * 0.0004;
          const dropLng = (buyer?.last_lng ?? dc.target_lng) + (Math.random() - 0.5) * 0.0004;
          const drop = {
            id: globalThis.crypto.randomUUID(),
            courier_id: dc.id,
            owner_id: dc.owner_id,
            item_id: dc.item_id,
            listing_id: dc.listing_id,
            lat: dropLat,
            lng: dropLng,
            drop_type: 'delivery',
            picked_up: false,
            expires_at: new Date(nowMs + 30 * 24 * 60 * 60 * 1000).toISOString(),
            created_at: nowISO,
          };
          gameState.upsertDrop(drop);
          // Also write to DB
          supabase.from('courier_drops').insert(drop).then(() => {}).catch(() => {});
          if (dc.item_id) {
            const item = gameState.getItemById(dc.item_id);
            if (item) { item.held_by_courier = null; item.held_by_market = null; gameState.markDirty('items', item.id); }
            supabase.from('items').update({ held_by_courier: null, held_by_market: null }).eq('id', dc.item_id).then(() => {}).catch(() => {});
          }
          const delLang = gameState.getPlayerById(dc.owner_id)?.language || 'en';
          const notif = {
            id: globalThis.crypto.randomUUID(),
            player_id: dc.owner_id,
            type: 'delivery_arrived',
            message: ts(delLang, 'notif.delivery_arrived'),
            read: false,
            created_at: nowISO,
          };
          gameState.addNotification(notif);
          supabase.from('notifications').insert(notif).then(() => {}).catch(() => {});
        }
      } catch (e) { console.error('[gameLoop] courier delivery error:', e.message); }

      // Remove delivered courier from memory immediately + notify clients
      gameState.couriers.delete(dc.id);
      supabase.from('couriers').delete().eq('id', dc.id).then(() => {}).catch(() => {});
      if (_io) _io.emit('courier:removed', { courier_id: dc.id });
    }
  } catch (e) {
    console.error('[gameLoop] courier move error:', e.message);
  }
}

// ── Move zombies toward player, scouts wander ──
function moveZombies(nowMs, connectedPlayers) {
  if (gameState.zombieHordes.size === 0) return; // early bail

  // Cache player socket+position per horde owner
  const ppCache = new Map();
  for (const h of gameState.zombieHordes.values()) {
    if (ppCache.has(h.player_id)) continue;
    for (const [sid, info] of connectedPlayers) {
      if (String(info.telegram_id) === String(h.player_id) && info.lat && info.lng) {
        ppCache.set(h.player_id, { lat: info.lat, lng: info.lng, sid });
        break;
      }
    }
  }

  if (_tickCount % 12 === 0) {
    console.log(`[ZOMBIE TICK] hordes=${gameState.zombieHordes.size} zombies=${gameState.zombies.size}`);
    for (const h of gameState.zombieHordes.values()) console.log(`  horde ${h.id.slice(0,8)} status=${h.status} player=${h.player_id} wave=${h.wave}`);
  }
  const moveBatch = new Map();
  const attacks = [];

  for (const zombie of gameState.zombies.values()) {
    if (!zombie.alive) { gameState.zombies.delete(zombie.id); continue; }

    const horde = gameState.zombieHordes.get(zombie.horde_id);
    if (!horde || (horde.status !== 'active' && horde.status !== 'scout')) continue;

    const ownerId = horde.player_id;

    // Scout: random wander
    if (zombie.type === 'scout') {
      const angle = Math.random() * Math.PI * 2;
      const stepM = (zombie.speed || 1.5) * 5;
      const cosLat = Math.cos(zombie.lat * Math.PI / 180);
      zombie.lat += (stepM / 111320) * Math.cos(angle);
      zombie.lng += (stepM / (111320 * cosLat)) * Math.sin(angle);
      if (!moveBatch.has(ownerId)) moveBatch.set(ownerId, []);
      moveBatch.get(ownerId).push({ id: zombie.id, lat: zombie.lat, lng: zombie.lng });
      continue;
    }

    const pp = ppCache.get(ownerId);
    if (!pp) continue;

    // Move toward player
    const dist = haversine(zombie.lat, zombie.lng, pp.lat, pp.lng);
    if (dist > 15) {
      const stepM = Math.min((zombie.speed || 15) * 5, dist);
      const ratio = stepM / dist;
      const dLat = pp.lat - zombie.lat;
      const dLng = pp.lng - zombie.lng;
      zombie.lat += dLat * ratio + (Math.random() - 0.5) * 0.00002;
      zombie.lng += dLng * ratio + (Math.random() - 0.5) * 0.00002;
    }

    // Each zombie attacks independently, 1 hit per tick
    if (_tickCount % 12 === 0 && zombie.type !== 'scout') {
      console.log(`[ZOMBIE DEBUG] id=${zombie.id.slice(0,8)} dist=${Math.round(dist)}m range=${ZOMBIE_ATTACK_RANGE} hp=${zombie.hp} attack=${zombie.attack}`);
    }
    if (dist < ZOMBIE_ATTACK_RANGE && nowMs - (zombie._lastAttack || 0) > 1000) {
      zombie._lastAttack = nowMs;
      attacks.push({ ownerId, sid: pp.sid, zombie, playerLat: pp.lat, playerLng: pp.lng });
    }

    if (!moveBatch.has(ownerId)) moveBatch.set(ownerId, []);
    moveBatch.get(ownerId).push({ id: zombie.id, lat: zombie.lat, lng: zombie.lng });
  }

  // Emit batched moves
  for (const [ownerId, moves] of moveBatch) {
    const pp = ppCache.get(ownerId);
    if (pp?.sid) _io.to(pp.sid).emit('zombie:move_batch', moves);
  }

  // Process each zombie attack individually
  for (const atk of attacks) {
    const player = gameState.getPlayerByTgId(Number(atk.ownerId));
    if (!player || player.hp <= 0) continue;
    if (player.hp == null) player.hp = player.max_hp || 1000;
    const dmg = Math.round((atk.zombie.attack || ZOMBIE_NORMAL_DAMAGE) * (0.8 + Math.random() * 0.4));
    player.hp = Math.max(0, player.hp - dmg);
    player.last_hp_regen = new Date().toISOString();
    gameState.markDirty('players', player.id);
    _io.to(atk.sid).emit('zombie:attack_player', {
      zombie_id: atk.zombie.id, damage: dmg,
      player_hp: player.hp, player_max_hp: player.max_hp || 1000,
    });
  }
}

async function periodicCleanup(nowMs, nowISO) {
  try {
    // Clean memory
    gameState.purgeExpiredBots(nowISO);

    // Remove delivered/killed/cancelled couriers from memory
    for (const [id, c] of gameState.couriers) {
      if (['delivered', 'killed', 'cancelled'].includes(c.status)) gameState.couriers.delete(id);
    }

    // Remove picked up drops from memory
    for (const [id, d] of gameState.courierDrops) {
      if (d.picked_up) gameState.courierDrops.delete(id);
    }

    // Remove read notifications from memory
    for (const [id, n] of gameState.notifications) {
      if (n.read) gameState.notifications.delete(id);
    }

    // DB cleanup
    await Promise.all([
      supabase.from('bots').delete().lt('expires_at', nowISO),
      supabase.from('couriers').delete().in('status', ['delivered', 'killed', 'cancelled']).lt('created_at', new Date(nowMs - 3600000).toISOString()),
      supabase.from('courier_drops').delete().eq('picked_up', true).lt('created_at', new Date(nowMs - 3600000).toISOString()),
      supabase.from('notifications').delete().eq('read', true).lt('created_at', new Date(nowMs - 86400000).toISOString()),
    ]);

    // Expire old listings
    const { data: expired } = await supabase.from('market_listings').select('id,item_id,seller_id')
      .in('status', ['active', 'pending']).lt('expires_at', nowISO).limit(50);
    if (expired?.length) {
      for (const listing of expired) {
        await Promise.all([
          supabase.from('market_listings').update({ status: 'expired' }).eq('id', listing.id),
          supabase.from('items').update({ on_market: false, held_by_courier: null, held_by_market: null }).eq('id', listing.item_id),
        ]);
        supabase.from('couriers').update({ status: 'cancelled' }).eq('listing_id', listing.id).eq('status', 'moving').then(() => {}).catch(() => {});
      }
    }

    // Expire loot drops
    const { data: expiredDrops } = await supabase.from('courier_drops').select('id,item_id')
      .eq('picked_up', false).not('expires_at', 'is', null).lt('expires_at', nowISO).limit(50);
    if (expiredDrops?.length) {
      for (const drop of expiredDrops) {
        await Promise.all([
          supabase.from('items').update({ on_market: false, held_by_courier: null, held_by_market: null }).eq('id', drop.item_id),
          supabase.from('courier_drops').update({ picked_up: true }).eq('id', drop.id),
        ]);
      }
    }

    // Reset stale under_attack mines back to normal (if attack_ends_at has passed)
    for (const m of gameState.mines.values()) {
      if (m.status !== 'under_attack') continue;
      if (m.attack_ends_at && new Date(m.attack_ends_at).getTime() < nowMs) {
        m.status = 'normal';
        m.attacker_id = null;
        m.attack_started_at = null;
        m.attack_ends_at = null;
        gameState.markDirty('mines', m.id);
      }
    }

    // Destroy burned mines from gameState (>24h burning)
    for (const m of gameState.mines.values()) {
      if (m.status !== 'burning' || !m.burning_started_at) continue;
      const burnedMs = nowMs - new Date(m.burning_started_at).getTime();
      if (burnedMs > 86400000) {
        m.status = 'destroyed';
        gameState.markDirty('mines', m.id);
        supabase.from('mines').update({ status: 'destroyed' }).eq('id', m.id).then(() => {}).catch(() => {});
        // Destroy installed cores
        if (m.cell_id) {
          const cores = gameState.getCoresForMine(m.cell_id);
          for (const c of cores) {
            gameState.cores.delete(c.id);
          }
          if (cores.length > 0) {
            supabase.from('cores').delete().eq('mine_cell_id', m.cell_id).then(() => {}).catch(() => {});
          }
        }
        const destroyLang = gameState.getPlayerById(m.owner_id)?.language || 'en';
        const notif = {
          id: globalThis.crypto.randomUUID(),
          player_id: m.owner_id,
          type: 'mine_destroyed',
          message: ts(destroyLang, 'notif.mine_destroyed', { level: m.level }),
          read: false,
          created_at: nowISO,
        };
        gameState.addNotification(notif);
        supabase.from('notifications').insert(notif).then(() => {}).catch(() => {});
      } else if (burnedMs > 64800000 && burnedMs < 65400000) {
        const warnLang = gameState.getPlayerById(m.owner_id)?.language || 'en';
        const notif = {
          id: globalThis.crypto.randomUUID(),
          player_id: m.owner_id,
          type: 'mine_burning_warning',
          message: ts(warnLang, 'notif.mine_burn_warning', { level: m.level }),
          read: false,
          created_at: nowISO,
        };
        gameState.addNotification(notif);
        supabase.from('notifications').insert(notif).then(() => {}).catch(() => {});
      }
    }

    // Destroy burned collectors (>24h burning)
    for (const c of gameState.collectors.values()) {
      if (c.status !== 'burning' || !c.burning_started_at) continue;
      const burnedMs = nowMs - new Date(c.burning_started_at).getTime();
      if (burnedMs > 86400000) {
        gameState.collectors.delete(c.id);
        supabase.from('collectors').delete().eq('id', c.id).then(() => {}).catch(() => {});
        const owner = gameState.getPlayerById(c.owner_id);
        if (owner) {
          const cLang = owner.language || 'en';
          const notif = {
            id: globalThis.crypto.randomUUID(),
            player_id: owner.id, type: 'collector_destroyed',
            message: ts(cLang, 'notif.collector_burned'),
            read: false, created_at: nowISO,
          };
          gameState.addNotification(notif);
          supabase.from('notifications').insert(notif).then(() => {}).catch(() => {});
        }
      }
    }

    // Inactive clan leader auto-transfer (still reads from DB as clan data may not be in gameState)
    const { data: leaders } = await supabase.from('clan_members').select('clan_id,player_id,players(last_seen)')
      .eq('role', 'leader').is('left_at', null).limit(20);
    if (leaders?.length) {
      const sevenDaysAgo = new Date(nowMs - 7 * 24 * 60 * 60 * 1000);
      for (const lm of leaders) {
        const lastSeen = lm.players?.last_seen ? new Date(lm.players.last_seen) : null;
        if (!lastSeen || lastSeen >= sevenDaysAgo) continue;
        const { data: officers } = await supabase.from('clan_members')
          .select('player_id').eq('clan_id', lm.clan_id).eq('role', 'officer').is('left_at', null)
          .order('joined_at', { ascending: true }).limit(1);
        const newLeader = officers?.[0];
        if (!newLeader) continue;
        await Promise.all([
          supabase.from('clan_members').update({ role: 'member' }).eq('player_id', lm.player_id).eq('clan_id', lm.clan_id),
          supabase.from('players').update({ clan_role: 'member' }).eq('id', lm.player_id),
          supabase.from('clan_members').update({ role: 'leader' }).eq('player_id', newLeader.player_id).eq('clan_id', lm.clan_id),
          supabase.from('players').update({ clan_role: 'leader' }).eq('id', newLeader.player_id),
          supabase.from('clans').update({ leader_id: newLeader.player_id }).eq('id', lm.clan_id),
        ]);
      }
    }
    // Daily market check (once per 24h)
    const DAILY_MS = 24 * 60 * 60 * 1000;
    if (nowMs - _lastDailyMarketCheck > DAILY_MS) {
      _lastDailyMarketCheck = nowMs;
      dailyMarketCheck().catch(e => console.error('[gameLoop] daily market check error:', e.message));
    }

    // ── Ore node passive income + cleanup ──
    try {
      const oreNow = Date.now();
      for (const [id, ore] of gameState.oreNodes) {
        // Expire old ore nodes
        if (new Date(ore.expires_at).getTime() <= oreNow) {
          gameState.oreNodes.delete(id);
          supabase.from('ore_nodes').delete().eq('id', id).then(() => {}).catch(() => {});
          continue;
        }

        // HP regen (25%/hour = ~2.08% per 5 min)
        if (ore.hp < ore.max_hp) {
          const regen = Math.floor(ore.max_hp * 0.0208);
          ore.hp = Math.min(ore.max_hp, ore.hp + regen);
          gameState.markDirty('oreNodes', id);
        }

        // Passive income for owners (shards or ether based on currency)
        if (!ore.owner_id) continue;
        const hoursElapsed = (oreNow - new Date(ore.last_collected).getTime()) / 3600000;
        const resourceEarned = Math.floor(ore.level * hoursElapsed);
        if (resourceEarned > 0) {
          const player = gameState.getPlayerById(ore.owner_id);
          if (player) {
            if (ore.currency === 'ether') {
              player.ether = (player.ether || 0) + resourceEarned;
            } else {
              player.crystals = (player.crystals || 0) + resourceEarned;
            }
            gameState.markDirty('players', player.id);
          }
          ore.last_collected = new Date(oreNow).toISOString();
          gameState.markDirty('oreNodes', id);
        }
      }
    } catch (e) {
      console.error('[gameLoop] ore node error:', e.message);
    }
  } catch (e) {
    console.error('[gameLoop] cleanup error:', e.message);
  }
}

async function buildPlayerState(playerInfo, nowMs, nowISO) {
  if (!playerInfo.lat || !playerInfo.lng) return null;
  const PAD = 0.02;
  const n = playerInfo.lat + PAD, s = playerInfo.lat - PAD;
  const e = playerInfo.lng + PAD, w = playerInfo.lng - PAD;

  const snapshot = gameState.getMapSnapshot(n, s, e, w, null, nowMs);

  // Get unread notifications for this player
  let notifications = [];
  if (playerInfo.player_db_id) {
    notifications = gameState.getPlayerNotifications(playerInfo.player_db_id, 10);
  }

  return {
    bots: snapshot.bots,
    vases: snapshot.vases,
    couriers: snapshot.couriers,
    drops: snapshot.courier_drops,
    monuments: snapshot.monuments,
    monument_defenders: snapshot.monument_defenders,
    notifications,
  };
}
