import { Router } from 'express';
import { supabase, getPlayerByTelegramId, sendTelegramNotification } from '../../lib/supabase.js';
import { getCellId, getCell, getCellCenter, getCellsInRange, radiusToDiskK } from '../../lib/grid.js';
import { hqUpgradeCost, HQ_MAX_LEVEL, SMALL_RADIUS, LARGE_RADIUS, calcAccumulatedCoins, getMineIncome, getMineCapacity, getMineHp, getMineHpRegen, calcMineHpRegen, getMineUpgradeCost, mineUpgradeCost, MINE_MAX_LEVEL } from '../../lib/formulas.js';
import { getCoresTotalBoost } from '../../lib/cores.js';
import { haversine } from '../../lib/haversine.js';
import { addXp, XP_REWARDS } from '../../lib/xp.js';
import { getClanLevel, getClanDefenseForMine } from '../../lib/clans.js';
import { gridDisk, cellToLatLng } from 'h3-js';
import { gameState } from '../../lib/gameState.js';
import { io, connectedPlayers, lastAttackTime, logActivity } from '../../server.js';
import { logPlayer } from '../../lib/logger.js';

export const buildingsRouter = Router();

const WEAPON_COOLDOWNS = { sword: 500, axe: 700, none: 200 };

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
  const isCellFree = (cell) => {
    return ![...gameState.mines.values()].some(m => m.cell_id === cell && m.status !== 'destroyed') &&
           ![...gameState.headquarters.values()].some(h => h.cell_id === cell) &&
           ![...gameState.collectors.values()].some(c => c.cell_id === cell) &&
           ![...gameState.clanHqs.values()].some(c => c.cell_id === cell) &&
           ![...gameState.monuments.values()].some(m => m.cell_id === cell);
  };
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
  const bonusClaimed = player.starting_bonus_claimed === true;
  const startingCoins = bonusClaimed ? 0 : 100_000;
  const startingDiamonds = bonusClaimed ? 0 : 100;
  const { data: hq, error: insertError } = await supabase.from('headquarters').insert({ player_id: player.id, owner_username: player.username, lat: hqLat, lng: hqLng, cell_id }).select('id,player_id,lat,lng,cell_id,level,created_at').single();
  if (insertError) return res.status(500).json({ error: 'Failed to place headquarters' });
  if (!bonusClaimed) {
    const { data: bonusOk } = await supabase.from('players').update({ starting_bonus_claimed: true, coins: (player.coins ?? 0) + startingCoins, diamonds: (player.diamonds ?? 0) + startingDiamonds }).eq('id', player.id).eq('starting_bonus_claimed', false).select('id').maybeSingle();
    if (!bonusOk) return res.status(409).json({ error: 'Бонус уже получен' });
  }
  // Update gameState
  if (gameState.loaded) {
    gameState.upsertHq(hq);
    const p = gameState.getPlayerById(player.id);
    if (p) {
      if (!bonusClaimed) { p.coins = (player.coins ?? 0) + startingCoins; p.diamonds = (player.diamonds ?? 0) + startingDiamonds; p.starting_bonus_claimed = true; }
      gameState.markDirty('players', p.id);
    }
  }
  let xpResult = null;
  try { xpResult = await addXp(player.id, XP_REWARDS.BUILD_HQ); } catch (e) {}
  return res.status(201).json({ headquarters: hq, xp: xpResult, startingBonus: !bonusClaimed, player_coins: (player.coins ?? 0) + startingCoins, player_diamonds: (player.diamonds ?? 0) + startingDiamonds });
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
  }
  let xpResult = null;
  try { xpResult = await addXp(player.id, XP_REWARDS.UPGRADE_HQ); } catch (e) {}
  return res.status(200).json({ headquarters: updatedHq, player_coins: newBalance, xp: xpResult });
}

async function handleHqSell(player, res) {
  const { data: hqs, error: hqError } = await supabase.from('headquarters').select('id').eq('player_id', player.id);
  if (hqError) return res.status(500).json({ error: hqError.message });
  if (!hqs || hqs.length === 0) return res.status(404).json({ error: 'Headquarters not found' });
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
  return res.status(200).json({ success: true });
}

// ─── Mine handlers ───────────────────────────────────────────────────

async function handleMineBuild(req, res) {
  const { telegram_id } = req.body;
  const playerActualLat = parseFloat(req.body.player_lat ?? req.body.lat);
  const playerActualLng = parseFloat(req.body.player_lng ?? req.body.lng);
  const mineLat = parseFloat(req.body.mine_lat ?? req.body.lat);
  const mineLng = parseFloat(req.body.mine_lng ?? req.body.lng);
  if (!telegram_id || isNaN(mineLat) || isNaN(mineLng) || isNaN(playerActualLat) || isNaN(playerActualLng)) return res.status(400).json({ error: 'telegram_id, player position and mine position are required' });
  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id, 'id, level');
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const { data: hq, error: hqError } = await supabase.from('headquarters').select('id').eq('player_id', player.id).maybeSingle();
  if (hqError) return res.status(500).json({ error: hqError.message });
  if (!hq) return res.status(403).json({ error: 'You must place your headquarters first' });
  // Distance check uses tap coordinates (mineLat/mineLng), NOT cell center
  const distance = haversine(playerActualLat, playerActualLng, mineLat, mineLng);
  if (distance > SMALL_RADIUS) return res.status(400).json({ error: `Слишком далеко (${Math.round(distance)}м > ${SMALL_RADIUS}м)`, distance: Math.round(distance) });
  const targetCell = getCell(mineLat, mineLng);
  const [cellCenterLat, cellCenterLng] = getCellCenter(targetCell);
  // Check cell is free from ALL building types
  const cellOccupied =
    [...gameState.mines.values()].some(m => m.cell_id === targetCell && m.status !== 'destroyed') ||
    [...gameState.headquarters.values()].some(h => h.cell_id === targetCell) ||
    [...gameState.collectors.values()].some(c => c.cell_id === targetCell) ||
    [...gameState.clanHqs.values()].some(c => c.cell_id === targetCell) ||
    [...gameState.monuments.values()].some(m => m.cell_id === targetCell);
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
  try { xpResult = await addXp(player.id, XP_REWARDS.BUILD_MINE); } catch (e) {}
  return res.status(201).json({ mine, xp: xpResult });
}

async function handleMineCollect(req, res) {
  const { telegram_id, lat, lng } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });
  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id, 'id, coins, clan_id');
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const { data: allMines, error: minesError } = await supabase.from('mines').select('id, level, last_collected, cell_id, lat, lng, status').eq('owner_id', player.id);
  if (minesError) return res.status(500).json({ error: 'Failed to fetch mines' });
  if (!allMines || allMines.length === 0) return res.status(200).json({ collected: 0, player_coins: player.coins ?? 0 });
  if (lat == null || lng == null) return res.status(400).json({ error: 'Координаты игрока не переданы' });
  const pLat = parseFloat(lat), pLng = parseFloat(lng);
  const mines = allMines.filter(m => {
    if (m.status === 'burning' || m.status === 'destroyed') return false;
    const mLat = m.lat != null ? m.lat : getCellCenter(m.cell_id)[0];
    const mLng = m.lng != null ? m.lng : getCellCenter(m.cell_id)[1];
    return haversine(pLat, pLng, mLat, mLng) <= SMALL_RADIUS;
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
  let totalCoins = 0;
  for (const mine of mines) {
    const cores = gameState.loaded && mine.cell_id ? gameState.getCoresForMine(mine.cell_id) : [];
    const incBoost = cores.length > 0 ? getCoresTotalBoost(cores, 'income') : 1;
    const capBoost = cores.length > 0 ? getCoresTotalBoost(cores, 'capacity') : 1;
    let acc = calcAccumulatedCoins(mine.level, mine.last_collected, incBoost, capBoost);
    if (clanIncomeBonus > 0 && clanHqs.length > 0) {
      const mLat = mine.lat ?? getCellCenter(mine.cell_id)[0];
      const mLng = mine.lng ?? getCellCenter(mine.cell_id)[1];
      const inZone = clanHqs.some(h => haversine(mLat, mLng, h.lat, h.lng) <= h.radius);
      if (inZone) {
        acc = Math.round(acc * (1 + clanIncomeBonus / 100));
        if (clanBoostMul > 1) acc = Math.round(acc * clanBoostMul);
      }
    }
    totalCoins += acc;
  }
  const currentCoins = player.coins ?? 0;
  const newCoins = currentCoins + Math.round(totalCoins);
  const [{ data: coinsOk, error: playerUpdateError }, { error: minesUpdateError }] = await Promise.all([
    supabase.from('players').update({ coins: newCoins }).eq('id', player.id).eq('coins', currentCoins).select('id').maybeSingle(),
    supabase.from('mines').update({ last_collected: now }).in('id', mines.map(m => m.id)),
  ]);
  if (playerUpdateError || minesUpdateError) return res.status(500).json({ error: 'Failed to collect coins' });
  if (!coinsOk && !playerUpdateError) return res.status(409).json({ error: 'Конфликт — попробуйте снова' });
  // Update gameState
  if (gameState.loaded) {
    const p = gameState.getPlayerById(player.id);
    if (p) { p.coins = newCoins; gameState.markDirty('players', p.id); }
    for (const m of mines) {
      const gm = gameState.getMineById(m.id);
      if (gm) { gm.last_collected = now; gameState.markDirty('mines', m.id); }
    }
  }
  const collectedAmount = Math.round(totalCoins);
  if (collectedAmount > 0) logPlayer(telegram_id, 'action', `Собрал ${collectedAmount.toLocaleString('ru')} монет`, { amount: collectedAmount });
  // Per-mine XP: 1% of collected coins with 10% chance, for each mine separately
  const { getCollectXp } = await import('../../game/mechanics/xp.js');
  const xpEvents = [];
  let totalXpGained = 0;
  for (const mine of mines) {
    const cores = gameState.loaded && mine.cell_id ? gameState.getCoresForMine(mine.cell_id) : [];
    const incBoost = cores.length > 0 ? getCoresTotalBoost(cores, 'income') : 1;
    const capBoost = cores.length > 0 ? getCoresTotalBoost(cores, 'capacity') : 1;
    let mineCoins = calcAccumulatedCoins(mine.level, mine.last_collected, incBoost, capBoost);
    if (clanIncomeBonus > 0 && clanHqs.length > 0) {
      const mLat = mine.lat ?? getCellCenter(mine.cell_id)[0];
      const mLng = mine.lng ?? getCellCenter(mine.cell_id)[1];
      const inZone = clanHqs.some(h => haversine(mLat, mLng, h.lat, h.lng) <= h.radius);
      if (inZone) {
        mineCoins = Math.round(mineCoins * (1 + clanIncomeBonus / 100));
        if (clanBoostMul > 1) mineCoins = Math.round(mineCoins * clanBoostMul);
      }
    }
    const xp = getCollectXp(mineCoins);
    if (xp > 0) {
      totalXpGained += xp;
      xpEvents.push({ xp, lat: mine.lat, lng: mine.lng, cell_id: mine.cell_id });
    }
  }
  let xpResult = null;
  if (totalXpGained > 0) { try { xpResult = await addXp(player.id, totalXpGained); } catch (e) {} }
  const totalIncome = allMines.reduce((sum, m) => sum + getMineIncome(m.level), 0);
  return res.status(200).json({ collected: collectedAmount, total_accumulated: collectedAmount, player_coins: newCoins, xp: xpResult, xp_events: xpEvents, totalIncome });
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
  if (mine.level <= 0) return res.status(400).json({ error: 'Шахта неактивна' });
  const dist = haversine(lat, lng, mine.lat, mine.lng);
  if (dist > LARGE_RADIUS) return res.status(400).json({ error: 'Слишком далеко', distance: Math.round(dist) });
  const { data: existingAttack } = await supabase.from('mines').select('id').eq('attacker_id', player.id).eq('status', 'under_attack').maybeSingle();
  if (existingAttack) return res.status(400).json({ error: 'Вы уже атакуете другую шахту' });
  const { data: weapon } = await supabase.from('items').select('type,attack,crit_chance,emoji,rarity').eq('owner_id', player.id).eq('equipped', true).in('type', ['sword', 'axe']).maybeSingle();
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
  const atkMsg = `⚔️ Ваша шахта Ур.${mine.level} атакована игроком ${player.game_username || 'Неизвестный'}!`;
  await supabase.from('notifications').insert({ player_id: mine.owner_id, type: 'mine_attacked', message: atkMsg, data: { mine_id: mine.id } });
  const { data: owner } = await supabase.from('players').select('telegram_id').eq('id', mine.owner_id).maybeSingle();
  if (owner?.telegram_id) sendTelegramNotification(owner.telegram_id, atkMsg);
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
  const { data: weapon } = await supabase.from('items').select('type,attack,crit_chance').eq('owner_id', player.id).eq('equipped', true).in('type', ['sword', 'axe']).maybeSingle();
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
    await supabase.from('mines').update({ status: 'burning', hp: 0, burning_started_at: burnStarted, attacker_id: null, attack_started_at: null, attack_ends_at: null, last_hp_update: null }).eq('id', mine_id);
    // Update gameState
    if (gameState.loaded) {
      const gm = gameState.getMineById(mine_id);
      if (gm) { Object.assign(gm, { status: 'burning', hp: 0, burning_started_at: burnStarted, attacker_id: null, attack_started_at: null, attack_ends_at: null, last_hp_update: null }); gameState.markDirty('mines', mine_id); }
    }
    const burnMsg = `🔥 Ваша шахта Ур.${mine.level} горит! Потушите в течение 24 часов или она исчезнет.`;
    await supabase.from('notifications').insert({ player_id: mine.owner_id, type: 'mine_burning', message: burnMsg, data: { mine_id: mine.id } });
    const { data: burnOwner } = await supabase.from('players').select('telegram_id').eq('id', mine.owner_id).maybeSingle();
    if (burnOwner?.telegram_id) sendTelegramNotification(burnOwner.telegram_id, burnMsg);
    const xpGain = mine.level * 10;
    let xpResult = null;
    try { xpResult = await addXp(player.id, xpGain); } catch (_) {}
    return res.json({ success: true, result: 'burning', xpGain, xp: xpResult });
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
  return Math.floor(sum * 0.3);
}

async function handleAttackSellMine(req, res) {
  const { telegram_id, mine_id } = req.body;
  if (!telegram_id || !mine_id) return res.status(400).json({ error: 'telegram_id and mine_id are required' });
  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id, 'id, coins');
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const { data: mine, error: mineError } = await supabase.from('mines').select('id,owner_id,level,cell_id,last_collected,lat,lng').eq('id', mine_id).maybeSingle();
  if (mineError) return res.status(500).json({ error: mineError.message });
  if (!mine) return res.status(404).json({ error: 'Mine not found' });
  if (mine.owner_id !== player.id) return res.status(403).json({ error: 'You do not own this mine' });
  const sellCores = gameState.loaded && mine.cell_id ? gameState.getCoresForMine(mine.cell_id) : [];
  const sellIncBoost = sellCores.length > 0 ? getCoresTotalBoost(sellCores, 'income') : 1;
  const sellCapBoost = sellCores.length > 0 ? getCoresTotalBoost(sellCores, 'capacity') : 1;
  const collected = calcAccumulatedCoins(mine.level, mine.last_collected, sellIncBoost, sellCapBoost);
  const refund = calcSellRefund(mine.level);
  const total = collected + refund;
  const newCoins = (player.coins ?? 0) + Math.round(total);
  const [{ data: coinsOk, error: playerUpdateError }, { error: deleteError }] = await Promise.all([
    supabase.from('players').update({ coins: newCoins }).eq('id', player.id).eq('coins', player.coins ?? 0).select('id').maybeSingle(),
    supabase.from('mines').delete().eq('id', mine_id),
  ]);
  if (playerUpdateError || deleteError) return res.status(500).json({ error: 'Failed to sell mine' });
  if (!coinsOk && !playerUpdateError) return res.status(409).json({ error: 'Конфликт — попробуйте снова' });
  // Update gameState
  if (gameState.loaded) {
    gameState.removeMine(mine_id);
    const p = gameState.getPlayerById(player.id);
    if (p) { p.coins = newCoins; gameState.markDirty('players', p.id); }
  }
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
    let xpResult = null;
    try { xpResult = await addXp(player.id, XP_REWARDS.UPGRADE_MINE(mine.pending_level)); } catch (e) {}
    completed.push({ ...updated, xp: xpResult });
  }
  return res.json({ completed });
}

async function handleUpgradePost(req, res) {
  const { telegram_id, mine_id, lat, lng, targetLevel: targetLevelParam } = req.body;
  if (!telegram_id || !mine_id) return res.status(400).json({ error: 'telegram_id and mine_id are required' });
  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id, 'id, level, coins, last_lat, last_lng');
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const { data: mine, error: mineError } = await supabase.from('mines').select('id,owner_id,level,cell_id,lat,lng,pending_level,upgrade_finish_at').eq('id', mine_id).maybeSingle();
  if (mineError) return res.status(500).json({ error: mineError.message });
  if (!mine) return res.status(404).json({ error: 'Mine not found' });
  if (mine.owner_id !== player.id) return res.status(403).json({ error: 'You do not own this mine' });
  if (mine.upgrade_finish_at && new Date(mine.upgrade_finish_at) > new Date()) {
    const secondsLeft = Math.ceil((new Date(mine.upgrade_finish_at) - new Date()) / 1000);
    return res.status(400).json({ error: `Апгрейд ещё идёт (${secondsLeft} сек)` });
  }
  if (lat == null || lng == null) return res.status(400).json({ error: 'Координаты игрока не переданы' });
  const pLat = parseFloat(lat); const pLng = parseFloat(lng);
  if (isNaN(pLat) || isNaN(pLng)) return res.status(400).json({ error: 'Некорректные координаты' });
  const distance = haversine(pLat, pLng, mine.lat, mine.lng);
  if (distance > SMALL_RADIUS) return res.status(400).json({ error: `Слишком далеко! Подойди ближе (200м)`, distance: Math.round(distance) });
  if (mine.level >= MINE_MAX_LEVEL) return res.status(400).json({ error: 'Mine is already at max level' });
  const targetLevel = Math.min(parseInt(targetLevelParam) || mine.level + 1, MINE_MAX_LEVEL);
  if (targetLevel <= mine.level) return res.status(400).json({ error: 'targetLevel должен быть выше текущего уровня' });
  let cost = 0;
  for (let l = mine.level; l < targetLevel; l++) cost += mineUpgradeCost(l);
  const balance = player.coins ?? 0;
  if (balance < cost) return res.status(400).json({ error: `Не хватает монет (нужно ${Math.round(cost).toLocaleString()})` });
  const newBalance = balance - cost;
  const finishAt = new Date(Date.now() + 20000);
  const [{ data: coinsOk, error: playerUpdateError }, { error: mineUpdateError }] = await Promise.all([
    supabase.from('players').update({ coins: newBalance }).eq('id', player.id).eq('coins', balance).select('id').maybeSingle(),
    supabase.from('mines').update({ pending_level: targetLevel, upgrade_finish_at: finishAt.toISOString() }).eq('id', mine_id),
  ]);
  if (playerUpdateError || mineUpdateError) return res.status(500).json({ error: 'Failed to start upgrade' });
  if (!coinsOk && !playerUpdateError) return res.status(409).json({ error: 'Конфликт — попробуйте снова' });
  // Update gameState
  if (gameState.loaded) {
    const gm = gameState.getMineById(mine_id);
    if (gm) { gm.pending_level = targetLevel; gm.upgrade_finish_at = finishAt.toISOString(); gameState.markDirty('mines', mine_id); }
    const p = gameState.getPlayerById(player.id);
    if (p) { p.coins = newBalance; gameState.markDirty('players', p.id); }
  }
  logPlayer(telegram_id, 'action', `Улучшил шахту до уровня ${targetLevel}`, { mine_id, cost });
  return res.status(200).json({ upgrading: true, finishAt: finishAt.toISOString(), secondsLeft: 20, player_coins: newBalance, pendingLevel: targetLevel });
}

// ─── Single-hit mine attack (projectile) ─────────────────────────────

async function handleMineHit(req, res) {
  const { telegram_id, mine_id, lat, lng } = req.body || {};
  if (!telegram_id || !mine_id || lat == null || lng == null)
    return res.status(400).json({ error: 'Missing required fields: telegram_id, mine_id, lat, lng' });

  // Look up player in gameState
  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  // Get equipped weapon from gameState
  const playerItems = gameState.getPlayerItems(player.id);
  const weapon = playerItems.find(i => (i.type === 'sword' || i.type === 'axe') && i.equipped);

  // Rate limit by weapon cooldown
  const weaponType = weapon ? weapon.type : 'none';
  const cooldownMs = WEAPON_COOLDOWNS[weaponType] ?? 0;
  const now = Date.now();
  const lastTime = lastAttackTime.get(String(telegram_id)) || 0;
  if (now - lastTime < cooldownMs)
    return res.status(429).json({ error: 'Cooldown', retry_after: cooldownMs - (now - lastTime) });
  lastAttackTime.set(String(telegram_id), now);

  // Look up mine in gameState
  const mine = gameState.getMineById(mine_id);
  if (!mine) return res.status(404).json({ error: 'Mine not found' });
  if (mine.owner_id === player.id) return res.status(400).json({ error: 'Нельзя атаковать свою шахту' });
  if (mine.status !== 'normal' && mine.status !== 'under_attack')
    return res.status(400).json({ error: 'Шахта недоступна для атаки' });
  if (mine.level <= 0) return res.status(400).json({ error: 'Шахта неактивна' });

  // Distance check
  const pLat = parseFloat(lat), pLng = parseFloat(lng);
  const dist = haversine(pLat, pLng, mine.lat, mine.lng);
  if (dist > LARGE_RADIUS) return res.status(400).json({ error: 'Слишком далеко', distance: Math.round(dist) });

  // Calculate damage
  const baseDmg = 10 + (weapon?.attack || 0);
  const multiplier = 0.8 + Math.random() * 0.4;
  let damage = Math.round(baseDmg * multiplier);
  let isCrit = false;
  let isExecution = false;

  // Sword crit with multiplier
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

  // Apply clan defense bonus to mine HP
  const clanDef = getClanDefenseForMine(mine.owner_id, mine.lat, mine.lng);
  let computedMaxHp = Math.round(getMineHp(mine.level) * coreHpBoost * clanDef);

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

  if (currentHp <= 0) {
    // Mine is burning
    burned = true;
    mine.status = 'burning';
    mine.hp = 0;
    mine.max_hp = computedMaxHp;
    mine.burning_started_at = hpUpdateTime;
    mine.attacker_id = null;
    mine.attack_started_at = null;
    mine.attack_ends_at = null;
    mine.last_hp_update = null;
    gameState.markDirty('mines', mine_id);

    // Write to DB immediately
    await supabase.from('mines').update({
      status: 'burning', hp: 0, max_hp: computedMaxHp,
      burning_started_at: hpUpdateTime, attacker_id: null,
      attack_started_at: null, attack_ends_at: null, last_hp_update: null,
    }).eq('id', mine_id);

    // Notify owner
    const burnMsg = `🔥 Ваша шахта Ур.${mine.level} горит! Потушите в течение 24 часов или она исчезнет.`;
    supabase.from('notifications').insert({
      player_id: mine.owner_id, type: 'mine_burning', message: burnMsg,
      data: { mine_id: mine.id },
    }).then(() => {}).catch(() => {});

    const owner = gameState.getPlayerById(mine.owner_id);
    if (owner?.telegram_id) sendTelegramNotification(owner.telegram_id, burnMsg);

    // XP for destroying mine
    const xpGain = mine.level * 10;
    try { await addXp(player.id, xpGain); } catch (_) {}
  } else {
    // Update mine HP in gameState
    if (mine.status === 'normal') {
      mine.status = 'under_attack';
      mine.attacker_id = player.id;

      // Notify owner on first hit
      const atkMsg = `⚔️ Ваша шахта Ур.${mine.level} атакована игроком ${player.game_username || 'Неизвестный'}!`;
      supabase.from('notifications').insert({
        player_id: mine.owner_id, type: 'mine_attacked', message: atkMsg,
        data: { mine_id: mine.id },
      }).then(() => {}).catch(() => {});

      const owner = gameState.getPlayerById(mine.owner_id);
      if (owner?.telegram_id) sendTelegramNotification(owner.telegram_id, atkMsg);
    }
    mine.hp = currentHp;
    mine.max_hp = computedMaxHp;
    mine.last_hp_update = hpUpdateTime;
    gameState.markDirty('mines', mine_id);
  }

  // Emit projectile to nearby sockets (1km)
  emitToNearbyPlayers(pLat, pLng, 1000, 'projectile', {
    from_lat: pLat, from_lng: pLng,
    to_lat: mine.lat, to_lng: mine.lng,
    damage, crit: isCrit, execution: isExecution,
    target_type: 'mine',
    target_id: mine_id,
    attacker_id: player.telegram_id,
    weapon_type: weaponType === 'none' ? 'fist' : weaponType,
  });

  // Emit mine HP update to nearby sockets
  emitToNearbyPlayers(mine.lat, mine.lng, 1000, 'mine:hp_update', {
    mine_id, cell_id: mine.cell_id,
    hp: burned ? 0 : currentHp, max_hp: computedMaxHp,
    status: mine.status,
  });

  return res.json({
    success: true, damage, crit: isCrit,
    mine_hp: burned ? 0 : currentHp, mine_max_hp: computedMaxHp,
    status: mine.status, burned,
  });
}

// ─── Route definitions ───────────────────────────────────────────────

buildingsRouter.post('/headquarters', async (req, res) => {
  const { telegram_id, action } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });
  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id, 'id, username, starting_bonus_claimed, coins, diamonds');
  if (playerError) return res.status(500).json({ error: playerError?.message || 'DB error' });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (action === 'upgrade') return handleHqUpgrade(player, res);
  if (action === 'sell') return handleHqSell(player, res);
  return handleHqPlace(player, req.body, res);
});

buildingsRouter.post('/mine', async (req, res) => {
  const { action } = req.body || {};
  if (action === 'collect') return handleMineCollect(req, res);
  return handleMineBuild(req, res);
});

buildingsRouter.post('/attack', async (req, res) => {
  const { action } = req.body || {};
  if (action === 'hit') return handleMineHit(req, res);
  if (action === 'finish') return handleAttackFinish(req, res);
  if (action === 'extinguish') return handleAttackExtinguish(req, res);
  if (action === 'sell') return handleAttackSellMine(req, res);
  return handleAttackStart(req, res);
});

buildingsRouter.get('/upgrade', handleUpgradeGet);
buildingsRouter.post('/upgrade', handleUpgradePost);
