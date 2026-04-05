import { supabase } from '../../lib/supabase.js';
import { gameState } from '../state/GameState.js';
import { log } from '../../lib/log.js';
import { BOT_TYPES, getRandomBotType } from '../mechanics/bots.js';
import { haversine } from '../../lib/haversine.js';
import { getMineIncome, getMineHp, getMineHpRegen, calcMineHpRegen, xpForLevel, SMALL_RADIUS, LARGE_RADIUS } from '../../config/formulas.js';
import { FIRETRUCK_LEVELS, FIRETRUCK_EXTINGUISH_DURATION, FIREFIGHTER_SPEED } from '../mechanics/fireTrucks.js';
import { COLLECTOR_LEVELS } from '../mechanics/collectors.js';
import { getCellsInRange } from '../../lib/grid.js';
import { dailyMarketCheck } from '../mechanics/market.js';
import {
  getShieldRegen, MONUMENT_SHIELD_DPS_THRESHOLD,
  TICK_INTERVAL, BOTS_PER_ZONE, BOT_TTL_MS, GLOBAL_BOT_CAP, BOT_SPEED_METERS, DRAIN_LIMITS,
  ZOMBIE_ATTACK_RANGE, ZOMBIE_NORMAL_DAMAGE,
  ORE_TYPES, VOLCANO_ERUPTION_MAX_CHANCE, VOLCANO_ERUPTION_RAMP_DAYS,
} from '../../config/constants.js';
import { getOreIncome, getEruptionTickChance } from '../mechanics/oreNodes.js';
import { ts } from '../../config/i18n.js';
import { getPlayerSkillEffects } from '../../config/skills.js';
import { calcRaidDps } from '../mechanics/monuments.js';
import { checkHordeTimeout } from '../mechanics/zombies.js';

const SPEED_METERS = BOT_SPEED_METERS;

let _tickCount = 0;
let _lastDailyMarketCheck = 0; // timestamp of last daily market check
let _io = null;
let _connectedPlayers = null;

export function startGameLoop(io, connectedPlayers) {
  _io = io;
  _connectedPlayers = connectedPlayers;
  log('[gameLoop] Starting game loop, interval:', TICK_INTERVAL, 'ms');

  // Smooth shield regen every 1s (separate from main 5s tick)
  setInterval(() => {
    processMonumentShieldRegen();
  }, 1000);

  setInterval(async () => {
    const nowMs = Date.now();
    const nowISO = new Date(nowMs).toISOString();
    _tickCount++;
    gameState._tickVersion++;

    try {
      // ── 1. Move bots globally ──────────────────────────────
      await moveBots(nowMs, nowISO);

      // ── 2. Monument shield regen — moved to separate 1s interval ──

      // ── 3. Move couriers ───────────────────────────────────
      await moveCouriers(nowMs, nowISO);

      // ── 3c. Move firefighters ────────────────────────────
      moveFirefighters(nowMs);

      // ── 3e. Move scouts + check training queue ────────────
      moveScouts(nowMs);

      // ── 3d. Move monument defenders toward aggroed players ─
      moveDefenders();

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
          const state = buildPlayerState(playerInfo, nowMs, nowISO);
          if (state) {
            io.to(socketId).emit('tick', state);
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

    const regenPerSec = getShieldRegen(monument.level);
    if (!regenPerSec) continue;

    const oldHp = monument.shield_hp;
    monument.shield_hp = Math.min(monument.max_shield_hp, monument.shield_hp + regenPerSec);

    if (monument.shield_hp !== oldHp) {
      gameState.markDirty('monuments', id);
      // Emit smooth update to nearby players (bbox check instead of haversine)
      if (_io && _connectedPlayers) {
        const PAD = 0.009; // ~1km
        const payload = {
          monument_id: monument.id,
          shield_hp: monument.shield_hp,
          max_shield_hp: monument.max_shield_hp,
        };
        for (const [sid, info] of _connectedPlayers) {
          if (!info.lat || !info.lng) continue;
          if (Math.abs(info.lat - monument.lat) <= PAD && Math.abs(info.lng - monument.lng) <= PAD) {
            _io.to(sid).emit('monument:shield_update', payload);
          }
        }
      }
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
          if (distM < 50) { // drain only within 50m
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
      const createdMs = c.created_at ? new Date(c.created_at).getTime() : 0;
      if (!createdMs || isNaN(createdMs)) { cArrived.push(c); continue; }
      const elapsedSec = (nowMs - createdMs) / 1000;
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
          supabase.from('market_listings').update({ status: 'active' }).eq('id', dc.listing_id).eq('status', 'pending').then(() => {}).catch(e => console.error('[loop] DB error:', e.message));
          if (dc.item_id) supabase.from('items').update({ held_by_courier: null, held_by_market: dc.to_market_id || null }).eq('id', dc.item_id).then(() => {}).catch(e => console.error('[loop] DB error:', e.message));
        } else if (dc.type === 'delivery' && (dc._coins > 0 || dc.coins > 0)) {
          // Collector coin delivery — create a coin drop on the ground
          const courierCoins = dc._coins || dc.coins || 0;
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
            _coins: courierCoins, // in-memory for fast pickup
            coins: courierCoins,  // persisted to DB
          };
          gameState.upsertDrop(drop);
          supabase.from('courier_drops').insert({
            id: drop.id, courier_id: dc.id, owner_id: dc.owner_id, lat: dropLat, lng: dropLng,
            drop_type: 'coin_delivery', picked_up: false,
            coins: courierCoins,
            expires_at: drop.expires_at, created_at: nowISO,
          }).then(() => {}).catch(e => console.error('[loop] courier_drops insert error:', e.message));
          const coinDelLang = gameState.getPlayerById(dc.owner_id)?.language || 'en';
          const notif = {
            id: globalThis.crypto.randomUUID(),
            player_id: dc.owner_id,
            type: 'collector_delivery',
            message: ts(coinDelLang, 'notif.coin_delivery', { coins: courierCoins }),
            read: false,
            created_at: nowISO,
          };
          gameState.addNotification(notif);
          supabase.from('notifications').insert(notif).then(() => {}).catch(e => console.error('[loop] DB error:', e.message));
        } else if (dc.type === 'delivery') {
          const buyer = gameState.getPlayerById(dc.owner_id);
          const dropLat = (buyer?.last_lat ?? dc.target_lat) + (Math.random() - 0.5) * 0.0004;
          const dropLng = (buyer?.last_lng ?? dc.target_lng) + (Math.random() - 0.5) * 0.0004;
          // Resolve core_id: runtime field → fallback to listing
          const _dcCoreId = dc._core_id || dc.core_id || gameState.getListingById(dc.listing_id)?.core_id || null;
          const drop = {
            id: globalThis.crypto.randomUUID(),
            courier_id: dc.id,
            owner_id: dc.owner_id,
            item_id: dc.item_id || null,
            core_id: _dcCoreId,
            listing_id: dc.listing_id,
            lat: dropLat,
            lng: dropLng,
            drop_type: 'delivery',
            picked_up: false,
            expires_at: new Date(nowMs + 30 * 24 * 60 * 60 * 1000).toISOString(),
            created_at: nowISO,
          };
          gameState.upsertDrop(drop);
          // Write to DB (fire-and-forget — gameState already updated)
          const cleanDrop = {};
          for (const k of Object.keys(drop)) { if (!k.startsWith('_')) cleanDrop[k] = drop[k]; }
          supabase.from('courier_drops').insert(cleanDrop).then(() => {}).catch(e => console.error('[loop] courier_drops insert error:', e.message));
          if (dc.item_id) {
            const item = gameState.getItemById(dc.item_id);
            if (item) { item.held_by_courier = null; item.held_by_market = null; gameState.markDirty('items', item.id); }
            supabase.from('items').update({ held_by_courier: null, held_by_market: null }).eq('id', dc.item_id).then(() => {}).catch(e => console.error('[loop] DB error:', e.message));
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
          supabase.from('notifications').insert(notif).then(() => {}).catch(e => console.error('[loop] DB error:', e.message));
        }
      } catch (e) { console.error('[gameLoop] courier delivery error:', e.message); }

      // Remove delivered courier from memory + DB (fire-and-forget)
      gameState.couriers.delete(dc.id);
      supabase.from('couriers').delete().eq('id', dc.id).then(() => {}).catch(e => console.error('[loop] courier delete error:', e.message));
      if (_io) _io.emit('courier:removed', { courier_id: dc.id });
    }
  } catch (e) {
    console.error('[gameLoop] courier move error:', e.message);
  }
}

// ── Move scouts (moving → capturing → captured) ──
function moveScouts(nowMs) {
  const TICK_S = 5; // 5 second tick
  for (const [id, scout] of gameState.activeScouts) {
    try {
      if (scout.status === 'moving') {
        // Move toward target
        const speedMs = (scout.speed * 1000) / 3600; // km/h → m/s
        const moveM = speedMs * TICK_S;
        const dist = haversine(scout.current_lat, scout.current_lng, scout.target_lat, scout.target_lng);

        if (dist <= moveM) {
          // Arrived — start capturing
          scout.current_lat = scout.target_lat;
          scout.current_lng = scout.target_lng;
          scout.status = 'capturing';
          scout.capture_started_at = new Date().toISOString();
          gameState.markDirty('activeScouts', id);
          if (_io) _io.emit('scout:capturing', { id, lat: scout.current_lat, lng: scout.current_lng, owner_id: scout.owner_id });
        } else {
          // Interpolate position
          const ratio = moveM / dist;
          const dLat = (scout.target_lat - scout.current_lat) * ratio;
          const dLng = (scout.target_lng - scout.current_lng) * ratio;
          scout.current_lat += dLat;
          scout.current_lng += dLng;
          gameState.markDirty('activeScouts', id);
        }
      } else if (scout.status === 'capturing') {
        // Check if capture is done
        const capStart = new Date(scout.capture_started_at).getTime();
        const capDuration = scout.capture_duration * 1000;
        if (nowMs >= capStart + capDuration) {
          // Capture complete — assign ore to player
          const ore = gameState.oreNodes.get(scout.target_ore_id);
          if (ore && !ore.owner_id) {
            // Lookup player by telegram_id to get proper player.id (UUID)
            const capturePlayer = gameState.getPlayerByTgId(Number(scout.owner_id));
            const playerId = capturePlayer ? capturePlayer.id : scout.owner_id;
            const nowISO = new Date().toISOString();
            const oreTypeCfg = ORE_TYPES[ore.ore_type] || ORE_TYPES.hill;
            const selectedCurrency = oreTypeCfg.dualCurrency ? 'both' : 'shards';

            ore.owner_id = playerId;
            ore.hp = ore.max_hp;
            ore.last_collected = nowISO;
            ore.currency = selectedCurrency;
            ore._claimed_at = nowISO;
            gameState.markDirty('oreNodes', ore.id);

            // Persist immediately (money operation)
            supabase.from('ore_nodes').update({
              owner_id: playerId, hp: ore.max_hp,
              last_collected: nowISO, currency: selectedCurrency,
            }).eq('id', ore.id).then(() => {}).catch(e => console.error('[SCOUTS] DB error:', e.message));

            if (_io) {
              _io.emit('scout:captured', {
                id, ore_id: ore.id, owner_id: scout.owner_id,
                ore_type: ore.ore_type, ore_level: ore.level,
              });
              // Emit ore:captured so frontend ore marker updates immediately
              if (_connectedPlayers) {
                for (const [sid, info] of _connectedPlayers) {
                  if (!info.lat || !info.lng) continue;
                  if (haversine(info.lat, info.lng, ore.lat, ore.lng) <= 1000) {
                    _io.to(sid).emit('ore:captured', {
                      ore_node_id: ore.id,
                      new_owner: playerId,
                      new_owner_name: capturePlayer?.game_username || capturePlayer?.username || null,
                    });
                  }
                }
              }
            }
            console.log(`[SCOUTS] Scout lv${scout.unit_level} captured ${ore.ore_type} for player ${scout.owner_id}`);
          }
          // Scout dies (consumable)
          gameState.activeScouts.delete(id);
          supabase.from('active_scouts').delete().eq('id', id).then(() => {}).catch(() => {});
        }
      }
    } catch (e) {
      console.error('[gameLoop] scout move error:', e.message);
    }
  }
}

// ── Move firefighters (going → extinguishing → returning) ──
function moveFirefighters(nowMs) {
  for (const [id, ff] of gameState.firefighters) {
    let targetLat, targetLng;

    if (ff.phase === 'going') {
      targetLat = ff.target_lat;
      targetLng = ff.target_lng;
    } else if (ff.phase === 'returning') {
      targetLat = ff.origin_lat;
      targetLng = ff.origin_lng;
    } else if (ff.phase === 'extinguishing') {
      if (nowMs - ff.extinguish_started_at >= FIRETRUCK_EXTINGUISH_DURATION) {
        // Extinguish the building
        extinguishBuilding(ff);
        ff.phase = 'returning';
        if (_io) _io.emit('firefighter:arrived', { id: ff.id, target_type: ff.target_type, target_id: ff.target_id });
      }
      continue;
    } else {
      continue;
    }

    const dist = haversine(ff.current_lat, ff.current_lng, targetLat, targetLng);
    if (dist < 10) {
      // Arrived
      if (ff.phase === 'going') {
        ff.phase = 'extinguishing';
        ff.extinguish_started_at = nowMs;
      } else if (ff.phase === 'returning') {
        gameState.firefighters.delete(id);
        if (_io) _io.emit('firefighter:removed', { id });
      }
      continue;
    }

    // Move toward target (degrees per tick, 5s interval)
    const dlat = targetLat - ff.current_lat;
    const dlng = targetLng - ff.current_lng;
    const degDist = Math.sqrt(dlat * dlat + dlng * dlng);
    const speedDeg = (ff.speed || FIREFIGHTER_SPEED) * 5 / 4; // speed is degrees per 4-second cycle
    const step = Math.min(degDist, speedDeg);
    ff.current_lat += (dlat / degDist) * step;
    ff.current_lng += (dlng / degDist) * step;
  }
}

function extinguishBuilding(ff) {
  const nowISO = new Date().toISOString();

  if (ff.target_type === 'mine') {
    const mine = gameState.mines.get(ff.target_id);
    if (mine && mine.status === 'burning') {
      const maxHp = getMineHp(mine.level);
      const restoredHp = Math.round(maxHp * 0.25);
      mine.status = 'normal';
      mine.burning_started_at = null;
      mine.hp = restoredHp;
      mine.last_hp_update = nowISO;
      gameState.markDirty('mines', mine.id);
      supabase.from('mines').update({ status: 'normal', burning_started_at: null, hp: restoredHp, last_hp_update: nowISO }).eq('id', mine.id).then(() => {}).catch(e => console.error('[loop] DB error:', e.message));
    }
  } else if (ff.target_type === 'collector') {
    const coll = gameState.collectors.get(ff.target_id);
    if (coll && coll.status === 'burning') {
      const cfg = COLLECTOR_LEVELS[coll.level] || COLLECTOR_LEVELS[1];
      const restoredHp = Math.round(cfg.hp * 0.25);
      coll.status = 'normal';
      coll.burning_started_at = null;
      coll.hp = restoredHp;
      gameState.markDirty('collectors', coll.id);
      supabase.from('collectors').update({ status: 'normal', burning_started_at: null, hp: restoredHp }).eq('id', coll.id).then(() => {}).catch(e => console.error('[loop] DB error:', e.message));
    }
  } else if (ff.target_type === 'fire_truck') {
    const truck = gameState.fireTrucks.get(ff.target_id);
    if (truck && truck.status === 'burning') {
      const cfg = FIRETRUCK_LEVELS[truck.level] || FIRETRUCK_LEVELS[1];
      const restoredHp = Math.round(cfg.hp * 0.25);
      truck.status = 'normal';
      truck.burning_started_at = null;
      truck.hp = restoredHp;
      gameState.markDirty('fireTrucks', truck.id);
      supabase.from('fire_trucks').update({ status: 'normal', burning_started_at: null, hp: restoredHp }).eq('id', truck.id).then(() => {}).catch(e => console.error('[loop] DB error:', e.message));
    }
  }
}

// ── Move monument defenders toward aggroed players ──
function moveDefenders() {
  for (const [id, d] of gameState.monumentDefenders) {
    if (!d.alive || d._target_lat == null || d._target_lng == null) continue;
    const dist = haversine(d.lat, d.lng, d._target_lat, d._target_lng);
    if (dist < 15) continue; // close enough, stop
    // Move ~30m per tick (5s), speed comparable to player walk
    const stepM = 30;
    const cosLat = Math.cos(d.lat * Math.PI / 180) || 0.001;
    const dLat = d._target_lat - d.lat;
    const dLng = d._target_lng - d.lng;
    const degDist = Math.sqrt(dLat * dLat + dLng * dLng);
    if (degDist < 0.0000001) continue;
    const stepDeg = stepM / 111320;
    const ratio = Math.min(1, stepDeg / degDist);
    d.lat += dLat * ratio;
    d.lng += dLng * ratio;
    gameState.markDirty('monumentDefenders', id);
  }
}

// ── Move zombies toward player, scouts wander ──
function moveZombies(nowMs, connectedPlayers) {
  if (gameState.zombieHordes.size === 0) return;

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

    // Keep horde alive while zombies are active
    horde.last_attack_at = new Date(nowMs).toISOString();

    // Each zombie attacks independently, 1 hit per tick
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

    // ── Walk distance daily/weekly reset (MSK midnight / Monday) ──
    {
      const mskNow = new Date(nowMs + 3 * 3600000);
      const mskDate = mskNow.toISOString().split('T')[0];
      for (const [id, p] of gameState.players) {
        if (p.walk_reset_date !== mskDate) {
          p.walk_daily_m = 0;
          p.walk_daily_claimed = 0;
          p.walk_reset_date = mskDate;
          if (mskNow.getUTCDay() === 1 && p.walk_week_reset !== mskDate) {
            p.walk_weekly_m = 0;
            p.walk_weekly_claimed = 0;
            p.walk_week_reset = mskDate;
          }
          gameState.markDirty('players', id);
        }
      }
    }

    // DB cleanup
    await Promise.all([
      supabase.from('bots').delete().lt('expires_at', nowISO),
      supabase.from('couriers').delete().in('status', ['delivered', 'killed', 'cancelled']).lt('created_at', new Date(nowMs - 3600000).toISOString()),
      supabase.from('courier_drops').delete().eq('picked_up', true).lt('created_at', new Date(nowMs - 3600000).toISOString()),
      supabase.from('notifications').delete().eq('read', true).lt('created_at', new Date(nowMs - 86400000).toISOString()),
    ]);

    // Expire old listings
    const { data: expired } = await supabase.from('market_listings').select('id,item_id,seller_id,item_type,core_id')
      .in('status', ['active', 'pending']).lt('expires_at', nowISO).limit(50);
    if (expired?.length) {
      for (const listing of expired) {
        await supabase.from('market_listings').update({ status: 'expired' }).eq('id', listing.id);
        if (listing.item_type === 'core' && listing.core_id) {
          await supabase.from('cores').update({ on_market: false }).eq('id', listing.core_id);
          if (gameState.loaded) {
            const core = gameState.cores.get(listing.core_id);
            if (core) { core.on_market = false; gameState.markDirty('cores', core.id); }
          }
        } else if (listing.item_id) {
          await supabase.from('items').update({ on_market: false, held_by_courier: null, held_by_market: null }).eq('id', listing.item_id);
        }
        supabase.from('couriers').update({ status: 'cancelled' }).eq('listing_id', listing.id).eq('status', 'moving').then(() => {}).catch(e => console.error('[loop] DB error:', e.message));
      }
    }

    // Expire loot drops
    const { data: expiredDrops } = await supabase.from('courier_drops').select('id,item_id,core_id')
      .eq('picked_up', false).not('expires_at', 'is', null).lt('expires_at', nowISO).limit(50);
    if (expiredDrops?.length) {
      for (const drop of expiredDrops) {
        const ops = [supabase.from('courier_drops').update({ picked_up: true }).eq('id', drop.id)];
        if (drop.item_id) ops.push(supabase.from('items').update({ on_market: false, held_by_courier: null, held_by_market: null }).eq('id', drop.item_id));
        if (drop.core_id) {
          ops.push(supabase.from('cores').update({ on_market: false }).eq('id', drop.core_id));
          if (gameState.loaded) {
            const core = gameState.cores.get(drop.core_id);
            if (core) { core.on_market = false; gameState.markDirty('cores', core.id); }
          }
        }
        await Promise.all(ops);
      }
    }

    // Reset stale under_attack mines back to normal
    for (const m of gameState.mines.values()) {
      if (m.status !== 'under_attack') continue;
      // If attack_ends_at is set and expired — reset
      if (m.attack_ends_at && new Date(m.attack_ends_at).getTime() < nowMs) {
        m.status = 'normal';
        m.attacker_id = null;
        m.attack_started_at = null;
        m.attack_ends_at = null;
        gameState.markDirty('mines', m.id);
      }
      // If no attack_ends_at and no HP update for 5 min — reset (stale hit)
      else if (!m.attack_ends_at && m.last_hp_update) {
        const staleSince = nowMs - new Date(m.last_hp_update).getTime();
        if (staleSince > 5 * 60 * 1000) {
          m.status = 'normal';
          m.attacker_id = null;
          m.attack_started_at = null;
          gameState.markDirty('mines', m.id);
        }
      }
    }

    // Destroy burned mines from gameState (>24h burning)
    for (const m of gameState.mines.values()) {
      if (m.status !== 'burning' || !m.burning_started_at) continue;
      const burnedMs = nowMs - new Date(m.burning_started_at).getTime();
      if (burnedMs > 86400000) {
        m.status = 'destroyed';
        gameState.markDirty('mines', m.id);
        supabase.from('mines').update({ status: 'destroyed' }).eq('id', m.id).then(() => {}).catch(e => console.error('[loop] DB error:', e.message));
        // Destroy installed cores
        if (m.cell_id) {
          const cores = gameState.getCoresForMine(m.cell_id);
          for (const c of cores) {
            gameState.cores.delete(c.id);
          }
          if (cores.length > 0) {
            supabase.from('cores').delete().eq('mine_cell_id', m.cell_id).then(() => {}).catch(e => console.error('[loop] DB error:', e.message));
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
        supabase.from('notifications').insert(notif).then(() => {}).catch(e => console.error('[loop] DB error:', e.message));
      }
    }

    // Destroy burned collectors (>24h burning)
    for (const c of gameState.collectors.values()) {
      if (c.status !== 'burning' || !c.burning_started_at) continue;
      const burnedMs = nowMs - new Date(c.burning_started_at).getTime();
      if (burnedMs > 86400000) {
        gameState.collectors.delete(c.id);
        supabase.from('collectors').delete().eq('id', c.id).then(() => {}).catch(e => console.error('[loop] DB error:', e.message));
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
          supabase.from('notifications').insert(notif).then(() => {}).catch(e => console.error('[loop] DB error:', e.message));
        }
      }
    }

    // Destroy burned fire trucks (>24h burning)
    for (const ft of gameState.fireTrucks.values()) {
      if (ft.status !== 'burning' || !ft.burning_started_at) continue;
      const burnedMs = nowMs - new Date(ft.burning_started_at).getTime();
      if (burnedMs > 86400000) {
        // Kill active firefighters from this truck
        for (const [ffId, ff] of gameState.firefighters) {
          if (ff.truck_id === ft.id) gameState.firefighters.delete(ffId);
        }
        gameState.fireTrucks.delete(ft.id);
        supabase.from('fire_trucks').delete().eq('id', ft.id).then(() => {}).catch(e => console.error('[loop] DB error:', e.message));
        const owner = gameState.getPlayerById(ft.owner_id);
        if (owner) {
          const ftLang = owner.language || 'en';
          const notif = {
            id: globalThis.crypto.randomUUID(),
            player_id: owner.id, type: 'firetruck_destroyed',
            message: ts(ftLang, 'notif.firetruck_burned'),
            read: false, created_at: nowISO,
          };
          gameState.addNotification(notif);
          supabase.from('notifications').insert(notif).then(() => {}).catch(e => console.error('[loop] DB error:', e.message));
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

    // ── Ore node passive income + cleanup + eruptions ──
    try {
      const oreNow = Date.now();
      for (const [id, ore] of gameState.oreNodes) {
        // One-time cleanup: remove non-DB field that breaks persist
        if (ore.captured_at) { delete ore.captured_at; gameState.markDirty('oreNodes', id); }

        // Expire old ore nodes
        if (new Date(ore.expires_at).getTime() <= oreNow) {
          gameState.oreNodes.delete(id);
          supabase.from('ore_nodes').delete().eq('id', id).then(() => {}).catch(e => console.error('[loop] DB error:', e.message));
          continue;
        }

        // HP regen (25%/hour = ~2.08% per 5 min)
        if (ore.hp < ore.max_hp) {
          const regen = Math.floor(ore.max_hp * 0.0208);
          ore.hp = Math.min(ore.max_hp, ore.hp + regen);
          gameState.markDirty('oreNodes', id);
        }

        if (!ore.owner_id) continue;

        const oreTypeCfg = ORE_TYPES[ore.ore_type] || ORE_TYPES.hill;

        // ── Volcano eruption check ──
        if (oreTypeCfg.canErupt && ore._claimed_at) {
          const daysOwned = (oreNow - new Date(ore._claimed_at).getTime()) / 86400000;
          const tickChance = getEruptionTickChance(daysOwned);
          if (tickChance > 0 && Math.random() < tickChance) {
            // Eruption! Reset owner
            const eruptedOwnerId = ore.owner_id;
            const eruptedOwner = gameState.getPlayerById(eruptedOwnerId);
            ore.owner_id = null;
            ore.hp = ore.max_hp;
            delete ore._claimed_at;
            gameState.markDirty('oreNodes', id);
            supabase.from('ore_nodes').update({ owner_id: null, hp: ore.max_hp }).eq('id', id).then(() => {}).catch(e => console.error('[loop] DB error:', e.message));

            // Notify owner
            if (eruptedOwner) {
              const eLang = eruptedOwner.language || 'en';
              const notif = {
                id: globalThis.crypto.randomUUID(),
                player_id: eruptedOwnerId,
                type: 'ore_eruption',
                message: ts(eLang, 'notif.ore_eruption', { level: ore.level }),
                read: false, created_at: new Date().toISOString(),
              };
              gameState.addNotification(notif);
              supabase.from('notifications').insert(notif).then(() => {}).catch(e => console.error('[loop] DB error:', e.message));
            }

            // Emit eruption event for animation
            for (const [sid, info] of connectedPlayers) {
              if (info.lat && info.lng && haversine(ore.lat, ore.lng, info.lat, info.lng) <= 2000) {
                io.to(sid).emit('ore:eruption', { ore_node_id: id, lat: ore.lat, lng: ore.lng, level: ore.level });
              }
            }
            console.log(`[ORE] 🌋 Eruption! Lv.${ore.level} volcano at ${ore.lat.toFixed(4)},${ore.lng.toFixed(4)} — owner ${eruptedOwner?.game_username || eruptedOwnerId} lost`);
            continue; // Skip income for this tick
          }
        }

        // ── Passive income ──
        const hoursElapsed = (oreNow - new Date(ore.last_collected).getTime()) / 3600000;
        let resourceEarned = Math.floor(getOreIncome(ore.level, ore.ore_type) * hoursElapsed);
        if (resourceEarned > 0) {
          const player = gameState.getPlayerById(ore.owner_id);
          if (player) {
            const sFx = getPlayerSkillEffects(gameState.getPlayerSkills(Number(player.telegram_id)));
            if (sFx.ore_bonus) resourceEarned = Math.floor(resourceEarned * (1 + sFx.ore_bonus));

            if (oreTypeCfg.dualCurrency) {
              // Dual currency: both shards and ether
              player.crystals = (player.crystals || 0) + resourceEarned;
              player.ether = (player.ether || 0) + resourceEarned;
            } else if (ore.currency === 'ether') {
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

function buildPlayerState(playerInfo, nowMs, nowISO) {
  if (!playerInfo.lat || !playerInfo.lng) return null;
  const PAD = 0.02;
  const n = playerInfo.lat + PAD, s = playerInfo.lat - PAD;
  const e = playerInfo.lng + PAD, w = playerInfo.lng - PAD;

  // Use lightweight tick snapshot (only 7 collections instead of 17)
  const snapshot = gameState.getTickSnapshot(n, s, e, w, nowMs);

  // Get unread notifications for this player
  let notifications = [];
  if (playerInfo.player_db_id) {
    notifications = gameState.getPlayerNotifications(playerInfo.player_db_id, 10);
  }

  // Include own active scouts (regardless of viewport)
  const ownScouts = [];
  const tgId = playerInfo.telegram_id ? Number(playerInfo.telegram_id) : null;
  if (tgId) {
    for (const sc of gameState.activeScouts.values()) {
      if (Number(sc.owner_id) === tgId) {
        ownScouts.push({
          id: sc.id, owner_id: sc.owner_id,
          lat: sc.current_lat, lng: sc.current_lng,
          target_lat: sc.target_lat, target_lng: sc.target_lng,
          speed: sc.speed, hp: sc.hp, max_hp: sc.max_hp,
          level: sc.unit_level, status: sc.status,
          target_ore_id: sc.target_ore_id,
        });
      }
    }
  }
  // Also include nearby enemy scouts from snapshot
  for (const sc of (snapshot.active_scouts || [])) {
    if (!ownScouts.some(o => o.id === sc.id)) ownScouts.push(sc);
  }

  return {
    bots: snapshot.bots,
    vases: snapshot.vases,
    couriers: snapshot.couriers,
    drops: snapshot.courier_drops,
    monuments: snapshot.monuments,
    monument_defenders: snapshot.monument_defenders,
    active_scouts: ownScouts,
    notifications,
  };
}
