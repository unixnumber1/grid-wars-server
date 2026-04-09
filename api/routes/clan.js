import { Router } from 'express';
import { supabase, getPlayerByTelegramId, parseTgId, sendTelegramNotification } from '../../lib/supabase.js';
import { getClanLevel, CLAN_LEVELS, CLAN_HQ_COST, CLAN_LEAVE_COOLDOWN, ALLOWED_CLAN_COLORS } from '../../lib/clans.js';
import { logPlayer } from '../../lib/logger.js';
import { getCellId } from '../../lib/grid.js';
import { cellToLatLng } from 'h3-js';
import { gameState } from '../../lib/gameState.js';
import { logActivity } from '../../server.js';
import { ts, getLang } from '../../config/i18n.js';
import { withPlayerLock } from '../../lib/playerLock.js';
import { awardClanDonationTickets } from '../../game/mechanics/contest.js';

export const clanRouter = Router();

// ── BUILD HQ ────────────────────────────────────────────────
async function handleBuildHq(req, res) {
  const { telegram_id, lat, lng } = req.body;
  if (!telegram_id || lat == null || lng == null) {
    return res.status(400).json({ error: 'telegram_id, lat, lng required' });
  }

  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, coins, clan_id');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  // Check DB for existing HQ
  const { data: existingHq } = await supabase
    .from('clan_headquarters').select('id').eq('player_id', player.id).maybeSingle();
  const lang = getLang(gameState, telegram_id);
  if (existingHq) return res.status(409).json({ error: ts(lang, 'err.clan_hq_exists') });
  // Also clear stale gameState entry if DB has no HQ
  if (gameState.loaded) {
    const gsHq = gameState.getClanHqByPlayerId(player.id);
    if (gsHq && !existingHq) {
      gameState.clanHqs.delete(gsHq.id);
    }
  }

  const balance = player.coins ?? 0;
  if (balance < CLAN_HQ_COST) {
    return res.status(400).json({ error: ts(lang, 'err.need_coins', { cost: CLAN_HQ_COST.toLocaleString() }) });
  }

  // Use tap coordinates for clan HQ placement
  const tapLat = parseFloat(lat), tapLng = parseFloat(lng);
  const cell_id = getCellId(tapLat, tapLng);

  const cellOccupied =
    [...gameState.mines.values()].some(m => m.cell_id === cell_id && m.status !== 'destroyed') ||
    [...gameState.headquarters.values()].some(h => h.cell_id === cell_id) ||
    [...gameState.collectors.values()].some(c => c.cell_id === cell_id) ||
    [...gameState.clanHqs.values()].some(c => c.cell_id === cell_id) ||
    [...gameState.monuments.values()].some(m => m.cell_id === cell_id) ||
    [...gameState.fireTrucks.values()].some(ft => ft.cell_id === cell_id && ft.status !== 'destroyed');
  if (cellOccupied) {
    return res.status(409).json({ error: ts(lang, 'err.cell_occupied') });
  }

  const newBalance = balance - CLAN_HQ_COST;

  // First deduct coins (optimistic lock)
  const { data: coinsOk } = await supabase.from('players').update({ coins: newBalance }).eq('id', player.id).eq('coins', balance).select('id').maybeSingle();
  if (!coinsOk) return res.status(409).json({ error: ts(lang, 'err.conflict') });

  // clan_id is nullable — HQ can exist without a clan (inactive state)
  const clanIdForHq = player.clan_id || null;
  const insertData = { player_id: player.id, lat: tapLat, lng: tapLng, cell_id, clan_id: clanIdForHq };
  const { data: hq, error: insertErr } = await supabase.from('clan_headquarters').insert(insertData).select().single();

  if (insertErr) {
    // Refund coins on failure
    await supabase.from('players').update({ coins: balance }).eq('id', player.id);
    if (gameState.loaded) {
      const p = gameState.getPlayerById(player.id);
      if (p) { p.coins = balance; gameState.markDirty('players', p.id); }
    }
    return res.status(500).json({ error: ts(lang, 'err.failed_place_hq', { details: insertErr.message || '' }) });
  }

  // Update gameState
  if (gameState.loaded) {
    gameState.upsertClanHq(hq);
    const p = gameState.getPlayerById(player.id);
    if (p) { p.coins = newBalance; gameState.markDirty('players', p.id); }
  }

  return res.status(201).json({ success: true, hq, player_coins: newBalance });
}

// ── CREATE CLAN ─────────────────────────────────────────────
async function handleCreate(req, res) {
  const { telegram_id, name, symbol, color, description, min_level, join_policy } = req.body;
  if (!telegram_id || !name || !symbol || !color) {
    return res.status(400).json({ error: 'telegram_id, name, symbol, color required' });
  }

  const lang = getLang(gameState, telegram_id);
  const trimName = name.trim();
  if (trimName.length < 3 || trimName.length > 20) return res.status(400).json({ error: ts(lang, 'err.clan_name_length') });
  if (!/^[a-zA-Zа-яА-ЯёЁ0-9_ ]+$/.test(trimName)) return res.status(400).json({ error: 'Только буквы, цифры, пробелы и _' });
  if (symbol.length > 4) return res.status(400).json({ error: ts(lang, 'err.clan_symbol_length') });
  if (!ALLOWED_CLAN_COLORS.includes(color)) return res.status(400).json({ error: ts(lang, 'err.clan_color_invalid') });

  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, clan_id');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  // Check if player already in a real clan
  if (player.clan_id) {
    return res.status(400).json({ error: ts(lang, 'err.already_in_clan') });
  }

  const { data: clanHq } = await supabase.from('clan_headquarters').select('id, clan_id').eq('player_id', player.id).maybeSingle();
  if (!clanHq) return res.status(400).json({ error: ts(lang, 'err.build_clan_hq_first') });

  const { data: dup } = await supabase.from('clans').select('id').eq('name', trimName).maybeSingle();
  if (dup) return res.status(409).json({ error: ts(lang, 'err.clan_name_taken') });

  // Create new clan + link HQ
  const validPolicy = ['open','closed','request'].includes(join_policy) ? join_policy : 'open';
  const { data: clan, error: clanErr } = await supabase.from('clans').insert({
    name: trimName, symbol, color,
    description: (description || '').slice(0, 100),
    min_level: Math.max(1, parseInt(min_level) || 1),
    leader_id: player.id,
    join_policy: validPolicy,
  }).select().single();
  if (clanErr) return res.status(500).json({ error: clanErr.message });
  await supabase.from('clan_headquarters').update({ clan_id: clan.id }).eq('player_id', player.id);

  // Link player to clan + create membership
  const [{ data: memberRow }] = await Promise.all([
    supabase.from('clan_members').insert({ clan_id: clan.id, player_id: player.id, role: 'leader' }).select().single(),
    supabase.from('players').update({ clan_id: clan.id, clan_role: 'leader' }).eq('id', player.id),
  ]);

  // Update gameState
  if (gameState.loaded) {
    gameState.upsertClan(clan);
    if (memberRow) gameState.upsertClanMember(memberRow);
    const p = gameState.getPlayerById(player.id);
    if (p) { p.clan_id = clan.id; p.clan_role = 'leader'; gameState.markDirty('players', p.id); }
    const ch = gameState.getClanHqByPlayerId(player.id);
    if (ch) { ch.clan_id = clan.id; gameState.markDirty('clanHqs', ch.id); }
  }

  const pName = gameState.loaded ? gameState.getPlayerById(player.id)?.game_username : null;
  logActivity(pName || 'player', `создал клан ${clan.name}`);
  logPlayer(telegram_id, 'action', `Создал клан "${clan.name}"`);

  return res.status(201).json({ success: true, clan });
}

// ── LIST CLANS ──────────────────────────────────────────────
async function handleList(req, res) {
  const { telegram_id } = req.query;
  let playerLevel = 0, playerClanId = null, playerHasClanHq = false, playerId = null;

  if (telegram_id) {
    const { player } = await getPlayerByTelegramId(telegram_id, 'id, level, clan_id');
    if (player) {
      playerId = player.id;
      playerLevel = player.level ?? 1;
      playerClanId = player.clan_id;
      const { data: cHq } = await supabase.from('clan_headquarters').select('id').eq('player_id', player.id).maybeSingle();
      playerHasClanHq = !!cHq;
    }
  }

  const { data: rawClansAll, error: qErr } = await supabase
    .from('clans').select('id, name, symbol, color, description, min_level, level, treasury, leader_id, join_policy')
    .order('level', { ascending: false }).limit(100);
  // Filter out placeholder clans
  const rawClans = (rawClansAll || []).filter(c => !c.name.startsWith('_placeholder_'));
  if (qErr) return res.status(500).json({ error: qErr.message });

  const clanIds = (rawClans || []).map(c => c.id);
  const [{ data: members }, { data: leaders }, { data: myRequests }] = await Promise.all([
    clanIds.length > 0
      ? supabase.from('clan_members').select('clan_id').in('clan_id', clanIds).is('left_at', null)
      : { data: [] },
    (() => {
      const leaderIds = [...new Set((rawClans || []).map(c => c.leader_id).filter(Boolean))];
      return leaderIds.length > 0
        ? supabase.from('players').select('id, game_username, username').in('id', leaderIds)
        : { data: [] };
    })(),
    playerId
      ? supabase.from('clan_requests').select('id, clan_id').eq('player_id', playerId).eq('status', 'pending')
      : { data: [] },
  ]);

  const countMap = {};
  for (const m of (members || [])) countMap[m.clan_id] = (countMap[m.clan_id] || 0) + 1;
  const leaderMap = {};
  for (const l of (leaders || [])) leaderMap[l.id] = l.game_username || l.username || '???';
  const myRequestMap = {};
  for (const r of (myRequests || [])) myRequestMap[r.clan_id] = r.id;

  const clans = (rawClans || []).map(c => {
    const config = getClanLevel(c.level);
    const mc = countMap[c.id] || 0;
    const policy = c.join_policy || 'open';
    const meetsReqs = !playerClanId && playerLevel >= (c.min_level || 1) && mc < config.maxMembers && playerHasClanHq;
    const myReqId = myRequestMap[c.id] || null;
    return {
      ...c, member_count: mc, leader_name: leaderMap[c.leader_id] || '???',
      max_members: config.maxMembers, income_bonus: config.income, defense_bonus: config.defense, radius: config.radius,
      join_policy: policy,
      can_join: meetsReqs && policy === 'open',
      can_apply: meetsReqs && policy === 'request' && !myReqId,
      my_request_id: myReqId,
    };
  });

  return res.json({ clans });
}

// ── JOIN CLAN ───────────────────────────────────────────────
async function handleJoin(req, res) {
  const { telegram_id, clan_id } = req.body;
  if (!telegram_id || !clan_id) return res.status(400).json({ error: 'telegram_id, clan_id required' });

  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, level, clan_id, clan_left_at, game_username, username');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const lang = getLang(gameState, telegram_id);
  if (player.clan_id) return res.status(400).json({ error: ts(lang, 'err.already_in_clan') });

  // No join cooldown

  const { data: clanHq } = await supabase.from('clan_headquarters').select('id').eq('player_id', player.id).maybeSingle();
  if (!clanHq) return res.status(400).json({ error: ts(lang, 'err.build_clan_hq_first') });

  const { data: clan } = await supabase.from('clans').select('id, name, level, min_level, leader_id, join_policy').eq('id', clan_id).single();
  if (!clan) return res.status(404).json({ error: ts(lang, 'err.clan_not_found') });
  if ((player.level ?? 1) < (clan.min_level || 1)) return res.status(400).json({ error: ts(lang, 'err.clan_min_level', { level: clan.min_level }) });
  const policy = clan.join_policy || 'open';
  if (policy === 'closed') return res.status(400).json({ error: 'Клан закрыт для вступления' });
  if (policy === 'request') return res.status(400).json({ error: 'Используйте заявку для вступления' });

  const config = getClanLevel(clan.level);
  const { count } = await supabase.from('clan_members').select('*', { count: 'exact', head: true }).eq('clan_id', clan_id).is('left_at', null);
  if ((count || 0) >= config.maxMembers) return res.status(400).json({ error: ts(lang, 'err.clan_full') });

  const [{ data: memberRow }] = await Promise.all([
    supabase.from('clan_members').insert({ clan_id, player_id: player.id, role: 'member' }).select().single(),
    supabase.from('players').update({ clan_id, clan_role: 'member' }).eq('id', player.id),
    supabase.from('clan_headquarters').update({ clan_id }).eq('player_id', player.id),
  ]);

  // Update gameState
  if (gameState.loaded) {
    if (memberRow) gameState.upsertClanMember(memberRow);
    const p = gameState.getPlayerById(player.id);
    if (p) { p.clan_id = clan_id; p.clan_role = 'member'; gameState.markDirty('players', p.id); }
    const ch = gameState.getClanHqByPlayerId(player.id);
    if (ch) { ch.clan_id = clan_id; gameState.markDirty('clanHqs', ch.id); }
  }

  // Notifications
  const pName = player.game_username || player.username || 'Player';
  const { data: leader } = await supabase.from('players').select('telegram_id').eq('id', clan.leader_id).single();
  if (leader?.telegram_id) {
    const leaderLang = getLang(gameState, leader.telegram_id);
    sendTelegramNotification(leader.telegram_id, ts(leaderLang, 'notif.clan_join_leader', { name: pName, clan: clan.name }));
  }

  const { data: mems } = await supabase.from('clan_members').select('player_id').eq('clan_id', clan_id).is('left_at', null);
  if (mems?.length) {
    const nowISO_j = new Date().toISOString();
    const notifs = mems.filter(m => m.player_id !== player.id).map(m => {
      const mLang = gameState.getPlayerById(m.player_id)?.language || 'en';
      return { id: globalThis.crypto.randomUUID(), player_id: m.player_id, type: 'clan_join', message: ts(mLang, 'notif.clan_join', { name: pName }), read: false, created_at: nowISO_j };
    });
    if (notifs.length) {
      for (const n of notifs) gameState.addNotification(n);
      supabase.from('notifications').insert(notifs).then(() => {}).catch(e => console.error('[clan] DB error:', e.message));
    }
  }

  return res.json({ success: true });
}

// ── LEAVE CLAN ──────────────────────────────────────────────
async function handleLeave(req, res) {
  const { telegram_id } = req.body;
  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, clan_role');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const lang = getLang(gameState, telegram_id);
  if (!player.clan_id) return res.status(400).json({ error: ts(lang, 'err.not_in_clan') });
  if (player.clan_role === 'leader') return res.status(400).json({ error: ts(lang, 'err.leader_cant_leave') });

  const nowISO = new Date().toISOString();
  const leavingClanId = player.clan_id;
  // Sequential to prevent orphaned state if one operation fails
  await supabase.from('clan_members').update({ left_at: nowISO }).eq('player_id', player.id).eq('clan_id', leavingClanId).is('left_at', null);
  await supabase.from('players').update({ clan_id: null, clan_role: null, clan_left_at: nowISO }).eq('id', player.id);
  await supabase.from('clan_headquarters').update({ clan_id: null }).eq('player_id', player.id);

  // Update gameState
  if (gameState.loaded) {
    const p = gameState.getPlayerById(player.id);
    if (p) { p.clan_id = null; p.clan_role = null; p.clan_left_at = nowISO; gameState.markDirty('players', p.id); }
    const ch = gameState.getClanHqByPlayerId(player.id);
    if (ch) { ch.clan_id = null; gameState.markDirty('clanHqs', ch.id); }
    // Mark clan member as left
    for (const m of gameState.clanMembers.values()) {
      if (m.player_id === player.id && m.clan_id === leavingClanId && !m.left_at) {
        m.left_at = nowISO; gameState.markDirty('clanMembers', m.id); break;
      }
    }
  }

  return res.json({ success: true });
}

// ── DONATE ──────────────────────────────────────────────────
async function handleDonate(req, res) {
  const { telegram_id, amount } = req.body;
  const donateAmount = parseInt(amount);
  if (isNaN(donateAmount) || donateAmount <= 0) return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.invalid_amount') });

  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, diamonds, game_username, username');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const lang = getLang(gameState, telegram_id);
  if (!player.clan_id) return res.status(400).json({ error: ts(lang, 'err.not_in_clan') });

  const currentDiamonds = player.diamonds ?? 0;
  if (currentDiamonds < donateAmount) return res.status(400).json({ error: ts(lang, 'err.not_enough_diamonds_short') });

  const { data: clan } = await supabase.from('clans').select('id, treasury').eq('id', player.clan_id).single();
  if (!clan) return res.status(500).json({ error: ts(lang, 'err.clan_not_found') });

  const newDiamonds = currentDiamonds - donateAmount;
  const newTreasury = (clan.treasury ?? 0) + donateAmount;

  const [{ data: dOk }, { error: tErr }] = await Promise.all([
    supabase.from('players').update({ diamonds: newDiamonds }).eq('id', player.id).eq('diamonds', currentDiamonds).select('id').maybeSingle(),
    supabase.from('clans').update({ treasury: newTreasury }).eq('id', clan.id),
  ]);
  if (!dOk) return res.status(409).json({ error: ts(lang, 'err.conflict') });
  if (tErr) return res.status(500).json({ error: tErr.message });

  // Update gameState
  if (gameState.loaded) {
    const p = gameState.getPlayerById(player.id);
    if (p) { p.diamonds = newDiamonds; gameState.markDirty('players', p.id); }
    const c = gameState.getClanById(clan.id);
    if (c) { c.treasury = newTreasury; gameState.markDirty('clans', c.id); }
  }

  // Increment monthly donation counter
  const { data: cmRow } = await supabase.from('clan_members').select('donated_month').eq('player_id', player.id).eq('clan_id', player.clan_id).is('left_at', null).maybeSingle();
  await supabase.from('clan_members').update({ donated_month: (cmRow?.donated_month || 0) + donateAmount }).eq('player_id', player.id).eq('clan_id', player.clan_id).is('left_at', null);

  const dName = player.game_username || player.username || 'Player';
  const { data: mems } = await supabase.from('clan_members').select('player_id').eq('clan_id', player.clan_id).is('left_at', null);
  if (mems?.length) {
    const nowISO = new Date().toISOString();
    const notifs = mems.filter(m => m.player_id !== player.id).map(m => {
      const mLang = gameState.getPlayerById(m.player_id)?.language || 'en';
      return { id: globalThis.crypto.randomUUID(), player_id: m.player_id, type: 'clan_donate', message: ts(mLang, 'notif.clan_donate', { name: dName, amount: donateAmount }), read: false, created_at: nowISO };
    });
    if (notifs.length) {
      for (const n of notifs) gameState.addNotification(n);
      supabase.from('notifications').insert(notifs).then(() => {}).catch(e => console.error('[clan] DB error:', e.message));
    }
  }

  // Contest: cumulative tickets for clan donations (every N gems = 1 ticket)
  awardClanDonationTickets(telegram_id, donateAmount, player.clan_id).catch(() => {});

  return res.json({ success: true, treasury: newTreasury, player_diamonds: newDiamonds });
}

// ── UPGRADE CLAN ────────────────────────────────────────────
async function handleUpgrade(req, res) {
  const { telegram_id } = req.body;
  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, clan_role');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const lang = getLang(gameState, telegram_id);
  if (!player.clan_id) return res.status(400).json({ error: ts(lang, 'err.not_in_clan') });
  if (player.clan_role !== 'leader' && player.clan_role !== 'officer') return res.status(403).json({ error: ts(lang, 'err.leader_or_officer') });

  const { data: clan } = await supabase.from('clans').select('id, level, treasury').eq('id', player.clan_id).single();
  if (!clan) return res.status(500).json({ error: ts(lang, 'err.clan_not_found') });
  if (clan.level >= 10) return res.status(400).json({ error: ts(lang, 'err.max_clan_level') });

  const nextConfig = getClanLevel(clan.level + 1);
  if ((clan.treasury ?? 0) < nextConfig.cost) return res.status(400).json({ error: ts(lang, 'err.need_treasury', { cost: nextConfig.cost }) });

  const newTreasury = (clan.treasury ?? 0) - nextConfig.cost;
  const newLevel = clan.level + 1;
  await supabase.from('clans').update({ level: newLevel, treasury: newTreasury }).eq('id', clan.id);

  // Update gameState
  if (gameState.loaded) {
    const c = gameState.getClanById(clan.id);
    if (c) { c.level = newLevel; c.treasury = newTreasury; gameState.markDirty('clans', c.id); }
  }

  const { data: mems } = await supabase.from('clan_members').select('player_id').eq('clan_id', clan.id).is('left_at', null);
  if (mems?.length) {
    const nowISO_u = new Date().toISOString();
    const notifs = mems.map(m => {
      const mLang = gameState.getPlayerById(m.player_id)?.language || 'en';
      return { id: globalThis.crypto.randomUUID(), player_id: m.player_id, type: 'clan_upgrade', message: ts(mLang, 'notif.clan_upgrade', { level: newLevel }), read: false, created_at: nowISO_u };
    });
    for (const n of notifs) gameState.addNotification(n);
    supabase.from('notifications').insert(notifs).then(() => {}).catch(e => console.error('[clan] DB error:', e.message));
  }

  return res.json({ success: true, clan: { ...clan, level: newLevel, treasury: newTreasury }, config: nextConfig });
}

// ── SET ROLE ────────────────────────────────────────────────
async function handleSetRole(req, res) {
  const { telegram_id, target_telegram_id, role } = req.body;
  if (!['officer', 'member'].includes(role)) return res.status(400).json({ error: 'role: officer | member' });

  const { player } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, clan_role');
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (player.clan_role !== 'leader') return res.status(403).json({ error: ts(getLang(gameState, telegram_id), 'err.leader_only') });

  const tgtTgId = parseTgId(target_telegram_id);
  const { data: target } = await supabase.from('players').select('id, clan_id').eq('telegram_id', tgtTgId).maybeSingle();
  if (!target || target.clan_id !== player.clan_id) return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.player_not_in_clan') });

  await Promise.all([
    supabase.from('clan_members').update({ role }).eq('player_id', target.id).eq('clan_id', player.clan_id).is('left_at', null),
    supabase.from('players').update({ clan_role: role }).eq('id', target.id),
  ]);

  // Update gameState
  if (gameState.loaded) {
    const tp = gameState.getPlayerById(target.id);
    if (tp) { tp.clan_role = role; gameState.markDirty('players', tp.id); }
    for (const m of gameState.clanMembers.values()) {
      if (m.player_id === target.id && m.clan_id === player.clan_id && !m.left_at) {
        m.role = role; gameState.markDirty('clanMembers', m.id); break;
      }
    }
  }

  return res.json({ success: true });
}

// ── KICK ────────────────────────────────────────────────────
async function handleKick(req, res) {
  const { telegram_id, target_telegram_id } = req.body;
  const { player } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, clan_role');
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const lang = getLang(gameState, telegram_id);
  if (!['leader', 'officer'].includes(player.clan_role)) return res.status(403).json({ error: ts(lang, 'err.insufficient_rights') });

  const tgtTgId = parseTgId(target_telegram_id);
  const { data: target } = await supabase.from('players').select('id, clan_id, clan_role').eq('telegram_id', tgtTgId).maybeSingle();
  if (!target || target.clan_id !== player.clan_id) return res.status(400).json({ error: ts(lang, 'err.player_not_in_clan') });
  if (target.clan_role === 'leader') return res.status(403).json({ error: ts(lang, 'err.cant_kick_leader') });
  if (player.clan_role === 'officer' && target.clan_role === 'officer') return res.status(403).json({ error: ts(lang, 'err.officer_cant_kick_officer') });

  const nowISO = new Date().toISOString();
  const kickedClanId = player.clan_id;
  // Sequential to prevent orphaned state if one operation fails
  await supabase.from('clan_members').update({ left_at: nowISO }).eq('player_id', target.id).eq('clan_id', kickedClanId).is('left_at', null);
  await supabase.from('players').update({ clan_id: null, clan_role: null, clan_left_at: nowISO }).eq('id', target.id);
  await supabase.from('clan_headquarters').update({ clan_id: null }).eq('player_id', target.id);
  const kickedLang = gameState.getPlayerById(target.id)?.language || 'en';
  const kickNotif = { id: globalThis.crypto.randomUUID(), player_id: target.id, type: 'clan_kick', message: ts(kickedLang, 'notif.clan_kick'), read: false, created_at: new Date().toISOString() };
  gameState.addNotification(kickNotif);
  supabase.from('notifications').insert(kickNotif).then(() => {}).catch(e => console.error('[clan] DB error:', e.message));

  // Update gameState
  if (gameState.loaded) {
    const tp = gameState.getPlayerById(target.id);
    if (tp) { tp.clan_id = null; tp.clan_role = null; tp.clan_left_at = nowISO; gameState.markDirty('players', tp.id); }
    const ch = gameState.getClanHqByPlayerId(target.id);
    if (ch) { ch.clan_id = null; gameState.markDirty('clanHqs', ch.id); }
    for (const m of gameState.clanMembers.values()) {
      if (m.player_id === target.id && m.clan_id === kickedClanId && !m.left_at) {
        m.left_at = nowISO; gameState.markDirty('clanMembers', m.id); break;
      }
    }
  }

  return res.json({ success: true });
}

// ── TRANSFER LEADERSHIP ─────────────────────────────────────
async function handleTransfer(req, res) {
  const { telegram_id, target_telegram_id } = req.body;
  const { player } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, clan_role');
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const lang = getLang(gameState, telegram_id);
  if (player.clan_role !== 'leader') return res.status(403).json({ error: ts(lang, 'err.leader_only_transfer') });

  const tgtTgId = parseTgId(target_telegram_id);
  const { data: target } = await supabase.from('players').select('id, clan_id').eq('telegram_id', tgtTgId).maybeSingle();
  if (!target || target.clan_id !== player.clan_id) return res.status(400).json({ error: ts(lang, 'err.player_not_in_clan') });

  const clanId = player.clan_id;
  await Promise.all([
    supabase.from('clan_members').update({ role: 'officer' }).eq('player_id', player.id).eq('clan_id', clanId),
    supabase.from('players').update({ clan_role: 'officer' }).eq('id', player.id),
    supabase.from('clan_members').update({ role: 'leader' }).eq('player_id', target.id).eq('clan_id', clanId),
    supabase.from('players').update({ clan_role: 'leader' }).eq('id', target.id),
    supabase.from('clans').update({ leader_id: target.id }).eq('id', clanId),
  ]);

  // Update gameState
  if (gameState.loaded) {
    const pp = gameState.getPlayerById(player.id);
    if (pp) { pp.clan_role = 'officer'; gameState.markDirty('players', pp.id); }
    const tp = gameState.getPlayerById(target.id);
    if (tp) { tp.clan_role = 'leader'; gameState.markDirty('players', tp.id); }
    const c = gameState.getClanById(clanId);
    if (c) { c.leader_id = target.id; gameState.markDirty('clans', c.id); }
    for (const m of gameState.clanMembers.values()) {
      if (m.clan_id === clanId && !m.left_at) {
        if (m.player_id === player.id) { m.role = 'officer'; gameState.markDirty('clanMembers', m.id); }
        if (m.player_id === target.id) { m.role = 'leader'; gameState.markDirty('clanMembers', m.id); }
      }
    }
  }

  return res.json({ success: true });
}

// ── INFO ────────────────────────────────────────────────────
async function handleInfo(req, res) {
  const { clan_id } = req.query;
  if (!clan_id) return res.status(400).json({ error: 'clan_id required' });

  const { data: clan } = await supabase.from('clans').select('*').eq('id', clan_id).single();
  if (!clan) return res.status(404).json({ error: 'Clan not found' });

  const config = getClanLevel(clan.level);

  const { data: members } = await supabase
    .from('clan_members')
    .select('player_id, role, joined_at, donated_month, players(telegram_id, game_username, username, avatar, level, last_seen)')
    .eq('clan_id', clan_id).is('left_at', null)
    .order('joined_at', { ascending: true });

  const memberIds = (members || []).map(m => m.player_id);
  const mineCountMap = {};
  if (memberIds.length > 0 && gameState.loaded) {
    // Use gameState for accurate count (no row limit)
    for (const m of gameState.mines.values()) {
      if (m.status === 'destroyed') continue;
      if (memberIds.includes(m.owner_id)) {
        mineCountMap[m.owner_id] = (mineCountMap[m.owner_id] || 0) + 1;
      }
    }
  } else if (memberIds.length > 0) {
    // DB fallback — count per player individually
    for (const pid of memberIds) {
      const { count } = await supabase.from('mines').select('*', { count: 'exact', head: true }).eq('owner_id', pid);
      if (count) mineCountMap[pid] = count;
    }
  }

  const { data: hqs } = await supabase.from('clan_headquarters').select('id, player_id, lat, lng').eq('clan_id', clan_id);
  const { data: leader } = await supabase.from('players').select('game_username, username').eq('id', clan.leader_id).maybeSingle();

  // Pending requests (for leaders/officers)
  let pendingRequests = [];
  const { data: reqs } = await supabase.from('clan_requests')
    .select('id, player_id, created_at, players(telegram_id, game_username, username, avatar, level)')
    .eq('clan_id', clan_id).eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (reqs) pendingRequests = reqs;

  return res.json({
    clan: { ...clan, ...config, member_count: (members || []).length, leader_name: leader?.game_username || leader?.username || '???' },
    members: (members || []).map(m => ({ ...m, mine_count: mineCountMap[m.player_id] || 0 })),
    headquarters: hqs || [],
    pending_requests: pendingRequests,
  });
}

// ── BOOST ──────────────────────────────────────────────────
async function handleBoost(req, res) {
  const { telegram_id } = req.body;
  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, clan_role');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const lang = getLang(gameState, telegram_id);
  if (!player.clan_id) return res.status(400).json({ error: ts(lang, 'err.not_in_clan') });
  if (player.clan_role !== 'leader' && player.clan_role !== 'officer') return res.status(403).json({ error: ts(lang, 'err.leader_or_officer') });

  const { data: clan } = await supabase.from('clans').select('id, level, treasury, boost_expires_at').eq('id', player.clan_id).single();
  if (!clan) return res.status(500).json({ error: ts(lang, 'err.clan_not_found') });

  // Check if boost is already active
  if (clan.boost_expires_at && new Date(clan.boost_expires_at) > new Date()) {
    return res.status(400).json({ error: ts(lang, 'err.boost_active') });
  }

  const config = getClanLevel(clan.level);
  const boostCost = config.boostCost || 500;
  const boostMul = config.boostMul || 2.0;

  if ((clan.treasury ?? 0) < boostCost) {
    return res.status(400).json({ error: ts(lang, 'err.need_treasury', { cost: boostCost }) });
  }

  const newTreasury = (clan.treasury ?? 0) - boostCost;
  const boostExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await supabase.from('clans').update({
    treasury: newTreasury,
    boost_multiplier: boostMul,
    boost_started_at: new Date().toISOString(),
    boost_expires_at: boostExpiresAt,
  }).eq('id', clan.id);

  // Update gameState
  if (gameState.loaded) {
    const c = gameState.getClanById(clan.id);
    if (c) {
      c.treasury = newTreasury;
      c.boost_multiplier = boostMul;
      c.boost_started_at = new Date().toISOString();
      c.boost_expires_at = boostExpiresAt;
      gameState.markDirty('clans', c.id);
    }
  }

  // Notify all clan members via Telegram bot
  try {
    const clanName = gameState.loaded ? gameState.getClanById(clan.id)?.name : null;
    const activatorName = gameState.loaded ? gameState.getPlayerById(player.id)?.game_username : null;
    const members = gameState.loaded ? gameState.getClanMembers(clan.id) : [];
    for (const m of members) {
      const p = gameState.getPlayerById(m.player_id);
      if (p?.telegram_id) {
        const pLang = p.language || 'en';
        sendTelegramNotification(p.telegram_id,
          ts(pLang, 'notif.clan_boost', { mul: boostMul, by: activatorName ? ` (${activatorName})` : '' })
        );
      }
    }
  } catch (_) {}

  return res.json({ success: true, boost_multiplier: boostMul, boost_expires_at: boostExpiresAt, treasury: newTreasury });
}

// ── SELL HQ ────────────────────────────────────────────────
async function handleSellHq(req, res) {
  const { telegram_id } = req.body;
  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, coins');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { data: hq } = await supabase.from('clan_headquarters').select('id').eq('player_id', player.id).maybeSingle();
  if (!hq) return res.status(404).json({ error: ts(getLang(gameState, telegram_id), 'err.clan_hq_not_found') });

  const refund = Math.floor(CLAN_HQ_COST * 0.25);
  const currentCoins = player.coins ?? 0;
  const newCoins = currentCoins + refund;

  const [{ data: coinsOk }, { error: delErr }] = await Promise.all([
    supabase.from('players').update({ coins: newCoins }).eq('id', player.id).eq('coins', currentCoins).select('id').maybeSingle(),
    supabase.from('clan_headquarters').delete().eq('id', hq.id),
  ]);

  if (delErr) return res.status(500).json({ error: delErr.message });
  if (!coinsOk) return res.status(409).json({ error: ts(getLang(gameState, telegram_id), 'err.conflict') });

  // Update gameState
  if (gameState.loaded) {
    gameState.clanHqs.delete(hq.id);
    const p = gameState.getPlayerById(player.id);
    if (p) { p.coins = newCoins; gameState.markDirty('players', p.id); }
  }

  return res.json({ success: true, refund, player_coins: newCoins });
}

// ── DISBAND ────────────────────────────────────────────────
async function handleDisband(req, res) {
  const { telegram_id } = req.body;
  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, clan_role');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const lang = getLang(gameState, telegram_id);
  if (!player.clan_id) return res.status(400).json({ error: ts(lang, 'err.not_in_clan') });
  if (player.clan_role !== 'leader') return res.status(403).json({ error: ts(lang, 'err.leader_only_disband') });

  const clanId = player.clan_id;
  const nowISO = new Date().toISOString();

  // Get all members to notify and update
  const { data: members } = await supabase.from('clan_members').select('player_id').eq('clan_id', clanId).is('left_at', null);

  // Remove all members from clan
  await Promise.all([
    supabase.from('clan_members').update({ left_at: nowISO }).eq('clan_id', clanId).is('left_at', null),
    supabase.from('clan_headquarters').update({ clan_id: null }).eq('clan_id', clanId),
    supabase.from('clans').delete().eq('id', clanId),
  ]);

  // Update all player records
  if (members?.length) {
    for (const m of members) {
      await supabase.from('players').update({ clan_id: null, clan_role: null, clan_left_at: nowISO }).eq('id', m.player_id);
    }
    // Notify non-leader members
    const nowISO_d = new Date().toISOString();
    const notifs = members.filter(m => m.player_id !== player.id).map(m => {
      const mLang = gameState.getPlayerById(m.player_id)?.language || 'en';
      return { id: globalThis.crypto.randomUUID(), player_id: m.player_id, type: 'clan_disband', message: ts(mLang, 'notif.clan_disband'), read: false, created_at: nowISO_d };
    });
    if (notifs.length) {
      for (const n of notifs) gameState.addNotification(n);
      supabase.from('notifications').insert(notifs).then(() => {}).catch(e => console.error('[clan] DB error:', e.message));
    }
  }

  // Update gameState
  if (gameState.loaded) {
    gameState.clans.delete(clanId);
    for (const m of gameState.clanMembers.values()) {
      if (m.clan_id === clanId && !m.left_at) { m.left_at = nowISO; gameState.markDirty('clanMembers', m.id); }
    }
    for (const ch of gameState.clanHqs.values()) {
      if (ch.clan_id === clanId) { ch.clan_id = null; gameState.markDirty('clanHqs', ch.id); }
    }
    if (members?.length) {
      for (const m of members) {
        const p = gameState.getPlayerById(m.player_id);
        if (p) { p.clan_id = null; p.clan_role = null; p.clan_left_at = nowISO; gameState.markDirty('players', p.id); }
      }
    }
  }

  return res.json({ success: true });
}

// ── EDIT ───────────────────────────────────────────────────
async function handleEdit(req, res) {
  const { telegram_id, name, symbol, color, description, min_level, join_policy } = req.body;
  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, clan_role, diamonds');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const lang = getLang(gameState, telegram_id);
  if (!player.clan_id) return res.status(400).json({ error: ts(lang, 'err.not_in_clan') });
  if (player.clan_role !== 'leader') return res.status(403).json({ error: ts(lang, 'err.leader_only_edit') });

  const { data: clan } = await supabase.from('clans').select('*').eq('id', player.clan_id).single();
  if (!clan) return res.status(500).json({ error: ts(lang, 'err.clan_not_found') });

  const update = {};
  let diamondCost = 0;

  // Free changes: color, description, min_level, join_policy
  if (color && ALLOWED_CLAN_COLORS.includes(color)) update.color = color;
  if (description != null) update.description = (description || '').slice(0, 100);
  if (min_level != null) update.min_level = Math.max(1, parseInt(min_level) || 1);
  if (join_policy && ['open','closed','request'].includes(join_policy)) update.join_policy = join_policy;

  // Paid changes: name (100💎), symbol (100💎)
  if (name && name.trim() !== clan.name) {
    const trimName = name.trim();
    if (trimName.length < 3 || trimName.length > 20) return res.status(400).json({ error: ts(lang, 'err.clan_name_length') });
    const { data: dup } = await supabase.from('clans').select('id').eq('name', trimName).neq('id', clan.id).maybeSingle();
    if (dup) return res.status(409).json({ error: ts(lang, 'err.name_taken') });
    update.name = trimName;
    diamondCost += 150;
  }
  if (symbol && symbol !== clan.symbol) {
    if (symbol.length > 4) return res.status(400).json({ error: ts(lang, 'err.clan_symbol_length') });
    update.symbol = symbol;
    diamondCost += 150;
  }

  if (Object.keys(update).length === 0) return res.status(400).json({ error: ts(lang, 'err.nothing_to_change') });

  // Check diamonds
  const currentDiamonds = player.diamonds ?? 0;
  if (diamondCost > 0 && currentDiamonds < diamondCost) {
    return res.status(400).json({ error: ts(lang, 'err.need_diamonds', { cost: diamondCost }) });
  }

  // Apply
  await supabase.from('clans').update(update).eq('id', clan.id);
  let newDiamonds = currentDiamonds;
  if (diamondCost > 0) {
    newDiamonds = currentDiamonds - diamondCost;
    await supabase.from('players').update({ diamonds: newDiamonds }).eq('id', player.id).eq('diamonds', currentDiamonds);
  }

  // Update gameState
  if (gameState.loaded) {
    const c = gameState.getClanById(clan.id);
    if (c) { Object.assign(c, update); gameState.markDirty('clans', c.id); }
    if (diamondCost > 0) {
      const p = gameState.getPlayerById(player.id);
      if (p) { p.diamonds = newDiamonds; gameState.markDirty('players', p.id); }
    }
  }

  return res.json({ success: true, clan: { ...clan, ...update }, player_diamonds: newDiamonds });
}

// ── APPLY TO CLAN (request policy) ──────────────────────────
async function handleApply(req, res) {
  const { telegram_id, clan_id } = req.body;
  if (!telegram_id || !clan_id) return res.status(400).json({ error: 'telegram_id, clan_id required' });

  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, level, clan_id, game_username, username');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const lang = getLang(gameState, telegram_id);
  if (player.clan_id) return res.status(400).json({ error: ts(lang, 'err.already_in_clan') });

  const { data: clanHq } = await supabase.from('clan_headquarters').select('id').eq('player_id', player.id).maybeSingle();
  if (!clanHq) return res.status(400).json({ error: ts(lang, 'err.build_clan_hq_first') });

  const { data: clan } = await supabase.from('clans').select('id, name, level, min_level, leader_id, join_policy').eq('id', clan_id).single();
  if (!clan) return res.status(404).json({ error: ts(lang, 'err.clan_not_found') });
  if ((clan.join_policy || 'open') !== 'request') return res.status(400).json({ error: 'Клан не принимает заявки' });
  if ((player.level ?? 1) < (clan.min_level || 1)) return res.status(400).json({ error: ts(lang, 'err.clan_min_level', { level: clan.min_level }) });

  const config = getClanLevel(clan.level);
  const { count } = await supabase.from('clan_members').select('*', { count: 'exact', head: true }).eq('clan_id', clan_id).is('left_at', null);
  if ((count || 0) >= config.maxMembers) return res.status(400).json({ error: ts(lang, 'err.clan_full') });

  // Check for existing request (any status) — unique constraint on (clan_id, player_id)
  const { data: existing } = await supabase.from('clan_requests').select('id, status').eq('clan_id', clan_id).eq('player_id', player.id).maybeSingle();
  if (existing) {
    if (existing.status === 'pending') return res.status(400).json({ error: 'Заявка уже отправлена' });
    // Reuse old rejected/accepted request — update to pending
    await supabase.from('clan_requests').update({ status: 'pending', created_at: new Date().toISOString() }).eq('id', existing.id);
  } else {
    await supabase.from('clan_requests').insert({ clan_id, player_id: player.id, status: 'pending' });
  }

  // Notify leader
  const { data: leader } = await supabase.from('players').select('telegram_id').eq('id', clan.leader_id).single();
  if (leader?.telegram_id) {
    const pName = player.game_username || player.username || 'Игрок';
    sendTelegramNotification(leader.telegram_id, `📩 ${pName} (Lv.${player.level}) подал заявку в клан ${clan.name}`);
  }

  return res.json({ success: true });
}

// ── ACCEPT/REJECT REQUEST ───────────────────────────────────
async function handleAcceptRequest(req, res) {
  const { telegram_id, request_id } = req.body;
  if (!telegram_id || !request_id) return res.status(400).json({ error: 'telegram_id, request_id required' });

  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, clan_role');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.clan_id) return res.status(400).json({ error: 'Not in a clan' });
  if (player.clan_role !== 'leader' && player.clan_role !== 'officer') return res.status(403).json({ error: 'Leader or officer only' });

  const { data: request } = await supabase.from('clan_requests').select('*').eq('id', request_id).eq('status', 'pending').single();
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.clan_id !== player.clan_id) return res.status(403).json({ error: 'Not your clan' });

  // Check clan not full
  const { data: clan } = await supabase.from('clans').select('id, name, level').eq('id', player.clan_id).single();
  const config = getClanLevel(clan?.level || 1);
  const { count } = await supabase.from('clan_members').select('*', { count: 'exact', head: true }).eq('clan_id', player.clan_id).is('left_at', null);
  if ((count || 0) >= config.maxMembers) return res.status(400).json({ error: 'Клан заполнен' });

  // Check applicant is not already in a clan
  const { data: applicant } = await supabase.from('players').select('id, clan_id, game_username, username, telegram_id').eq('id', request.player_id).single();
  if (!applicant) return res.status(404).json({ error: 'Player not found' });
  if (applicant.clan_id) {
    await supabase.from('clan_requests').update({ status: 'rejected' }).eq('id', request_id);
    return res.status(400).json({ error: 'Игрок уже в другом клане' });
  }

  // Accept: join player to clan
  await supabase.from('clan_requests').update({ status: 'accepted' }).eq('id', request_id);
  const [{ data: memberRow }] = await Promise.all([
    supabase.from('clan_members').insert({ clan_id: player.clan_id, player_id: applicant.id, role: 'member' }).select().single(),
    supabase.from('players').update({ clan_id: player.clan_id, clan_role: 'member' }).eq('id', applicant.id),
    supabase.from('clan_headquarters').update({ clan_id: player.clan_id }).eq('player_id', applicant.id),
  ]);

  if (gameState.loaded) {
    if (memberRow) gameState.upsertClanMember(memberRow);
    const p = gameState.getPlayerById(applicant.id);
    if (p) { p.clan_id = player.clan_id; p.clan_role = 'member'; gameState.markDirty('players', p.id); }
    const ch = gameState.getClanHqByPlayerId(applicant.id);
    if (ch) { ch.clan_id = player.clan_id; gameState.markDirty('clanHqs', ch.id); }
  }

  const aName = applicant.game_username || applicant.username || 'Игрок';
  sendTelegramNotification(applicant.telegram_id, `✅ Твоя заявка в клан ${clan.name} одобрена!`);

  return res.json({ success: true });
}

async function handleRejectRequest(req, res) {
  const { telegram_id, request_id } = req.body;
  if (!telegram_id || !request_id) return res.status(400).json({ error: 'telegram_id, request_id required' });

  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, clan_role');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.clan_id) return res.status(400).json({ error: 'Not in a clan' });
  if (player.clan_role !== 'leader' && player.clan_role !== 'officer') return res.status(403).json({ error: 'Leader or officer only' });

  const { data: request } = await supabase.from('clan_requests').select('*').eq('id', request_id).eq('status', 'pending').single();
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.clan_id !== player.clan_id) return res.status(403).json({ error: 'Not your clan' });

  await supabase.from('clan_requests').update({ status: 'rejected' }).eq('id', request_id);

  const { data: applicant } = await supabase.from('players').select('telegram_id, game_username').eq('id', request.player_id).maybeSingle();
  if (applicant?.telegram_id) {
    const { data: clan } = await supabase.from('clans').select('name').eq('id', player.clan_id).maybeSingle();
    sendTelegramNotification(applicant.telegram_id, `❌ Твоя заявка в клан ${clan?.name || ''} отклонена`);
  }

  return res.json({ success: true });
}

// ── CANCEL REQUEST ──────────────────────────────────────────
async function handleCancelRequest(req, res) {
  const { telegram_id, request_id } = req.body;
  if (!telegram_id || !request_id) return res.status(400).json({ error: 'telegram_id, request_id required' });

  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { data: request } = await supabase.from('clan_requests').select('id, player_id').eq('id', request_id).eq('status', 'pending').maybeSingle();
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.player_id !== player.id) return res.status(403).json({ error: 'Not your request' });

  await supabase.from('clan_requests').delete().eq('id', request_id);

  return res.json({ success: true });
}

// ── ROUTES ──────────────────────────────────────────────────
clanRouter.get('/', async (req, res) => {
  const { view } = req.query;
  if (view === 'list') return handleList(req, res);
  if (view === 'info') return handleInfo(req, res);
  return res.status(400).json({ error: 'Unknown view' });
});

clanRouter.post('/', async (req, res) => {
  const { action, telegram_id } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });
  return withPlayerLock(telegram_id, async () => {
    switch (action) {
      case 'build-hq':  return handleBuildHq(req, res);
      case 'create':    return handleCreate(req, res);
      case 'join':      return handleJoin(req, res);
      case 'leave':     return handleLeave(req, res);
      case 'donate':    return handleDonate(req, res);
      case 'upgrade':   return handleUpgrade(req, res);
      case 'set-role':  return handleSetRole(req, res);
      case 'kick':      return handleKick(req, res);
      case 'transfer':  return handleTransfer(req, res);
      case 'boost':     return handleBoost(req, res);
      case 'sell-hq':   return handleSellHq(req, res);
      case 'disband':   return handleDisband(req, res);
      case 'edit':            return handleEdit(req, res);
      case 'apply':           return handleApply(req, res);
      case 'accept-request':  return handleAcceptRequest(req, res);
      case 'reject-request':  return handleRejectRequest(req, res);
      case 'cancel-request':  return handleCancelRequest(req, res);
      default:                return res.status(400).json({ error: 'Unknown action' });
    }
  });
});
