import { Router } from 'express';
import { supabase, getPlayerByTelegramId, sendTelegramNotification, buildAttackButton } from '../../lib/supabase.js';
import { getCellId, getCell, getCellCenter, getCellsInRange, radiusToDiskK } from '../../lib/grid.js';
import { hqUpgradeCost, HQ_MAX_LEVEL, SMALL_RADIUS, LARGE_RADIUS, MINE_BOOST_RADIUS, calcAccumulatedCoins, getMineIncome, getMineCapacity, getMineCountBoost, getMineHp, getMineHpRegen, calcMineHpRegen, getMineUpgradeCost, mineUpgradeCost, MINE_MAX_LEVEL, distanceMultiplier, getDistanceMultiplier, rollBowPiercing } from '../../lib/formulas.js';
import { getCoresTotalBoost } from '../../lib/cores.js';
import { haversine } from '../../lib/haversine.js';
import { addXp, XP_REWARDS } from '../../lib/xp.js';
import { getClanLevel, getClanDefenseForMine } from '../../lib/clans.js';
import { gridDisk, cellToLatLng } from 'h3-js';
import { gameState } from '../../lib/gameState.js';
import { io, connectedPlayers, lastAttackTime, recordAttack, getAttackCooldown, logActivity } from '../../server.js';
import { logPlayer } from '../../lib/logger.js';
import { persistNow } from '../../game/state/persist.js';
import { ts, getLang } from '../../config/i18n.js';
import { getPlayerSkillEffects, isInShadow } from '../../config/skills.js';
import { WEAPON_COOLDOWNS, HQ_BOOST_COST_HOUR, HQ_BOOST_COST_DAY, HQ_BOOST_HOUR_MS, HQ_BOOST_DAY_MS } from '../../config/constants.js';
import { withPlayerLock } from '../../lib/playerLock.js';
import { setPinMode, setPlayerHq } from '../../security/antispoof.js';
import { awardContestTickets, CONTEST_RULES } from '../../game/mechanics/contest.js';

export const buildingsRouter = Router();

const mineXpDrops = new Map(); // mine_id → { hits, hour }
const XP_CHANCE_TIERS = [0.10, 0.075, 0.05, 0.025];

function emitToNearbyPlayers(lat, lng, radiusM, event, data) {
  for (const [sid, info] of connectedPlayers) {
    if (!info.lat || !info.lng) continue;
    const d = haversine(lat, lng, info.lat, info.lng);
    if (d <= radiusM) io.to(sid).emit(event, data);
  }
}

// ─── Headquarters handlers ───────────────────────────────────────────

async function handleHqPlace(player, body, res) {
  const { lat, lng } = body;
  if (lat == null || lng == null) return res.status(400).json({ error: 'lat, lng are required' });
  const { data: existingHqs } = await supabase.from('headquarters').select('id').eq('player_id', player.id);
  if (existingHqs && existingHqs.length > 0) return res.status(409).json({ error: 'Headquarters already placed' });
  const targetCell = getCellId(parseFloat(lat), parseFloat(lng));
  let finalCell = null;
  const isCellFree = (cell) => !gameState.isCellOccupied(cell);
  if (isCellFree(targetCell)) {
    finalCell = targetCell;
  } else {
    for (let ring = 1; ring <= 5; ring++) {
      const candidates = gridDisk(targetCell, ring).filter(c => c !== targetCell);
      for (const candidate of candidates) {
        if (isCellFree(candidate)) { finalCell = candidate; break; }
      }
      if (finalCell) break;
    }
  }
  if (!finalCell) return res.status(400).json({ error: 'Нет свободных клеток рядом' });
  // Use tap coordinates for HQ placement
  const hqLat = parseFloat(lat);
  const hqLng = parseFloat(lng);
  const cell_id = finalCell;
  const { data: hq, error: insertError } = await supabase.from('headquarters').insert({ player_id: player.id, owner_username: player.username, lat: hqLat, lng: hqLng, cell_id }).select('id,player_id,lat,lng,cell_id,level,created_at').single();
  if (insertError) return res.status(500).json({ error: 'Failed to place headquarters' });
  // Update gameState + antispoof HQ cache
  if (gameState.loaded) {
    gameState.upsertHq(hq);
  }
  setPlayerHq(Number(body.telegram_id), hqLat, hqLng);
  let xpResult = null;
  try { xpResult = await addXp(player.id, XP_REWARDS.BUILD_HQ); } catch (e) { console.error('[xp] addXp error:', e.message); }

  return res.status(201).json({ headquarters: hq, xp: xpResult, player_coins: player.coins ?? 0, player_diamonds: player.diamonds ?? 0 });
}

async function handleHqUpgrade(player, res) {
  const { data: hq, error: hqError } = await supabase.from('headquarters').select('id,level').eq('player_id', player.id).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (hqError) return res.status(500).json({ error: hqError.message });
  if (!hq) return res.status(404).json({ error: 'Headquarters not found' });
  const currentLevel = hq.level ?? 1;
  if (currentLevel >= HQ_MAX_LEVEL) return res.status(400).json({ error: 'Headquarters is already at max level' });
  const cost = hqUpgradeCost(currentLevel);
  const balance = player.coins ?? 0;
  if (balance < cost) return res.status(400).json({ error: `Не хватает монет (нужно ${Math.round(cost).toLocaleString()})` });
  const newBalance = balance - cost;
  const [{ data: updatedHq, error: updateError }, { data: coinsOk, error: coinsError }] = await Promise.all([
    supabase.from('headquarters').update({ level: currentLevel + 1 }).eq('id', hq.id).select('id,player_id,lat,lng,cell_id,level,created_at').single(),
    supabase.from('players').update({ coins: newBalance }).eq('id', player.id).eq('coins', balance).select('id').maybeSingle(),
  ]);
  if (updateError || coinsError) return res.status(500).json({ error: 'Failed to upgrade headquarters' });
  if (!coinsOk && !coinsError) return res.status(409).json({ error: 'Конфликт — попробуйте снова' });
  // Update gameState
  if (gameState.loaded && updatedHq) {
    gameState.upsertHq(updatedHq);
    const p = gameState.getPlayerById(player.id);
    if (p) { p.coins = newBalance; gameState.markDirty('players', p.id); }
    // HQ level changed → boost zone radius changed → invalidate cached boost
    gameState.invalidateMineBoost(player.id);
  }
  let xpResult = null;
  try { xpResult = await addXp(player.id, XP_REWARDS.UPGRADE_HQ); } catch (e) { console.error('[xp] addXp error:', e.message); }
  return res.status(200).json({ headquarters: updatedHq, player_coins: newBalance, xp: xpResult });
}

// ─── HQ activate density boost (paid activation) ─────────────────────────────
async function handleHqActivateBoost(req, res) {
  const { telegram_id, duration } = req.body || {};
  if (!['hour', 'day'].includes(duration)) return res.status(400).json({ error: 'Invalid duration' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const hq = gameState.getHqByPlayerId(player.id);
  if (!hq) return res.status(400).json({ error: 'No HQ' });

  const cost  = duration === 'hour' ? HQ_BOOST_COST_HOUR : HQ_BOOST_COST_DAY;
  const addMs = duration === 'hour' ? HQ_BOOST_HOUR_MS  : HQ_BOOST_DAY_MS;

  if ((player.diamonds || 0) < cost) {
    return res.status(400).json({ error: `Не хватает алмазов (нужно ${cost}💎)` });
  }

  // Stack: extend from max(now, current expires) so back-to-back activations add up.
  const nowMs = Date.now();
  const currentExpires = hq.boost_expires_at ? new Date(hq.boost_expires_at).getTime() : 0;
  const base = Math.max(nowMs, currentExpires);
  const newExpires = new Date(base + addMs).toISOString();

  player.diamonds = (player.diamonds || 0) - cost;
  hq.boost_expires_at = newExpires;
  gameState.markDirty('players', player.id);
  gameState.markDirty('headquarters', hq.id);
  gameState.invalidateMineBoost(player.id);

  await Promise.all([
    persistNow('players', { id: player.id, diamonds: player.diamonds }),
    supabase.from('headquarters').update({ boost_expires_at: newExpires }).eq('id', hq.id),
  ]);

  logPlayer(telegram_id, 'action', `Активировал буст HQ на ${duration === 'hour' ? '1ч' : '24ч'}`, {
    duration, cost, expires_at: newExpires,
  });

  return res.status(200).json({
    success: true,
    diamonds: player.diamonds,
    boost_expires_at: newExpires,
  });
}

async function handleHqSell(player, telegramId, res) {
  const { data: hqs, error: hqError } = await supabase.from('headquarters').select('id').eq('player_id', player.id);
  if (hqError) return res.status(500).json({ error: hqError.message });
  if (!hqs || hqs.length === 0) return res.status(404).json({ error: 'Headquarters not found' });

  // Calculate 25% refund of total upgrade costs
  let hqLevel = 1;
  if (gameState.loaded) {
    const hqObj = gameState.headquarters.get(hqs[0].id);
    if (hqObj) hqLevel = hqObj.level || 1;
  }
  let totalCost = 0;
  for (let i = 1; i < hqLevel; i++) totalCost += (hqUpgradeCost(i) || 0);
  const refund = Math.floor(totalCost * 0.25);

  if (refund > 0) {
    const { data: freshHq } = await supabase.from('players').select('coins').eq('id', player.id).single();
    player.coins = (Number(freshHq?.coins) || 0) + refund;
    await supabase.from('players').update({ coins: player.coins }).eq('id', player.id);
    gameState.markDirty('players', player.id);
  }

  const { error: delError } = await supabase.from('headquarters').delete().eq('player_id', player.id);
  if (delError) return res.status(500).json({ error: delError.message });
  // Update gameState
  if (gameState.loaded) {
    for (const h of hqs) {
      const hqObj = gameState.headquarters.get(h.id);
      if (hqObj) {
        if (hqObj.cell_id) gameState.hqByPlayerId.delete(hqObj.player_id);
        gameState.headquarters.delete(h.id);
      }
    }
  }
  // Reset PIN mode + HQ cache — player must return to real GPS coordinates
  setPinMode(telegramId, false);
  setPlayerHq(Number(telegramId), null, null);
  return res.status(200).json({ success: true, refund, player_coins: player.coins, pin_reset: true });
}

// ─── Mine handlers ───────────────────────────────────────────────────

async function handleMineBuild(req, res) {
  const { telegram_id } = req.body;
  const mineLat = parseFloat(req.body.mine_lat ?? req.body.lat);
  const mineLng = parseFloat(req.body.mine_lng ?? req.body.lng);
  if (!telegram_id || isNaN(mineLat) || isNaN(mineLng)) return res.status(400).json({ error: 'telegram_id and mine position are required' });

  // SECURITY: use server-authoritative position, NOT body coords.
  // Previously used req.body.player_lat/lng which an attacker could forge
  // to build mines anywhere on the map without physically being there.
  const playerPos = (await import('../../lib/playerPosition.js')).getVerifiedPlayerPos(telegram_id);
  if (!playerPos) return res.status(400).json({ error: 'Обновите позицию' });
  const playerActualLat = playerPos.lat;
  const playerActualLng = playerPos.lng;
  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id, 'id, level');
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const hq = gameState.loaded ? gameState.getHqByPlayerId(player.id) : null;
  if (!gameState.loaded) {
    const { data: hqRow, error: hqError } = await supabase.from('headquarters').select('id').eq('player_id', player.id).maybeSingle();
    if (hqError) return res.status(500).json({ error: hqError.message });
    if (!hqRow) return res.status(403).json({ error: 'You must place your headquarters first' });
  } else if (!hq) {
    return res.status(403).json({ error: 'You must place your headquarters first' });
  }
  // Distance check uses tap coordinates (mineLat/mineLng), NOT cell center
  const distance = haversine(playerActualLat, playerActualLng, mineLat, mineLng);
  const _bSkFx = getPlayerSkillEffects(gameState.getPlayerSkills(telegram_id));
  const _effSmall = SMALL_RADIUS + (_bSkFx.radius_bonus || 0);
  if (distance > _effSmall) return res.status(400).json({ error: `Слишком далеко (${Math.round(distance)}м > ${_effSmall}м)`, distance: Math.round(distance) });
  const targetCell = getCell(mineLat, mineLng);
  const [cellCenterLat, cellCenterLng] = getCellCenter(targetCell);
  // Check cell is free from ALL building types
  const cellOccupied =
    [...gameState.mines.values()].some(m => m.cell_id === targetCell && m.status !== 'destroyed') ||
    [...gameState.headquarters.values()].some(h => h.cell_id === targetCell) ||
    [...gameState.collectors.values()].some(c => c.cell_id === targetCell) ||
    [...gameState.clanHqs.values()].some(c => c.cell_id === targetCell) ||
    [...gameState.monuments.values()].some(m => m.cell_id === targetCell) ||
    [...gameState.fireTrucks.values()].some(ft => ft.cell_id === targetCell && ft.status !== 'destroyed');
  if (cellOccupied) return res.status(409).json({ error: 'Клетка уже занята' });
  // Building placed at tap coordinates, cell_id computed from tap
  const { data: mine, error: insertError } = await supabase.from('mines').insert({ owner_id: player.id, original_builder_id: player.id, lat: mineLat, lng: mineLng, cell_id: targetCell, level: 0, hp: 0, max_hp: 0, last_collected: new Date().toISOString() }).select('id,owner_id,original_builder_id,lat,lng,cell_id,level,last_collected,upgrade_finish_at,pending_level,hp,max_hp,status').single();
  if (insertError) return res.status(500).json({ error: insertError.message });
  // Update gameState
  if (gameState.loaded && mine) {
    gameState.upsertMine(mine);
  }
  const pName = gameState.loaded ? gameState.getPlayerByTgId(telegram_id)?.game_username : null;
  logActivity(pName || 'player', 'построил шахту');
  logPlayer(telegram_id, 'action', 'Построил шахту', { cell_id: targetCell, lat: cellCenterLat, lng: cellCenterLng });
  let xpResult = null;
  try { xpResult = await addXp(player.id, XP_REWARDS.BUILD_MINE); } catch (e) { console.error('[xp] addXp error:', e.message); }
  return res.status(201).json({ mine, xp: xpResult });
}

async function handleMineCollect(req, res) {
  const { telegram_id, lat, lng } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });
  // gameState is the source of truth (Iron Rule #2). Reading from DB here and then
  // writing back to gameState clobbers any in-flight in-memory updates (bot kills,
  // vase drops, PvP wins) that persist hasn't flushed yet, silently eating coins.
  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const allMines = [...gameState.mines.values()].filter(m => m.owner_id === player.id);
  if (allMines.length === 0) return res.status(200).json({ collected: 0, player_coins: player.coins ?? 0 });
  // Use server-side position for distance check
  const gsCollector = gameState.getPlayerByTgId(Number(telegram_id));
  if (!gsCollector?.last_lat || !gsCollector?.last_lng) return res.status(400).json({ error: 'Position unknown' });
  const pLat = gsCollector.last_lat, pLng = gsCollector.last_lng;
  const _colFx = getPlayerSkillEffects(gameState.getPlayerSkills(telegram_id));
  const _colSmall = SMALL_RADIUS + (_colFx.radius_bonus || 0);
  const mines = allMines.filter(m => {
    if (m.status === 'burning' || m.status === 'destroyed') return false;
    const mLat = m.lat != null ? m.lat : getCellCenter(m.cell_id)[0];
    const mLng = m.lng != null ? m.lng : getCellCenter(m.cell_id)[1];
    return haversine(pLat, pLng, mLat, mLng) <= _colSmall;
  });
  if (mines.length === 0) return res.status(200).json({ collected: 0, player_coins: player.coins ?? 0 });
  const now = new Date().toISOString();
  let clanIncomeBonus = 0; let clanBoostMul = 1; let clanHqs = [];
  if (player.clan_id) {
    const [{ data: clan }, { data: hqs }] = await Promise.all([
      supabase.from('clans').select('level,boost_expires_at,boost_multiplier').eq('id', player.clan_id).single(),
      supabase.from('clan_headquarters').select('lat,lng').eq('clan_id', player.clan_id),
    ]);
    if (clan) {
      const config = getClanLevel(clan.level);
      clanIncomeBonus = config.income;
      clanHqs = (hqs || []).map(h => ({ lat: h.lat, lng: h.lng, radius: config.radius }));
      // Active boost multiplier
      if (clan.boost_expires_at && new Date(clan.boost_expires_at) > new Date()) {
        clanBoostMul = clan.boost_multiplier || 1;
      }
    }
  }
  // Density boost per mine — use gameState's cached & gated data.
  // Gating (HQ zone + paid activation) is applied inside getMineBoostData.
  const _clanInfoForBoost = (clanIncomeBonus > 0 && clanHqs.length > 0) ? {
    clanHqs: clanHqs.map(h => ({ lat: h.lat, lng: h.lng })),
    radius: clanHqs[0]?.radius || 0,
    defenseMul: 1,
  } : null;
  const _boostData = gameState.getMineBoostData(player.id, _clanInfoForBoost);
  const perMineBoost = _boostData.perMineBoost;
  let totalCoins = 0;
  const mineCoinsMap = new Map();
  for (const mine of mines) {
    const cores = gameState.loaded && mine.cell_id ? gameState.getCoresForMine(mine.cell_id) : [];
    const mineBoost = perMineBoost.get(mine.id) || 1;
    let incBoost = (cores.length > 0 ? getCoresTotalBoost(cores, 'income') : 1) * mineBoost;
    const capBoost = cores.length > 0 ? getCoresTotalBoost(cores, 'capacity') : 1;
    // Skill income bonus
    if (_colFx.mine_income_bonus) incBoost *= (1 + _colFx.mine_income_bonus);
    // Clan zone bonus
    if (clanIncomeBonus > 0 && clanHqs.length > 0) {
      const mLat = mine.lat ?? getCellCenter(mine.cell_id)[0];
      const mLng = mine.lng ?? getCellCenter(mine.cell_id)[1];
      const inZone = clanHqs.some(h => haversine(mLat, mLng, h.lat, h.lng) <= h.radius);
      if (inZone) {
        incBoost *= (1 + clanIncomeBonus / 100);
        if (clanBoostMul > 1) incBoost *= clanBoostMul;
      }
    }
    // Landlord ability (+15% for mines within 200m while online).
    // "Online" means there's an active socket for this telegram_id right now.
    if (_colFx.landlord_bonus) {
      let _isOnline = false;
      for (const [, info] of connectedPlayers) {
        if (Number(info.telegram_id) === Number(telegram_id)) { _isOnline = true; break; }
      }
      if (_isOnline) {
        const mLat = mine.lat ?? getCellCenter(mine.cell_id)[0];
        const mLng = mine.lng ?? getCellCenter(mine.cell_id)[1];
        if (haversine(pLat, pLng, mLat, mLng) <= SMALL_RADIUS) incBoost *= 1.15;
      }
    }
    // Skill capacity bonus
    const _skCapMul = 1 + (_colFx.mine_capacity_bonus || 0);
    const banked = mine.coins || 0;
    const acc = calcAccumulatedCoins(mine.level, mine.last_collected, incBoost, capBoost * _skCapMul) + banked;
    mineCoinsMap.set(mine.id, acc);
    totalCoins += acc;
  }
  // Mutate gameState directly — withPlayerLock (buildings.js router wrap) prevents
  // concurrent collect by the same player, so read-modify-write is atomic in-memory.
  const collectedAmount = Math.round(totalCoins);
  const coinsBefore = player.coins || 0;
  player.coins = coinsBefore + collectedAmount;
  gameState.markDirty('players', player.id);
  for (const m of mines) {
    const gm = gameState.getMineById(m.id);
    if (gm) { gm.last_collected = now; gm.coins = 0; gameState.markDirty('mines', m.id); }
  }
  // Flush critical fields immediately (Iron Rule #11) + reset mines row in parallel.
  const [_playerFlush, { error: minesUpdateError }] = await Promise.all([
    persistNow('players', { id: player.id, coins: player.coins }),
    supabase.from('mines').update({ last_collected: now, coins: 0 }).in('id', mines.map(m => m.id)),
  ]);
  if (minesUpdateError) return res.status(500).json({ error: 'Failed to collect coins' });
  if (collectedAmount > 0) {
    logPlayer(telegram_id, 'action', `Собрал ${collectedAmount.toLocaleString('ru')} монет`, {
      amount: collectedAmount,
      coins_before: coinsBefore,
      coins_after: player.coins,
      mine_count: mines.length,
    });
  }
  const newCoins = player.coins;
  // Per-mine XP: diminishing chance per mine, resets each hour at XX:00
  const xpEvents = [];
  let totalXpGained = 0;
  const currentHour = Math.floor(Date.now() / 3600000);
  {
    const { getCollectXp } = await import('../../game/mechanics/xp.js');
    for (const mine of mines) {
      const mineCoins = mineCoinsMap.get(mine.id) || 0;
      const rec = mineXpDrops.get(mine.id);
      const hits = (rec && rec.hour === currentHour) ? rec.hits : 0;
      const chance = XP_CHANCE_TIERS[Math.min(hits, XP_CHANCE_TIERS.length - 1)];
      const xp = getCollectXp(mineCoins, chance);
      if (xp > 0) {
        totalXpGained += xp;
        xpEvents.push({ xp, lat: mine.lat, lng: mine.lng, cell_id: mine.cell_id });
        mineXpDrops.set(mine.id, { hits: hits + 1, hour: currentHour });
      } else if (!rec || rec.hour !== currentHour) {
        mineXpDrops.set(mine.id, { hits: 0, hour: currentHour });
      }
    }
  }
  let xpResult = null;
  if (totalXpGained > 0) { try { xpResult = await addXp(player.id, totalXpGained); } catch (e) { console.error('[xp] addXp error:', e.message); } }
  const totalIncome = allMines.reduce((sum, m) => (m.status === 'burning' || m.status === 'destroyed') ? sum : sum + getMineIncome(m.level), 0);
  return res.status(200).json({ collected: collectedAmount, total_accumulated: collectedAmount, player_coins: newCoins, xp: xpResult, xp_events: xpEvents, totalIncome, collected_mine_ids: mines.map(m => m.id) });
}

// ─── Attack handlers ─────────────────────────────────────────────────

async function handleAttackStart(req, res) {
  const { telegram_id, mine_id, lat, lng } = req.body || {};
  if (!telegram_id || !mine_id || lat == null || lng == null) return res.status(400).json({ error: 'Missing required fields: telegram_id, mine_id, lat, lng' });
  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id, 'id,game_username,bonus_attack,bonus_crit');
  if (playerError || !player) return res.status(404).json({ error: 'Player not found' });
  const { data: mine, error: mineError } = await supabase.from('mines').select('id,owner_id,level,cell_id,hp,max_hp,last_hp_update,status,lat,lng').eq('id', mine_id).maybeSingle();
  if (mineError || !mine) return res.status(404).json({ error: 'Mine not found' });
  if (mine.owner_id === player.id) return res.status(400).json({ error: 'Нельзя атаковать свою шахту' });
  if (mine.status !== 'normal') return res.status(400).json({ error: 'Шахта уже атакована' });
  if (mine.level < 0) return res.status(400).json({ error: 'Шахта неактивна' });
  // Use server-side position (antispoof-validated) instead of client-supplied lat/lng
  const gsAttacker = gameState.getPlayerByTgId(Number(telegram_id));
  if (!gsAttacker?.last_lat || !gsAttacker?.last_lng) return res.status(400).json({ error: 'Position unknown' });
  const dist = haversine(gsAttacker.last_lat, gsAttacker.last_lng, mine.lat, mine.lng);
  const _hSkFx = getPlayerSkillEffects(gameState.getPlayerSkills(telegram_id));
  const _effLarge = LARGE_RADIUS + (_hSkFx.attack_radius_bonus || 0);
  if (dist > _effLarge) return res.status(400).json({ error: 'Слишком далеко', distance: Math.round(dist) });
  const { data: existingAttack } = await supabase.from('mines').select('id').eq('attacker_id', player.id).eq('status', 'under_attack').maybeSingle();
  if (existingAttack) return res.status(400).json({ error: 'Вы уже атакуете другую шахту' });
  const { data: weapon } = await supabase.from('items').select('type,attack,crit_chance,emoji,rarity').eq('owner_id', player.id).eq('equipped', true).in('type', ['sword', 'axe', 'bow']).maybeSingle();
  const baseAttack = 10;
  const weaponAttack = weapon?.attack || 0;
  const critChance = weapon?.type === 'sword' ? (weapon.crit_chance || 0) : 0;
  const avgDamage = (baseAttack + weaponAttack) * (1 + critChance / 100);
  const atkCores = gameState.loaded && mine.cell_id ? gameState.getCoresForMine(mine.cell_id) : [];
  const atkCoreHp = atkCores.length > 0 ? getCoresTotalBoost(atkCores, 'hp') : 1;
  const atkCoreRegen = atkCores.length > 0 ? getCoresTotalBoost(atkCores, 'regen') : 1;
  const clanDef = getClanDefenseForMine(mine.owner_id, mine.lat, mine.lng);
  const computedMaxHp = Math.round(getMineHp(mine.level) * atkCoreHp * clanDef);
  const regenPerHour = Math.round(getMineHpRegen(mine.level) * atkCoreRegen);
  const rawHp = Math.min(mine.hp ?? computedMaxHp, computedMaxHp);
  const currentHp = calcMineHpRegen(rawHp, computedMaxHp, regenPerHour, mine.last_hp_update);
  const attackDuration = Math.max(3, Math.ceil(currentHp / avgDamage));
  const attackEndsAt = new Date(Date.now() + attackDuration * 1000).toISOString();
  const attackStartedAt = new Date().toISOString();
  const { error: updateError } = await supabase.from('mines').update({ status: 'under_attack', attacker_id: player.id, attack_started_at: attackStartedAt, attack_ends_at: attackEndsAt, hp: currentHp, max_hp: computedMaxHp, last_hp_update: attackStartedAt }).eq('id', mine_id).eq('status', 'normal');
  if (updateError) return res.status(500).json({ error: 'Failed to start attack' });
  // Update gameState
  if (gameState.loaded) {
    const gm = gameState.getMineById(mine_id);
    if (gm) { Object.assign(gm, { status: 'under_attack', attacker_id: player.id, attack_started_at: attackStartedAt, attack_ends_at: attackEndsAt, hp: currentHp, max_hp: computedMaxHp, last_hp_update: attackStartedAt }); gameState.markDirty('mines', mine_id); }
  }
  const ownerLang = gameState.loaded ? (gameState.getPlayerById(mine.owner_id)?.language || 'en') : 'en';
  const shadow = isInShadow(player);
  const atkMsg = ts(ownerLang, 'notif.mine_attacked', { level: mine.level, name: shadow ? '???' : (player.game_username || ts(ownerLang, 'misc.unknown')) });
  const notifId = globalThis.crypto.randomUUID();
  const notif = { id: notifId, player_id: mine.owner_id, type: 'mine_attacked', message: atkMsg, data: { mine_id: mine.id }, read: false, created_at: new Date().toISOString() };
  supabase.from('notifications').insert(notif).then(() => {}).catch(e => console.error('[buildings] notif DB error:', e.message));
  gameState.addNotification(notif);
  const owner = gameState.getPlayerById(mine.owner_id);
  if (owner?.telegram_id) sendTelegramNotification(owner.telegram_id, atkMsg, buildAttackButton(mine.lat, mine.lng));
  return res.json({ success: true, attackDuration, attackEndsAt, weapon: weapon ? { emoji: weapon.emoji, rarity: weapon.rarity, type: weapon.type } : null, mineHp: currentHp, mineMaxHp: computedMaxHp, avgDamage: Math.round(avgDamage) });
}

async function handleAttackFinish(req, res) {
  const { telegram_id, mine_id } = req.body;
  if (!telegram_id || !mine_id) return res.status(400).json({ error: 'telegram_id and mine_id required' });
  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id,bonus_attack,bonus_crit');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const { data: mine, error: mErr } = await supabase.from('mines').select('id,owner_id,level,cell_id,hp,max_hp,status,attacker_id,attack_started_at,attack_ends_at').eq('id', mine_id).maybeSingle();
  if (mErr) return res.status(500).json({ error: mErr.message });
  if (!mine) return res.status(404).json({ error: 'Mine not found' });
  if (mine.status !== 'under_attack') return res.status(400).json({ error: 'Шахта не атакуется' });
  if (mine.attacker_id !== player.id) return res.status(403).json({ error: 'Вы не атакуете эту шахту' });
  const now = Date.now();
  if (new Date(mine.attack_ends_at).getTime() > now + 2000) return res.status(400).json({ error: 'Атака ещё не завершена' });
  const { data: weapon } = await supabase.from('items').select('type,attack,crit_chance').eq('owner_id', player.id).eq('equipped', true).in('type', ['sword', 'axe', 'bow']).maybeSingle();
  const baseAttack = 10;
  const weaponAttack = weapon?.attack || 0;
  const totalAttack = baseAttack + weaponAttack;
  const critChance = weapon?.type === 'sword' ? (weapon.crit_chance || 0) : 0;
  const attackDuration = Math.round((now - new Date(mine.attack_started_at).getTime()) / 1000);
  let remainingHp = mine.hp;
  for (let i = 0; i < attackDuration && remainingHp > 0; i++) {
    const isCrit = Math.random() * 100 < critChance;
    const dmg = isCrit ? totalAttack * 2 : totalAttack;
    remainingHp = Math.max(0, remainingHp - dmg);
  }
  if (remainingHp <= 0) {
    const burnStarted = new Date().toISOString();
    await supabase.from('mines').update({ status: 'burning', hp: 0, burning_started_at: burnStarted, attacker_id: null, attack_started_at: null, attack_ends_at: null, last_hp_update: null, pending_level: null, upgrade_finish_at: null }).eq('id', mine_id);
    // Update gameState
    if (gameState.loaded) {
      const gsPlayer = gameState.getPlayerByTgId(Number(telegram_id));
      const gm = gameState.getMineById(mine_id);
      if (gm) {
        Object.assign(gm, { status: 'burning', hp: 0, burning_started_at: burnStarted, attacker_id: null, attack_started_at: null, attack_ends_at: null, last_hp_update: null, pending_level: null, upgrade_finish_at: null });
        gm._burned_by = { telegram_id: Number(telegram_id), name: gsPlayer?.game_username || player.game_username || '???', avatar: gsPlayer?.avatar || '🎮' };
        gameState.markDirty('mines', mine_id);
      }
    }
    return res.json({ success: true, result: 'burning' });
  } else {
    const hpUpdateTime = new Date().toISOString();
    await supabase.from('mines').update({ status: 'normal', hp: remainingHp, attacker_id: null, attack_started_at: null, attack_ends_at: null, last_hp_update: hpUpdateTime }).eq('id', mine_id);
    // Update gameState
    if (gameState.loaded) {
      const gm = gameState.getMineById(mine_id);
      if (gm) { Object.assign(gm, { status: 'normal', hp: remainingHp, attacker_id: null, attack_started_at: null, attack_ends_at: null, last_hp_update: hpUpdateTime }); gameState.markDirty('mines', mine_id); }
    }
    const finCores = gameState.loaded && mine.cell_id ? gameState.getCoresForMine(mine.cell_id) : [];
    const finCoreHp = finCores.length > 0 ? getCoresTotalBoost(finCores, 'hp') : 1;
    const finClanDef = getClanDefenseForMine(mine.owner_id, mine.lat, mine.lng);
    return res.json({ success: true, result: 'survived', remainingHp, maxHp: Math.round(getMineHp(mine.level) * finCoreHp * finClanDef) });
  }
}

async function handleAttackExtinguish(req, res) {
  const { telegram_id, mine_id } = req.body;
  if (!telegram_id || !mine_id) return res.status(400).json({ error: 'telegram_id and mine_id required' });
  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const { data: mine, error: mErr } = await supabase.from('mines').select('id,owner_id,level,cell_id,lat,lng,status,burning_started_at').eq('id', mine_id).maybeSingle();
  if (mErr) return res.status(500).json({ error: mErr.message });
  if (!mine) return res.status(404).json({ error: 'Mine not found' });
  if (mine.owner_id !== player.id) return res.status(403).json({ error: 'Не ваша шахта' });
  if (mine.status !== 'burning') return res.status(400).json({ error: 'Шахта не горит' });

  // Distance check — player must be within SMALL_RADIUS
  const gsPlayer = gameState.getPlayerByTgId(telegram_id);
  if (!gsPlayer?.last_lat || !gsPlayer?.last_lng) return res.status(400).json({ error: 'Position unknown' });
  const dist = haversine(gsPlayer.last_lat, gsPlayer.last_lng, mine.lat, mine.lng);
  if (dist > SMALL_RADIUS) return res.status(400).json({ error: 'Слишком далеко' });

  if (Date.now() - new Date(mine.burning_started_at).getTime() > 86400000) {
    await supabase.from('mines').update({ status: 'destroyed' }).eq('id', mine_id);
    if (gameState.loaded) { const gm = gameState.getMineById(mine_id); if (gm) { gm.status = 'destroyed'; gameState.markDirty('mines', mine_id); } }
    return res.json({ success: false, error: 'Шахта сгорела — слишком поздно' });
  }
  const extCores = gameState.loaded && mine.cell_id ? gameState.getCoresForMine(mine.cell_id) : [];
  const extCoreHp = extCores.length > 0 ? getCoresTotalBoost(extCores, 'hp') : 1;
  const extClanDef = getClanDefenseForMine(mine.owner_id, mine.lat, mine.lng);
  const computedMaxHp = Math.round(getMineHp(mine.level) * extCoreHp * extClanDef);
  const restoredHp = Math.round(computedMaxHp * 0.25);
  const hpUpdateTime = new Date().toISOString();
  await supabase.from('mines').update({ status: 'normal', hp: restoredHp, max_hp: computedMaxHp, burning_started_at: null, last_hp_update: hpUpdateTime }).eq('id', mine_id);
  // Update gameState
  if (gameState.loaded) {
    const gm = gameState.getMineById(mine_id);
    if (gm) { Object.assign(gm, { status: 'normal', hp: restoredHp, max_hp: computedMaxHp, burning_started_at: null, last_hp_update: hpUpdateTime }); gameState.markDirty('mines', mine_id); }
  }
  return res.json({ success: true, restoredHp, maxHp: computedMaxHp });
}

function calcSellRefund(level) {
  let sum = 0;
  for (let i = 0; i < level; i++) sum += getMineUpgradeCost(i);
  return Math.floor(sum * 0.25);
}

async function handleAttackSellMine(req, res) {
  const { telegram_id, mine_id } = req.body;
  if (!telegram_id || !mine_id) return res.status(400).json({ error: 'telegram_id and mine_id are required' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const mine = gameState.getMineById(mine_id);
  if (!mine) return res.status(404).json({ error: 'Mine not found' });
  if (mine.owner_id !== player.id) return res.status(403).json({ error: 'You do not own this mine' });
  if (mine.status === 'burning' || mine.status === 'under_attack') return res.status(400).json({ error: 'Нельзя продать горящую постройку' });

  const sellCores = mine.cell_id ? gameState.getCoresForMine(mine.cell_id) : [];
  if (sellCores.length > 0) return res.status(400).json({ error: 'Сначала извлеките все ядра из постройки' });

  const collected = calcAccumulatedCoins(mine.level, mine.last_collected, 1, 1) + (mine.coins || 0);
  const refund = calcSellRefund(mine.level);
  const total = collected + refund;
  const balance = player.coins ?? 0;
  const newCoins = balance + Math.round(total);

  const [{ data: coinsOk, error: playerUpdateError }, { error: deleteError }] = await Promise.all([
    supabase.from('players').update({ coins: newCoins }).eq('id', player.id).eq('coins', balance).select('id').maybeSingle(),
    supabase.from('mines').delete().eq('id', mine_id),
  ]);
  if (playerUpdateError || deleteError) return res.status(500).json({ error: 'Failed to sell mine' });
  if (!coinsOk && !playerUpdateError) return res.status(409).json({ error: 'Конфликт — попробуйте снова' });

  gameState.removeMine(mine_id);
  player.coins = newCoins;
  gameState.markDirty('players', player.id);

  return res.status(200).json({ collected: Math.round(collected), refund: Math.round(refund), total: Math.round(total), player_coins: newCoins });
}

// ─── Upgrade handlers ────────────────────────────────────────────────

async function handleUpgradeGet(req, res) {
  const { telegram_id } = req.query;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });
  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id, 'id');
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const { data: readyMines, error } = await supabase.from('mines').select('id, owner_id, level, pending_level, cell_id, lat, lng').eq('owner_id', player.id).not('pending_level', 'is', null).lte('upgrade_finish_at', new Date().toISOString());
  if (error) return res.status(500).json({ error: error.message });
  if (!readyMines || readyMines.length === 0) return res.json({ completed: [] });
  const completed = [];
  for (const mine of readyMines) {
    const upgCores = gameState.loaded && mine.cell_id ? gameState.getCoresForMine(mine.cell_id) : [];
    const upgCoreHp = upgCores.length > 0 ? getCoresTotalBoost(upgCores, 'hp') : 1;
    const upgClanDef = getClanDefenseForMine(mine.owner_id, mine.lat, mine.lng);
    const newMaxHp = Math.round(getMineHp(mine.pending_level) * upgCoreHp * upgClanDef);
    const { data: updated, error: upErr } = await supabase.from('mines').update({ level: mine.pending_level, pending_level: null, upgrade_finish_at: null, hp: newMaxHp, max_hp: newMaxHp }).eq('id', mine.id).select().single();
    if (upErr) continue;
    // Sync gameState immediately so tick returns correct level
    if (gameState.loaded) {
      const gm = gameState.getMineById(mine.id);
      if (gm) {
        gm.level = mine.pending_level;
        gm.pending_level = null;
        gm.upgrade_finish_at = null;
        gm.hp = newMaxHp;
        gm.max_hp = newMaxHp;
        gameState.markDirty('mines', mine.id);
      }
    }
    let xpResult = null;
    try { xpResult = await addXp(player.id, XP_REWARDS.UPGRADE_MINE(mine.pending_level)); } catch (e) { console.error('[xp] addXp error:', e.message); }
    completed.push({ ...updated, xp: xpResult });
  }
  return res.json({ completed });
}

async function handleUpgradePost(req, res) {
  const { telegram_id, mine_id, lat, lng, targetLevel: targetLevelParam } = req.body;
  if (!telegram_id || !mine_id) return res.status(400).json({ error: 'telegram_id and mine_id are required' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const mine = gameState.getMineById(mine_id);
  if (!mine) return res.status(404).json({ error: 'Mine not found' });
  if (mine.owner_id !== player.id) return res.status(403).json({ error: 'You do not own this mine' });

  // Distance check
  if (!player.last_lat || !player.last_lng) return res.status(400).json({ error: 'Position unknown' });
  const distance = haversine(player.last_lat, player.last_lng, mine.lat, mine.lng);
  const _upgFx = getPlayerSkillEffects(gameState.getPlayerSkills(telegram_id));
  const _upgSmall = SMALL_RADIUS + (_upgFx.radius_bonus || 0);
  if (distance > _upgSmall) return res.status(400).json({ error: `Слишком далеко! Подойди ближе (${_upgSmall}м)`, distance: Math.round(distance) });
  if (mine.level >= MINE_MAX_LEVEL) return res.status(400).json({ error: 'Mine is already at max level' });

  // Block if upgrade already in progress
  if (mine.pending_level != null && mine.upgrade_finish_at && new Date(mine.upgrade_finish_at) > new Date()) {
    const secondsLeft = Math.ceil((new Date(mine.upgrade_finish_at) - new Date()) / 1000);
    return res.status(400).json({ error: `Апгрейд ещё идёт (${secondsLeft} сек)` });
  }

  const targetLevel = Math.min(parseInt(targetLevelParam) || mine.level + 1, MINE_MAX_LEVEL);
  if (targetLevel <= mine.level) return res.status(400).json({ error: 'targetLevel должен быть выше текущего уровня' });

  let cost = 0;
  for (let l = mine.level; l < targetLevel; l++) cost += mineUpgradeCost(l);
  const balance = player.coins ?? 0;
  if (balance < cost) return res.status(400).json({ error: `Не хватает монет (нужно ${Math.round(cost).toLocaleString()})` });
  const newBalance = balance - cost;

  // Upgrade time: each level costs its number in seconds
  let upgradeSecs = 0;
  for (let l = mine.level; l < targetLevel; l++) upgradeSecs += l;
  if (upgradeSecs < 1) upgradeSecs = 1;
  const finishAt = new Date(Date.now() + upgradeSecs * 1000);

  // Deduct coins with optimistic lock
  const { data: coinsOk, error: playerUpdateError } = await supabase
    .from('players').update({ coins: newBalance })
    .eq('id', player.id).eq('coins', balance)
    .select('id').maybeSingle();
  if (playerUpdateError) return res.status(500).json({ error: 'Failed to deduct coins' });
  if (!coinsOk) return res.status(409).json({ error: 'Конфликт — попробуйте снова' });

  // Set pending upgrade with timer
  const { error: mineUpdateError } = await supabase
    .from('mines').update({ pending_level: targetLevel, upgrade_finish_at: finishAt.toISOString() })
    .eq('id', mine_id);
  if (mineUpdateError) {
    console.error('[upgrade] mine update error, rolling back coins:', mineUpdateError.message);
    await supabase.from('players').update({ coins: balance }).eq('id', player.id).eq('coins', newBalance).catch(() => {});
    return res.status(500).json({ error: 'Ошибка при обновлении шахты, попробуйте снова' });
  }

  // Update gameState
  mine.pending_level = targetLevel;
  mine.upgrade_finish_at = finishAt.toISOString();
  gameState.markDirty('mines', mine_id);
  player.coins = newBalance;
  gameState.markDirty('players', player.id);

  logPlayer(telegram_id, 'action', `Улучшил шахту до уровня ${targetLevel}`, { mine_id, cost });
  return res.status(200).json({ upgrading: true, finishAt: finishAt.toISOString(), secondsLeft: upgradeSecs, player_coins: newBalance, pendingLevel: targetLevel });
}

// ─── Single-hit mine attack (projectile) ─────────────────────────────

async function handleMineHit(req, res) {
  const { telegram_id, mine_id, lat, lng } = req.body || {};
  if (!telegram_id || !mine_id || lat == null || lng == null)
    return res.status(400).json({ error: 'Missing required fields: telegram_id, mine_id, lat, lng' });

  // Look up player in gameState
  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  // Rate limit by weapon cooldown (centralized: weapon + skill speed bonus)
  const cooldownMs = getAttackCooldown(telegram_id);
  const now = Date.now();
  const lastTime = lastAttackTime.get(String(telegram_id)) || 0;
  if (now - lastTime < cooldownMs)
    return res.status(429).json({ error: 'Cooldown', retry_after: cooldownMs - (now - lastTime) });
  recordAttack(telegram_id, now);

  // Get equipped weapon from gameState
  const playerItems = gameState.getPlayerItems(player.id);
  const weapon = playerItems.find(i => (i.type === 'sword' || i.type === 'axe' || i.type === 'bow') && i.equipped);
  const weaponType = weapon ? weapon.type : 'none';

  // Look up mine in gameState
  const mine = gameState.getMineById(mine_id);
  if (!mine) return res.status(404).json({ error: 'Mine not found' });
  if (mine.owner_id === player.id) return res.status(400).json({ error: 'Нельзя атаковать свою шахту' });
  if (mine.status !== 'normal' && mine.status !== 'under_attack')
    return res.status(400).json({ error: 'Шахта недоступна для атаки' });
  if (mine.level < 0) return res.status(400).json({ error: 'Шахта неактивна' });

  // Distance check — use server-side position (antispoof-validated)
  if (!player.last_lat || !player.last_lng) return res.status(400).json({ error: 'Position unknown' });
  const dist = haversine(player.last_lat, player.last_lng, mine.lat, mine.lng);
  const _hitFx = getPlayerSkillEffects(gameState.getPlayerSkills(telegram_id));
  if (dist > LARGE_RADIUS + (_hitFx.attack_radius_bonus || 0)) return res.status(400).json({ error: 'Слишком далеко', distance: Math.round(dist) });

  // Calculate damage
  const baseDmg = 10 + (weapon?.attack || 0);
  const multiplier = getDistanceMultiplier(weapon, dist, LARGE_RADIUS + (_hitFx.attack_radius_bonus || 0));
  const isPiercing = rollBowPiercing(weapon);
  let damage = Math.round(baseDmg * multiplier);
  if (isPiercing) damage += baseDmg; // bonus piercing arrow
  if (_hitFx.weapon_damage_bonus) damage = Math.round(damage * (1 + _hitFx.weapon_damage_bonus));
  let isCrit = false;
  let isExecution = false;

  // Sword crit with multiplier
  if (weapon?.type === 'sword') {
    const critChance = (weapon.crit_chance || 0) + (_hitFx.crit_chance_bonus || 0) * 100;
    if (Math.random() * 100 < critChance) {
      const wLvl = weapon.upgrade_level || 0;
      let critMul = 1.5;
      if (weapon.rarity === 'mythic') critMul = 1.5 + (wLvl / 90) * 0.7;
      else if (weapon.rarity === 'legendary') critMul = 1.5 + (wLvl / 100) * 1.5;
      damage = Math.floor(damage * critMul);
      isCrit = true;
    }
  }

  // Axe execution chance (checked after HP regen below)
  let execChance = 0;
  if (weapon?.type === 'axe') {
    const wLvl = weapon.upgrade_level || 0;
    if (weapon.rarity === 'mythic') execChance = 7 + (wLvl / 90) * 10;
    else if (weapon.rarity === 'legendary') execChance = 13 + (wLvl / 100) * 7;
  }

  // Apply core HP/regen boosts
  const mineCores = gameState.loaded && mine.cell_id ? gameState.getCoresForMine(mine.cell_id) : [];
  const coreHpBoost = mineCores.length > 0 ? getCoresTotalBoost(mineCores, 'hp') : 1;
  const coreRegenBoost = mineCores.length > 0 ? getCoresTotalBoost(mineCores, 'regen') : 1;

  // Apply clan defense bonus + skill HP bonus to mine HP
  const clanDef = getClanDefenseForMine(mine.owner_id, mine.lat, mine.lng);
  const _ownerP = gameState.getPlayerById(mine.owner_id);
  const _ownerFx = _ownerP ? getPlayerSkillEffects(gameState.getPlayerSkills(_ownerP.telegram_id)) : null;
  const _sHpB = _ownerFx ? (1 + _ownerFx.mine_hp_bonus) : 1;
  let computedMaxHp = Math.round(getMineHp(mine.level) * coreHpBoost * clanDef * _sHpB);
  // Mine damage reduction skill
  if (_ownerFx && _ownerFx.mine_damage_reduction) {
    damage = Math.round(damage * (1 - _ownerFx.mine_damage_reduction));
  }

  // Apply HP regen first, then subtract damage
  const regenPerHour = Math.round(getMineHpRegen(mine.level) * coreRegenBoost);
  const rawHp = Math.min(mine.hp ?? computedMaxHp, computedMaxHp);
  let currentHp = calcMineHpRegen(rawHp, computedMaxHp, regenPerHour, mine.last_hp_update);

  // Axe execution: if building < 50% HP, chance to instant-destroy
  if (execChance > 0 && currentHp < computedMaxHp * 0.5 && Math.random() * 100 < execChance) {
    damage = currentHp;
    isExecution = true;
  }

  currentHp = Math.max(0, currentHp - damage);

  const hpUpdateTime = new Date().toISOString();
  let burned = false;
  let stolenCoins = 0;
  let xpResult = null;

  if (currentHp <= 0) {
    // Mine is burning
    burned = true;

    // Calculate accumulated coins in the destroyed mine (attacker loot)
    const lootIncBoost = mineCores.length > 0 ? getCoresTotalBoost(mineCores, 'income') : 1;
    const lootCapBoost = mineCores.length > 0 ? getCoresTotalBoost(mineCores, 'capacity') : 1;
    stolenCoins = calcAccumulatedCoins(mine.level, mine.last_collected, lootIncBoost, lootCapBoost) + (mine.coins || 0);

    mine.status = 'burning';
    mine.hp = 0;
    mine.max_hp = computedMaxHp;
    mine.burning_started_at = hpUpdateTime;
    mine.last_collected = hpUpdateTime; // coins taken
    mine.coins = 0;
    // Save attacker info for display on burning mine (persisted via attacker_id)
    const _burnShadow = isInShadow(player);
    mine._burned_by = { telegram_id: player.telegram_id, name: _burnShadow ? '???' : (player.game_username || '???'), avatar: _burnShadow ? '🎮' : (player.avatar || '🎮') };
    mine.attacker_id = player.id;
    mine.attack_started_at = null;
    mine.attack_ends_at = null;
    mine.last_hp_update = null;
    mine.pending_level = null;
    mine.upgrade_finish_at = null;
    gameState.markDirty('mines', mine_id);

    // Write to DB immediately (keep attacker_id for burned_by display)
    await supabase.from('mines').update({
      status: 'burning', hp: 0, max_hp: computedMaxHp,
      burning_started_at: hpUpdateTime, last_collected: hpUpdateTime,
      attacker_id: player.id, attack_started_at: null, attack_ends_at: null, last_hp_update: null,
      pending_level: null, upgrade_finish_at: null,
    }).eq('id', mine_id);

    // Add stolen coins to attacker
    if (stolenCoins > 0) {
      const attackerPlayer = gameState.getPlayerById(player.id);
      const oldCoins = attackerPlayer?.coins ?? 0;
      const newCoins = oldCoins + stolenCoins;
      await supabase.from('players').update({ coins: newCoins }).eq('id', player.id).eq('coins', oldCoins);
      if (attackerPlayer) { attackerPlayer.coins = newCoins; gameState.markDirty('players', player.id); }
      logPlayer(player.telegram_id, 'action', `Разрушил шахту lv${mine.level}, украл ${stolenCoins.toLocaleString('ru')} монет`, { mine_id, stolenCoins });
    }

    // XP: 10% chance, 1% of stolen coins (same mechanic as own mine collection)
    const { getCollectXp } = await import('../../game/mechanics/xp.js');
    const xpGain = getCollectXp(stolenCoins);
    if (xpGain > 0) {
      try { xpResult = await addXp(player.id, xpGain); } catch (_) {}
    }

    // Contest: ticket for destroying enemy mine of level >= mineDestroyMinLevel
    if (mine.level >= CONTEST_RULES.mineDestroyMinLevel && mine.owner_id !== player.id) {
      awardContestTickets(player.telegram_id, 'mine_destroy', CONTEST_RULES.mineDestroyTickets, {
        mine_id, mine_level: mine.level, owner_id: mine.owner_id,
      }).catch(() => {});
    }
  } else {
    // Update mine HP in gameState
    if (mine.status === 'normal') {
      mine.status = 'under_attack';
      mine.attacker_id = player.id;

      // Notify owner on first hit
      const hitOwnerLang = gameState.loaded ? (gameState.getPlayerById(mine.owner_id)?.language || 'en') : 'en';
      const _hitShadow = isInShadow(player);
      const hitAtkMsg = ts(hitOwnerLang, 'notif.mine_attacked', { level: mine.level, name: _hitShadow ? '???' : (player.game_username || ts(hitOwnerLang, 'misc.unknown')) });
      const hitNotifId = globalThis.crypto.randomUUID();
      const hitNotif = { id: hitNotifId, player_id: mine.owner_id, type: 'mine_attacked', message: hitAtkMsg, data: { mine_id: mine.id }, read: false, created_at: new Date().toISOString() };
      supabase.from('notifications').insert(hitNotif).then(() => {}).catch(e => console.error('[buildings] DB error:', e.message));
      gameState.addNotification(hitNotif);

      const hitOwner = gameState.getPlayerById(mine.owner_id);
      if (hitOwner?.telegram_id) sendTelegramNotification(hitOwner.telegram_id, hitAtkMsg, buildAttackButton(mine.lat, mine.lng));
    }
    mine.hp = currentHp;
    mine.max_hp = computedMaxHp;
    mine.last_hp_update = hpUpdateTime;
    gameState.markDirty('mines', mine_id);
  }

  // Emit projectile to nearby sockets (1.5km from target for wider observer coverage)
  emitToNearbyPlayers(mine.lat, mine.lng, 1500, 'projectile', {
    from_lat: player.last_lat, from_lng: player.last_lng,
    to_lat: mine.lat, to_lng: mine.lng,
    damage, crit: isCrit, execution: isExecution, piercing: isPiercing,
    target_type: 'mine',
    target_id: mine_id,
    attacker_id: isInShadow(player) ? 0 : player.telegram_id,
    weapon_type: weaponType === 'none' ? 'fist' : weaponType,
  });

  // Emit mine HP update to nearby sockets
  emitToNearbyPlayers(mine.lat, mine.lng, 1000, 'mine:hp_update', {
    mine_id, cell_id: mine.cell_id,
    hp: burned ? 0 : currentHp, max_hp: computedMaxHp,
    status: mine.status,
    ...(burned && mine._burned_by ? { burned_by: mine._burned_by } : {}),
  });

  return res.json({
    success: true, damage, crit: isCrit,
    mine_hp: burned ? 0 : currentHp, mine_max_hp: computedMaxHp,
    status: mine.status, burned,
    ...(burned && { stolenCoins, xp: xpResult }),
    effective_cd: cooldownMs,
  });
}

// ─── Route definitions ───────────────────────────────────────────────

buildingsRouter.post('/headquarters', async (req, res) => {
  const { telegram_id, action } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });
  return withPlayerLock(telegram_id, async () => {
    // activate-boost: gameState is the source of truth, no DB-sourced player needed.
    if (action === 'activate-boost') return handleHqActivateBoost(req, res);

    const { player, error: playerError } = await getPlayerByTelegramId(telegram_id, 'id, username, coins, diamonds');
    if (playerError) return res.status(500).json({ error: playerError?.message || 'DB error' });
    if (!player) return res.status(404).json({ error: 'Player not found' });
    if (action === 'upgrade') return handleHqUpgrade(player, res);
    if (action === 'sell') return handleHqSell(player, telegram_id, res);
    return handleHqPlace(player, req.body, res);
  });
});

buildingsRouter.post('/mine', async (req, res) => {
  const { action, telegram_id } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });
  return withPlayerLock(telegram_id, async () => {
    if (action === 'collect') return handleMineCollect(req, res);
    return handleMineBuild(req, res);
  });
});

buildingsRouter.post('/attack', async (req, res) => {
  const { action, telegram_id } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });
  return withPlayerLock(telegram_id, async () => {
    if (action === 'hit') return handleMineHit(req, res);
    if (action === 'finish') return handleAttackFinish(req, res);
    if (action === 'extinguish') return handleAttackExtinguish(req, res);
    if (action === 'sell') return handleAttackSellMine(req, res);
    return handleAttackStart(req, res);
  });
});

buildingsRouter.get('/upgrade', async (req, res) => {
  const { telegram_id } = req.query;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });
  return withPlayerLock(telegram_id, async () => handleUpgradeGet(req, res));
});
buildingsRouter.post('/upgrade', async (req, res) => {
  const { telegram_id } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });
  return withPlayerLock(telegram_id, async () => handleUpgradePost(req, res));
});
