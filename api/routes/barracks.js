import { Router } from 'express';
import { supabase } from '../../lib/supabase.js';
import { haversine } from '../../lib/haversine.js';
import { getCellId } from '../../lib/grid.js';
import { gameState } from '../../lib/gameState.js';
import { io, connectedPlayers, lastAttackTime, recordAttack, getAttackCooldown, logActivity } from '../../server.js';
import { addXp } from '../../lib/xp.js';
import { distanceMultiplier } from '../../lib/formulas.js';
import { getPlayerSkillEffects, isInShadow } from '../../config/skills.js';
import { sendTelegramNotification, buildAttackButton } from '../../lib/supabase.js';
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
import { withPlayerLock } from '../../lib/playerLock.js';

export const barracksRouter = Router();

function emitToNearby(lat, lng, radiusM, event, data) {
  for (const [sid, info] of connectedPlayers) {
    if (!info.lat || !info.lng) continue;
    if (haversine(lat, lng, info.lat, info.lng) <= radiusM) io.to(sid).emit(event, data);
  }
}

barracksRouter.post('/', async (req, res) => {
  const { action, telegram_id } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  // Per-player serialization for currency / state mutations.
  // 'status' is read-only, 'hit' is a PvP attack handled via per-player attack
  // cooldown rather than the lock (lockable but adds latency).
  const skipLock = action === 'status';
  const handler = () => {
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
    if (action === 'hit') return handleHit(req, res);
    if (action === 'extinguish') return handleExtinguish(req, res);
    return res.status(400).json({ error: 'Unknown action' });
  };

  if (skipLock) return handler();
  return withPlayerLock(telegram_id, handler);
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
  await supabase.from('barracks').insert(barracks);

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
    await supabase.from('unit_upgrades').insert(upgrade);
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
  if (barracks.status === 'burning') return res.status(400).json({ error: 'Нельзя продать горящую постройку' });

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
  await supabase.from('training_queue').insert(entry);

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
      await supabase.from('unit_bag').insert(unit);

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

  // If entry_id specified, boost single entry; otherwise boost all.
  // Skip entries whose training is already finished — player should collect them
  // instead of paying diamonds to "boost" something that's already done.
  const nowMsBoost = Date.now();
  const isStillTraining = q => new Date(q.finish_at).getTime() > nowMsBoost;
  const queue = getTrainingQueue(barracks.id);
  const toBoost = entry_id
    ? queue.filter(q => q.id === entry_id && isStillTraining(q))
    : queue.filter(isStillTraining);

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
    // Try DB before creating fresh (prevents level reset after restart)
    const { data: dbUpgrade } = await supabase.from('unit_upgrades')
      .select('*').eq('owner_id', Number(telegram_id)).eq('unit_type', 'scout').maybeSingle();
    if (dbUpgrade) {
      upgrade = dbUpgrade;
      gameState.unitUpgrades.set(upgradeKey, upgrade);
    } else {
      upgrade = { id: globalThis.crypto.randomUUID(), owner_id: Number(telegram_id), unit_type: 'scout', level: 1 };
      gameState.unitUpgrades.set(upgradeKey, upgrade);
    }
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
  // Persist immediately — prevent level loss on server restart
  await persistNow('unit_upgrades', { id: upgrade.id, owner_id: upgrade.owner_id, unit_type: upgrade.unit_type, level: nextLevel });

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
  await supabase.from('active_scouts').insert(activeScout);

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

  // Weapon cooldown (centralized: weapon + skill speed bonus)
  const cooldownMs = getAttackCooldown(telegram_id);
  const now = Date.now();
  const lastAtk = lastAttackTime.get(String(telegram_id)) || 0;
  if (now - lastAtk < cooldownMs) return res.status(429).json({ error: 'Кулдаун' });
  recordAttack(telegram_id, now);

  // Calculate damage
  const equipped = [...gameState.items.values()].find(i =>
    i.owner_id === player.id && i.equipped && (i.type === 'sword' || i.type === 'axe'));
  const baseAtk = 10 + (equipped?.attack || 0);
  const dmgMul = distanceMultiplier(dist, LARGE_RADIUS);
  const damage = Math.round(baseAtk * dmgMul);

  scout.hp -= damage;
  const killed = scout.hp <= 0;

  if (killed) {
    // Scout dies
    gameState.activeScouts.delete(scout.id);
    supabase.from('active_scouts').delete().eq('id', scout.id).then(() => {}).catch(() => {});

    // Reward attacker
    player.crystals = (player.crystals || 0) + SCOUT_KILL_REWARD_CRYSTALS;
    await persistNow('players', { id: player.id, crystals: player.crystals });
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

  res.json({ ok: true, damage, killed, scout_hp: Math.max(0, scout.hp), reward: killed ? SCOUT_KILL_REWARD_CRYSTALS : 0, effective_cd: cooldownMs });
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
  await persistNow('players', { id: player.id, crystals: player.crystals });

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
  await persistNow('players', { id: player.id, crystals: player.crystals });

  res.json({ ok: true, crystals: totalCrystals, sold_count: soldCount, total_crystals: player.crystals });
}

// ── HIT (PvP attack on enemy barracks) ──
async function handleHit(req, res) {
  const { telegram_id, barracks_id, lat, lng } = req.body || {};
  if (!telegram_id || !barracks_id || lat == null || lng == null)
    return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const bk = gameState.barracks.get(barracks_id);
  if (!bk) return res.status(404).json({ error: 'Barracks not found' });
  const lang = getLang(gameState, telegram_id);
  if (bk.owner_id === player.id) return res.status(400).json({ error: ts(lang, 'err.cant_attack_own') });
  if (bk.hp <= 0 || bk.status === 'burning') return res.status(400).json({ error: ts(lang, 'err.already_destroyed') });

  if (!player.last_lat || !player.last_lng) return res.status(400).json({ error: 'Position unknown' });
  const dist = haversine(player.last_lat, player.last_lng, bk.lat, bk.lng);
  const _skFx = getPlayerSkillEffects(gameState.getPlayerSkills(telegram_id));
  if (dist > LARGE_RADIUS + (_skFx.attack_radius_bonus || 0)) return res.status(400).json({ error: ts(lang, 'err.too_far_short') });

  // Weapon cooldown (centralized: weapon + skill speed bonus)
  const cooldownMs = getAttackCooldown(telegram_id);
  const now = Date.now();
  const last = lastAttackTime.get(String(telegram_id)) || 0;
  if (now - last < cooldownMs) return res.status(429).json({ error: 'Cooldown' });
  recordAttack(telegram_id, now);

  // Damage calc (same as fire truck)
  const items = gameState.getPlayerItems(player.id);
  const weapon = items.find(i => (i.type === 'sword' || i.type === 'axe') && i.equipped);
  const weaponType = weapon ? weapon.type : 'none';
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

  bk.hp = Math.max(0, bk.hp - damage);
  bk.last_hp_update = new Date().toISOString();
  gameState.markDirty('barracks', bk.id);

  // Emit projectile
  emitToNearby(bk.lat, bk.lng, 1500, 'projectile', {
    from_lat: player.last_lat, from_lng: player.last_lng,
    to_lat: bk.lat, to_lng: bk.lng,
    damage, crit: isCrit,
    target_type: 'barracks', target_id: bk.id,
    weapon_type: weaponType === 'none' ? 'fist' : weaponType,
    attacker_id: isInShadow(player) ? 0 : player.id,
  });

  emitToNearby(bk.lat, bk.lng, 1000, 'barracks:hp_update', {
    barracks_id: bk.id, hp: bk.hp, max_hp: bk.max_hp,
  });

  let destroyed = false;

  if (bk.hp <= 0) {
    destroyed = true;
    const nowISO = new Date().toISOString();
    bk.status = 'burning';
    bk.burning_started_at = nowISO;
    gameState.markDirty('barracks', bk.id);

    await supabase.from('barracks').update({
      hp: 0, status: 'burning', burning_started_at: nowISO,
    }).eq('id', bk.id);

    // Notify owner
    const owner = gameState.getPlayerById(bk.owner_id);
    if (owner) {
      const oLang = owner.language || 'en';
      const msg = oLang === 'ru' ? '🔥 Ваша казарма горит!' : '🔥 Your barracks is burning!';
      const notif = {
        id: globalThis.crypto.randomUUID(),
        player_id: owner.id, type: 'barracks_burning', message: msg, read: false,
        created_at: nowISO,
      };
      gameState.addNotification(notif);
      supabase.from('notifications').insert(notif).then(() => {}).catch(e => console.error('[barracks] error:', e.message));
      if (owner.telegram_id) sendTelegramNotification(owner.telegram_id, msg, buildAttackButton(bk.lat, bk.lng));
    }

    emitToNearby(bk.lat, bk.lng, 1000, 'barracks:burning', {
      barracks_id: bk.id,
      attacker_name: isInShadow(player) ? '???' : (player.game_username || '?'),
    });

    try { await addXp(player.id, 100); } catch (_) {}
    logActivity(player.game_username, `burned barracks lv${bk.level}`);
  }

  return res.json({ damage, crit: isCrit, destroyed, hp: bk.hp, max_hp: bk.max_hp, status: bk.status, effective_cd: cooldownMs });
}

// ── EXTINGUISH (owner puts out burning barracks) ──
async function handleExtinguish(req, res) {
  const { telegram_id, barracks_id } = req.body || {};
  if (!telegram_id || !barracks_id) return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const bk = gameState.barracks.get(barracks_id);
  if (!bk || bk.owner_id !== player.id) return res.status(404).json({ error: 'Barracks not found' });
  const lang = getLang(gameState, telegram_id);
  if (bk.status !== 'burning') return res.status(400).json({ error: ts(lang, 'err.not_burning') });

  // Distance check
  if (!player.last_lat || !player.last_lng) return res.status(400).json({ error: 'Position unknown' });
  const dist = haversine(player.last_lat, player.last_lng, bk.lat, bk.lng);
  if (dist > SMALL_RADIUS) return res.status(400).json({ error: ts(lang, 'err.too_far_short') });

  // 24h timeout
  if (Date.now() - new Date(bk.burning_started_at).getTime() > 86400000) {
    gameState.barracks.delete(bk.id);
    await supabase.from('barracks').delete().eq('id', bk.id);
    return res.status(400).json({ error: ts(lang, 'err.too_late') });
  }

  // Restore 25% HP
  const cfg = BARRACKS_LEVELS[bk.level] || BARRACKS_LEVELS[1];
  const restoredHp = Math.round(cfg.hp * 0.25);
  const _bkExtNow = new Date().toISOString();
  bk.status = 'active';
  bk.burning_started_at = null;
  bk.hp = restoredHp;
  bk.last_hp_update = _bkExtNow;
  gameState.markDirty('barracks', bk.id);

  await supabase.from('barracks').update({
    status: 'active', burning_started_at: null, hp: restoredHp, last_hp_update: _bkExtNow,
  }).eq('id', bk.id);

  return res.json({ success: true, hp: restoredHp, max_hp: cfg.hp });
}
