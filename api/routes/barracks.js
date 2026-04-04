import { Router } from 'express';
import { supabase } from '../../lib/supabase.js';
import { haversine } from '../../lib/haversine.js';
import { getCellId } from '../../lib/grid.js';
import { gameState } from '../../lib/gameState.js';
import { io, connectedPlayers, lastAttackTime, logActivity } from '../../server.js';
import { addXp } from '../../lib/xp.js';
import { ts, getLang } from '../../config/i18n.js';
import {
  SMALL_RADIUS, LARGE_RADIUS, WEAPON_COOLDOWNS,
  BARRACKS_BUILD_COST, BARRACKS_MIN_HQ_LEVEL, BARRACKS_BASE_TRAIN_TIME_MS,
  BARRACKS_LEVELS,
  SCOUT_TRAIN_COST, SCOUT_UPGRADE_COST, SCOUT_SPEED_KMH,
  SCOUT_CAPTURE_MIN, SCOUT_HP, SCOUT_MAX_RANGE_KM, SCOUT_ORE_ACCESS,
  SCOUT_KILL_REWARD_CRYSTALS,
} from '../../config/constants.js';
import {
  getPlayerBarracks, getBarracksLevel, getTrainTimeMs, getQueueSlots,
  getScoutTrainCost, getScoutUpgradeCost, getScoutSpeedKmh,
  getScoutCaptureMs, getScoutHp, canScoutCaptureOre, getPlayerScoutLevel,
  getPlayerScoutCount, getTrainingQueue, getActiveQueueCount,
  getPlayerBag, getPlayerActiveScouts, getBarracksSellRefund,
} from '../../game/mechanics/barracks.js';
import { persistNow } from '../../game/state/persist.js';

export const barracksRouter = Router();

function emitToNearby(lat, lng, radiusM, event, data) {
  for (const [sid, info] of connectedPlayers) {
    if (!info.lat || !info.lng) continue;
    if (haversine(lat, lng, info.lat, info.lng) <= radiusM) io.to(sid).emit(event, data);
  }
}

barracksRouter.post('/', async (req, res) => {
  const { action } = req.body || {};
  if (action === 'build') return handleBuild(req, res);
  if (action === 'upgrade') return handleUpgrade(req, res);
  if (action === 'sell') return handleSell(req, res);
  if (action === 'train') return handleTrain(req, res);
  if (action === 'collect') return handleCollect(req, res);
  if (action === 'upgrade-unit') return handleUpgradeUnit(req, res);
  if (action === 'send-scout') return handleSendScout(req, res);
  if (action === 'attack-scout') return handleAttackScout(req, res);
  if (action === 'boost') return handleBoost(req, res);
  if (action === 'sell-scout') return handleSellScout(req, res);
  if (action === 'mass-sell-scouts') return handleMassSellScouts(req, res);
  if (action === 'status') return handleStatus(req, res);
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

  // Check HQ level
  const hq = gameState.getHqByPlayerId(player.id);
  const hqLevel = hq?.level || 1;
  if (hqLevel < BARRACKS_MIN_HQ_LEVEL) return res.status(400).json({ error: `Требуется HQ уровень ${BARRACKS_MIN_HQ_LEVEL}` });

  // One barracks per player
  const existing = getPlayerBarracks(telegram_id);
  if (existing) return res.status(400).json({ error: 'У вас уже есть казарма' });

  // Check diamonds
  if ((player.diamonds || 0) < BARRACKS_BUILD_COST) return res.status(400).json({ error: `Нужно ${BARRACKS_BUILD_COST} 💎` });

  // Cell occupation check
  const cellId = getCellId(tapLat, tapLng);
  const cellOccupied =
    [...gameState.mines.values()].some(m => m.cell_id === cellId && m.status !== 'destroyed') ||
    [...gameState.headquarters.values()].some(h => h.cell_id === cellId) ||
    [...gameState.collectors.values()].some(c => c.cell_id === cellId) ||
    [...gameState.clanHqs.values()].some(c => c.cell_id === cellId) ||
    [...gameState.monuments.values()].some(m => m.cell_id === cellId) ||
    [...gameState.fireTrucks.values()].some(ft => ft.cell_id === cellId && ft.status !== 'destroyed') ||
    [...gameState.barracks.values()].some(b => b.cell_id === cellId);
  if (cellOccupied) return res.status(400).json({ error: ts(lang, 'err.cell_occupied') });

  // Deduct diamonds
  player.diamonds = (player.diamonds || 0) - BARRACKS_BUILD_COST;
  await persistNow('players', { id: player.id, diamonds: player.diamonds });

  const lvl = BARRACKS_LEVELS[1];
  const barracks = {
    id: globalThis.crypto.randomUUID(),
    owner_id: player.id,
    lat: tapLat,
    lng: tapLng,
    cell_id: cellId,
    level: 1,
    hp: lvl.hp,
    max_hp: lvl.hp,
    status: 'active',
    created_at: new Date().toISOString(),
  };

  gameState.barracks.set(barracks.id, barracks);
  gameState.markDirty('barracks', barracks.id);

  // Also create default unit_upgrade row for scout
  const upgradeKey = `${Number(telegram_id)}_scout`;
  if (!gameState.unitUpgrades.has(upgradeKey)) {
    const upgrade = {
      id: globalThis.crypto.randomUUID(),
      owner_id: Number(telegram_id),
      unit_type: 'scout',
      level: 1,
    };
    gameState.unitUpgrades.set(upgradeKey, upgrade);
    gameState.markDirty('unitUpgrades', upgradeKey);
  }

  logActivity(telegram_id, 'barracks_build', { level: 1, lat: tapLat, lng: tapLng });
  res.json({ ok: true, barracks });
}

// ── UPGRADE ──
async function handleUpgrade(req, res) {
  const { telegram_id } = req.body || {};
  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const barracks = getPlayerBarracks(telegram_id);
  if (!barracks) return res.status(404).json({ error: 'Казарма не найдена' });

  const nextLevel = barracks.level + 1;
  if (nextLevel > 10) return res.status(400).json({ error: 'Максимальный уровень' });

  const cost = BARRACKS_LEVELS[nextLevel]?.upgradeCost || 0;
  if ((player.diamonds || 0) < cost) return res.status(400).json({ error: `Нужно ${cost} 💎` });

  player.diamonds = (player.diamonds || 0) - cost;
  await persistNow('players', { id: player.id, diamonds: player.diamonds });

  const lvl = BARRACKS_LEVELS[nextLevel];
  barracks.level = nextLevel;
  barracks.max_hp = lvl.hp;
  barracks.hp = lvl.hp;
  gameState.markDirty('barracks', barracks.id);

  logActivity(telegram_id, 'barracks_upgrade', { level: nextLevel });
  res.json({ ok: true, level: nextLevel, barracks });
}

// ── SELL ──
async function handleSell(req, res) {
  const { telegram_id } = req.body || {};
  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const barracks = getPlayerBarracks(telegram_id);
  if (!barracks) return res.status(404).json({ error: 'Казарма не найдена' });

  const refund = getBarracksSellRefund(barracks.level);
  player.diamonds = (player.diamonds || 0) + refund;
  await persistNow('players', { id: player.id, diamonds: player.diamonds });

  gameState.barracks.delete(barracks.id);
  supabase.from('barracks').delete().eq('id', barracks.id).then(() => {}).catch(() => {});

  // Clear training queue
  for (const [id, t] of gameState.trainingQueue) {
    if (t.barracks_id === barracks.id) {
      gameState.trainingQueue.delete(id);
      supabase.from('training_queue').delete().eq('id', id).then(() => {}).catch(() => {});
    }
  }

  logActivity(telegram_id, 'barracks_sell', { refund });
  res.json({ ok: true, refund });
}

// ── TRAIN ──
async function handleTrain(req, res) {
  const { telegram_id, unit_type = 'scout' } = req.body || {};
  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const barracks = getPlayerBarracks(telegram_id);
  if (!barracks) return res.status(404).json({ error: 'Казарма не найдена' });

  // Check queue slots
  const queueCount = getActiveQueueCount(barracks.id);
  const maxSlots = getQueueSlots(barracks.level);
  if (queueCount >= maxSlots) return res.status(400).json({ error: `Очередь заполнена (${maxSlots} слотов)` });

  // Get unit level
  const scoutLevel = getPlayerScoutLevel(telegram_id);
  const trainCost = getScoutTrainCost(scoutLevel);

  // Check crystals
  if ((player.crystals || 0) < trainCost) return res.status(400).json({ error: `Нужно ${trainCost} осколков` });

  // Deduct crystals
  player.crystals = (player.crystals || 0) - trainCost;
  await persistNow('players', { id: player.id, crystals: player.crystals });

  // Calculate finish time — queue items finish sequentially
  const queue = getTrainingQueue(barracks.id);
  const trainTimeMs = getTrainTimeMs(scoutLevel);
  const lastFinish = queue.length > 0 ? new Date(queue[queue.length - 1].finish_at).getTime() : Date.now();
  const startAt = Math.max(Date.now(), lastFinish);
  const finishAt = startAt + trainTimeMs;

  const entry = {
    id: globalThis.crypto.randomUUID(),
    barracks_id: barracks.id,
    owner_id: Number(telegram_id),
    unit_type: 'scout',
    unit_level: scoutLevel,
    started_at: new Date(startAt).toISOString(),
    finish_at: new Date(finishAt).toISOString(),
    collected: false,
  };

  gameState.trainingQueue.set(entry.id, entry);
  gameState.markDirty('trainingQueue', entry.id);

  logActivity(telegram_id, 'scout_train', { level: scoutLevel, cost: trainCost });
  res.json({ ok: true, entry, queue_size: queueCount + 1, max_slots: maxSlots });
}

// ── COLLECT — pick up finished units from barracks ──
async function handleCollect(req, res) {
  const { telegram_id } = req.body || {};
  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const barracks = getPlayerBarracks(telegram_id);
  if (!barracks) return res.status(404).json({ error: 'Казарма не найдена' });

  const now = Date.now();
  const queue = getTrainingQueue(barracks.id);
  let collected = 0;

  for (const entry of queue) {
    if (new Date(entry.finish_at).getTime() <= now && !entry.collected) {
      // Move to bag
      const unit = {
        id: globalThis.crypto.randomUUID(),
        owner_id: Number(telegram_id),
        unit_type: entry.unit_type,
        unit_level: entry.unit_level,
        created_at: new Date().toISOString(),
      };
      gameState.unitBag.set(unit.id, unit);
      gameState.markDirty('unitBag', unit.id);

      // Mark as collected
      entry.collected = true;
      gameState.markDirty('trainingQueue', entry.id);
      collected++;
    }
  }

  if (collected === 0) return res.status(400).json({ error: 'Нет готовых юнитов' });

  const totalInBag = getPlayerScoutCount(telegram_id);
  res.json({ ok: true, collected, total_in_bag: totalInBag });
}

// ── BOOST — instant finish for diamonds (1💎 per minute remaining) ──
async function handleBoost(req, res) {
  const { telegram_id, entry_id } = req.body || {};
  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const barracks = getPlayerBarracks(telegram_id);
  if (!barracks) return res.status(404).json({ error: 'Казарма не найдена' });

  // If entry_id specified, boost single entry; otherwise boost all
  const queue = getTrainingQueue(barracks.id);
  const toBoost = entry_id
    ? queue.filter(q => q.id === entry_id && !q.ready)
    : queue.filter(q => !q.ready);

  if (toBoost.length === 0) return res.status(400).json({ error: 'Нечего ускорять' });

  // Calculate total cost: 1 diamond per minute of own training time remaining
  const now = Date.now();
  let totalCost = 0;
  for (const entry of toBoost) {
    const startedAt = new Date(entry.started_at).getTime();
    const finishAt = new Date(entry.finish_at).getTime();
    const ownTrainMs = finishAt - startedAt; // own training duration only
    const notStarted = now < startedAt;
    // If not started yet, cost = full training time; otherwise = remaining time
    const msLeft = notStarted ? ownTrainMs : Math.max(0, finishAt - now);
    totalCost += Math.max(1, Math.ceil(msLeft / 60000));
  }

  if ((player.diamonds || 0) < totalCost) return res.status(400).json({ error: `Нужно ${totalCost} 💎` });

  // Deduct diamonds
  player.diamonds = (player.diamonds || 0) - totalCost;
  await persistNow('players', { id: player.id, diamonds: player.diamonds });

  // Set finish_at to now for all boosted entries, adjust subsequent queue times
  for (const entry of toBoost) {
    const oldFinish = new Date(entry.finish_at).getTime();
    const ownDuration = oldFinish - new Date(entry.started_at).getTime();
    entry.started_at = new Date(now - ownDuration).toISOString(); // pretend it started earlier
    entry.finish_at = new Date(now).toISOString();
    gameState.markDirty('trainingQueue', entry.id);
  }

  logActivity(telegram_id, 'barracks_boost', { count: toBoost.length, cost: totalCost });
  res.json({ ok: true, boosted: toBoost.length, cost: totalCost, diamonds: player.diamonds });
}

// ── UPGRADE UNIT TYPE ──
async function handleUpgradeUnit(req, res) {
  const { telegram_id, unit_type = 'scout' } = req.body || {};
  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const barracks = getPlayerBarracks(telegram_id);
  if (!barracks) return res.status(404).json({ error: 'Казарма не найдена' });

  const upgradeKey = `${Number(telegram_id)}_scout`;
  let upgrade = gameState.unitUpgrades.get(upgradeKey);
  if (!upgrade) {
    upgrade = { id: globalThis.crypto.randomUUID(), owner_id: Number(telegram_id), unit_type: 'scout', level: 1 };
    gameState.unitUpgrades.set(upgradeKey, upgrade);
  }

  const nextLevel = upgrade.level + 1;
  if (nextLevel > 10) return res.status(400).json({ error: 'Максимальный уровень скаута' });

  const cost = getScoutUpgradeCost(nextLevel);
  if ((player.ether || 0) < cost) return res.status(400).json({ error: `Нужно ${cost} эфира` });

  // Deduct ether
  player.ether = (player.ether || 0) - cost;
  await persistNow('players', { id: player.id, ether: player.ether });

  upgrade.level = nextLevel;
  gameState.markDirty('unitUpgrades', upgradeKey);

  logActivity(telegram_id, 'scout_upgrade', { level: nextLevel, cost });
  res.json({ ok: true, level: nextLevel, cost });
}

// ── SEND SCOUT ──
async function handleSendScout(req, res) {
  const { telegram_id, ore_id } = req.body || {};
  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.last_lat) return res.status(400).json({ error: 'GPS не определён' });

  // Find ore node
  const ore = gameState.oreNodes.get(ore_id);
  if (!ore) return res.status(404).json({ error: 'Рудник не найден' });
  if (ore.owner_id) return res.status(400).json({ error: 'Рудник уже занят' });

  // Find the best matching scout in bag (lowest level that can capture this ore type)
  const bag = getPlayerBag(telegram_id).filter(u => u.unit_type === 'scout');
  if (bag.length === 0) return res.status(400).json({ error: 'Нет скаутов в сумке' });

  const eligible = bag.filter(u => canScoutCaptureOre(u.unit_level, ore.ore_type, ore.level));
  if (eligible.length === 0) {
    return res.status(400).json({ error: `Скаут уровня ${ore.level}+ нужен для Ур.${ore.level} ${ore.ore_type}` });
  }
  // Pick lowest level that qualifies (preserve higher-level scouts)
  eligible.sort((a, b) => a.unit_level - b.unit_level);
  const scout = eligible[0];

  // Check range (20km from player)
  const dist = haversine(player.last_lat, player.last_lng, ore.lat, ore.lng);
  if (dist > SCOUT_MAX_RANGE_KM * 1000) return res.status(400).json({ error: `Слишком далеко (макс ${SCOUT_MAX_RANGE_KM} км)` });

  // Remove from bag
  gameState.unitBag.delete(scout.id);
  supabase.from('unit_bag').delete().eq('id', scout.id).then(() => {}).catch(() => {});

  // Create active scout on map
  const hp = getScoutHp(scout.unit_level);
  const speedKmh = getScoutSpeedKmh(scout.unit_level);
  const captureMs = getScoutCaptureMs(scout.unit_level);

  const activeScout = {
    id: globalThis.crypto.randomUUID(),
    owner_id: Number(telegram_id),
    unit_level: scout.unit_level,
    status: 'moving',
    hp,
    max_hp: hp,
    start_lat: player.last_lat,
    start_lng: player.last_lng,
    current_lat: player.last_lat,
    current_lng: player.last_lng,
    target_lat: ore.lat,
    target_lng: ore.lng,
    target_ore_id: ore.id,
    speed: speedKmh,
    capture_duration: Math.round(captureMs / 1000),
    capture_started_at: null,
    created_at: new Date().toISOString(),
  };

  gameState.activeScouts.set(activeScout.id, activeScout);
  gameState.markDirty('activeScouts', activeScout.id);

  // Emit to nearby
  emitToNearby(player.last_lat, player.last_lng, 5000, 'scout:spawned', {
    id: activeScout.id, owner_id: activeScout.owner_id,
    lat: activeScout.current_lat, lng: activeScout.current_lng,
    hp, max_hp: hp, level: scout.unit_level,
    target_lat: ore.lat, target_lng: ore.lng,
  });

  logActivity(telegram_id, 'scout_send', { ore_id, level: scout.unit_level, distance: Math.round(dist) });
  res.json({ ok: true, scout: activeScout, remaining_scouts: bag.length - 1 });
}

// ── ATTACK SCOUT ──
async function handleAttackScout(req, res) {
  const { telegram_id, scout_id, lat, lng } = req.body || {};
  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const scout = gameState.activeScouts.get(scout_id);
  if (!scout) return res.status(404).json({ error: 'Скаут не найден' });
  if (Number(scout.owner_id) === Number(telegram_id)) return res.status(400).json({ error: 'Нельзя атаковать своего скаута' });

  // Range check
  const dist = haversine(player.last_lat, player.last_lng, scout.current_lat, scout.current_lng);
  if (dist > LARGE_RADIUS) return res.status(400).json({ error: 'Слишком далеко' });

  // Weapon cooldown
  const now = Date.now();
  const equipped = [...gameState.items.values()].find(i =>
    i.owner_id === player.id && i.equipped && (i.type === 'sword' || i.type === 'axe'));
  const weaponType = equipped?.type || 'none';
  const cd = WEAPON_COOLDOWNS[weaponType] || 200;
  const lastAtk = lastAttackTime.get(Number(telegram_id)) || 0;
  if (now - lastAtk < cd) return res.status(429).json({ error: 'Кулдаун' });
  lastAttackTime.set(Number(telegram_id), now);

  // Calculate damage
  const baseAtk = 10 + (equipped?.attack || 0);
  const dmgMul = 0.8 + Math.random() * 0.4;
  const damage = Math.round(baseAtk * dmgMul);

  scout.hp -= damage;
  const killed = scout.hp <= 0;

  if (killed) {
    // Scout dies
    gameState.activeScouts.delete(scout.id);
    supabase.from('active_scouts').delete().eq('id', scout.id).then(() => {}).catch(() => {});

    // Reward attacker
    player.crystals = (player.crystals || 0) + SCOUT_KILL_REWARD_CRYSTALS;
    gameState.markDirty('players', player.id);
    addXp(player, 50);

    emitToNearby(scout.current_lat, scout.current_lng, 5000, 'scout:killed', {
      id: scout.id, killer_id: Number(telegram_id),
    });

    logActivity(telegram_id, 'scout_kill', { scout_id, reward: SCOUT_KILL_REWARD_CRYSTALS });
  } else {
    gameState.markDirty('activeScouts', scout.id);
    emitToNearby(scout.current_lat, scout.current_lng, 5000, 'scout:hp_update', {
      id: scout.id, hp: scout.hp, max_hp: scout.max_hp,
    });
  }

  res.json({ ok: true, damage, killed, scout_hp: Math.max(0, scout.hp), reward: killed ? SCOUT_KILL_REWARD_CRYSTALS : 0 });
}

// ── STATUS — barracks info + queue + bag ──
async function handleStatus(req, res) {
  const { telegram_id } = req.body || {};
  const barracks = getPlayerBarracks(telegram_id);
  if (!barracks) return res.json({ ok: true, barracks: null });

  const queue = getTrainingQueue(barracks.id);
  const bag = getPlayerBag(telegram_id);
  const scoutLevel = getPlayerScoutLevel(telegram_id);
  const activeScouts = getPlayerActiveScouts(telegram_id);
  const cfg = BARRACKS_LEVELS[barracks.level];
  const nextCost = barracks.level < 10 ? BARRACKS_LEVELS[barracks.level + 1]?.upgradeCost : null;

  res.json({
    ok: true,
    barracks: {
      id: barracks.id,
      level: barracks.level,
      hp: barracks.hp,
      max_hp: barracks.max_hp,
      lat: barracks.lat,
      lng: barracks.lng,
      slots: cfg.slots,
      train_time_ms: getTrainTimeMs(scoutLevel),
      upgrade_cost: nextCost,
    },
    scout_level: scoutLevel,
    scout_upgrade_cost: scoutLevel < 10 ? getScoutUpgradeCost(scoutLevel + 1) : null,
    scout_train_cost: getScoutTrainCost(scoutLevel),
    queue: queue.map(q => ({
      id: q.id,
      unit_type: q.unit_type,
      unit_level: q.unit_level,
      started_at: q.started_at,
      finish_at: q.finish_at,
      ready: new Date(q.finish_at).getTime() <= Date.now(),
    })),
    bag: bag.map(u => ({ id: u.id, unit_type: u.unit_type, unit_level: u.unit_level })),
    active_scouts: activeScouts.map(s => ({
      id: s.id, status: s.status, hp: s.hp, max_hp: s.max_hp,
      level: s.unit_level, target_ore_id: s.target_ore_id,
    })),
  });
}

// ── SELL SCOUT ──
async function handleSellScout(req, res) {
  const { telegram_id, scout_id } = req.body || {};
  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const unit = gameState.unitBag.get(scout_id);
  if (!unit || Number(unit.owner_id) !== Number(telegram_id)) return res.status(404).json({ error: 'Скаут не найден' });

  const trainCost = getScoutTrainCost(unit.unit_level);
  const sellPrice = Math.floor(trainCost * 0.1);

  player.crystals = (player.crystals || 0) + sellPrice;
  gameState.markDirty('players', player.id);

  gameState.unitBag.delete(scout_id);
  supabase.from('unit_bag').delete().eq('id', scout_id).then(() => {}).catch(() => {});

  res.json({ ok: true, crystals: sellPrice, total_crystals: player.crystals });
}

// ── MASS SELL SCOUTS ──
async function handleMassSellScouts(req, res) {
  const { telegram_id, scout_ids } = req.body || {};
  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!scout_ids || !Array.isArray(scout_ids) || scout_ids.length === 0) return res.status(400).json({ error: 'Нет скаутов для продажи' });

  let totalCrystals = 0;
  let soldCount = 0;
  for (const sid of scout_ids) {
    const unit = gameState.unitBag.get(sid);
    if (!unit || Number(unit.owner_id) !== Number(telegram_id)) continue;
    const trainCost = getScoutTrainCost(unit.unit_level);
    totalCrystals += Math.floor(trainCost * 0.1);
    gameState.unitBag.delete(sid);
    supabase.from('unit_bag').delete().eq('id', sid).then(() => {}).catch(() => {});
    soldCount++;
  }

  player.crystals = (player.crystals || 0) + totalCrystals;
  gameState.markDirty('players', player.id);

  res.json({ ok: true, crystals: totalCrystals, sold_count: soldCount, total_crystals: player.crystals });
}
