import { Router } from 'express';
import { supabase, getPlayerByTelegramId, parseTgId, sendTelegramNotification } from '../../lib/supabase.js';
import { getClanLevel, CLAN_LEVELS, CLAN_HQ_COST, CLAN_LEAVE_COOLDOWN, ALLOWED_CLAN_COLORS } from '../../lib/clans.js';
import { getCellId } from '../../lib/grid.js';
import { cellToLatLng } from 'h3-js';
import { gameState } from '../../lib/gameState.js';
import { logActivity } from '../../server.js';

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
  if (existingHq) return res.status(409).json({ error: 'У вас уже есть штаб клана' });
  // Also clear stale gameState entry if DB has no HQ
  if (gameState.loaded) {
    const gsHq = gameState.getClanHqByPlayerId(player.id);
    if (gsHq && !existingHq) {
      gameState.clanHqs.delete(gsHq.id);
    }
  }

  const balance = player.coins ?? 0;
  if (balance < CLAN_HQ_COST) {
    return res.status(400).json({ error: `Нужно ${CLAN_HQ_COST.toLocaleString()} монет` });
  }

  // Use tap coordinates for clan HQ placement
  const tapLat = parseFloat(lat), tapLng = parseFloat(lng);
  const cell_id = getCellId(tapLat, tapLng);

  const [{ data: hqOnCell }, { data: mineOnCell }, { data: clanHqOnCell }] = await Promise.all([
    supabase.from('headquarters').select('id').eq('cell_id', cell_id).maybeSingle(),
    supabase.from('mines').select('id').eq('cell_id', cell_id).maybeSingle(),
    supabase.from('clan_headquarters').select('id').eq('cell_id', cell_id).maybeSingle(),
  ]);
  if (hqOnCell || mineOnCell || clanHqOnCell) {
    return res.status(409).json({ error: 'Клетка занята' });
  }

  const newBalance = balance - CLAN_HQ_COST;

  // First deduct coins (optimistic lock)
  const { data: coinsOk } = await supabase.from('players').update({ coins: newBalance }).eq('id', player.id).eq('coins', balance).select('id').maybeSingle();
  if (!coinsOk) return res.status(409).json({ error: 'Конфликт — попробуйте снова' });

  // clan_id is NOT NULL + FK in DB — create a placeholder clan entry for FK satisfaction
  // Player does NOT get linked to it — they stay clanless until they create/join a real clan
  let clanIdForHq = player.clan_id;
  if (!clanIdForHq) {
    const placeholderName = `_placeholder_${player.id.slice(0, 8)}_${Date.now()}`;
    const { data: placeholder, error: phErr } = await supabase.from('clans').insert({
      name: placeholderName, symbol: '🏗️', color: '#607D8B',
      description: '', min_level: 999, leader_id: player.id,
    }).select('id').single();
    if (phErr) {
      await supabase.from('players').update({ coins: balance }).eq('id', player.id);
      return res.status(500).json({ error: 'Не удалось создать штаб' });
    }
    clanIdForHq = placeholder.id;
    if (gameState.loaded) {
      gameState.upsertClan({ id: placeholder.id, name: placeholderName, symbol: '🏗️', color: '#607D8B', level: 1, min_level: 999, leader_id: player.id });
    }
    // Player is NOT linked to this placeholder clan — stays clan_id=null
  }
  const insertData = { player_id: player.id, lat: tapLat, lng: tapLng, cell_id, clan_id: clanIdForHq };
  const { data: hq, error: insertErr } = await supabase.from('clan_headquarters').insert(insertData).select().single();

  if (insertErr) {
    // Refund coins on failure
    await supabase.from('players').update({ coins: balance }).eq('id', player.id);
    if (gameState.loaded) {
      const p = gameState.getPlayerById(player.id);
      if (p) { p.coins = balance; gameState.markDirty('players', p.id); }
    }
    return res.status(500).json({ error: 'Не удалось поставить штаб. ' + (insertErr.message || '') });
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
  const { telegram_id, name, symbol, color, description, min_level } = req.body;
  if (!telegram_id || !name || !symbol || !color) {
    return res.status(400).json({ error: 'telegram_id, name, symbol, color required' });
  }

  const trimName = name.trim();
  if (trimName.length < 3 || trimName.length > 20) return res.status(400).json({ error: 'Название: 3-20 символов' });
  if (symbol.length > 4) return res.status(400).json({ error: 'Символ: один emoji' });
  if (!ALLOWED_CLAN_COLORS.includes(color)) return res.status(400).json({ error: 'Недопустимый цвет' });

  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, clan_id');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  // Check if player already in a real clan
  if (player.clan_id) {
    const { data: existing } = await supabase.from('clans').select('id, name').eq('id', player.clan_id).maybeSingle();
    if (existing && !existing.name.startsWith('_placeholder_')) {
      return res.status(400).json({ error: 'Вы уже в клане' });
    }
  }

  const { data: clanHq } = await supabase.from('clan_headquarters').select('id, clan_id').eq('player_id', player.id).maybeSingle();
  if (!clanHq) return res.status(400).json({ error: 'Сначала постройте штаб клана' });

  const { data: dup } = await supabase.from('clans').select('id').eq('name', trimName).maybeSingle();
  if (dup) return res.status(409).json({ error: 'Название клана уже занято' });

  // Find placeholder clan on the HQ (created during build-hq)
  let placeholderClanId = null;
  if (clanHq.clan_id) {
    const { data: phClan } = await supabase.from('clans').select('id, name').eq('id', clanHq.clan_id).maybeSingle();
    if (phClan?.name?.startsWith('_placeholder_')) placeholderClanId = phClan.id;
  }

  let clan;
  if (placeholderClanId) {
    // Update placeholder with real clan data
    const { data: updated, error: updateErr } = await supabase.from('clans').update({
      name: trimName, symbol, color,
      description: (description || '').slice(0, 100),
      min_level: Math.max(1, parseInt(min_level) || 1),
      leader_id: player.id,
    }).eq('id', placeholderClanId).select().single();
    if (updateErr) return res.status(500).json({ error: updateErr.message });
    clan = updated;
  } else {
    // No placeholder — create new clan + link HQ
    const { data: newClan, error: clanErr } = await supabase.from('clans').insert({
      name: trimName, symbol, color,
      description: (description || '').slice(0, 100),
      min_level: Math.max(1, parseInt(min_level) || 1),
      leader_id: player.id,
    }).select().single();
    if (clanErr) return res.status(500).json({ error: clanErr.message });
    clan = newClan;
    await supabase.from('clan_headquarters').update({ clan_id: clan.id }).eq('player_id', player.id);
  }

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

  return res.status(201).json({ success: true, clan });
}

// ── LIST CLANS ──────────────────────────────────────────────
async function handleList(req, res) {
  const { telegram_id } = req.query;
  let playerLevel = 0, playerClanId = null, playerHasClanHq = false;

  if (telegram_id) {
    const { player } = await getPlayerByTelegramId(telegram_id, 'id, level, clan_id');
    if (player) {
      playerLevel = player.level ?? 1;
      playerClanId = player.clan_id;
      const { data: cHq } = await supabase.from('clan_headquarters').select('id').eq('player_id', player.id).maybeSingle();
      playerHasClanHq = !!cHq;
    }
  }

  const { data: rawClansAll, error: qErr } = await supabase
    .from('clans').select('id, name, symbol, color, description, min_level, level, treasury, leader_id')
    .order('level', { ascending: false }).limit(100);
  // Filter out placeholder clans
  const rawClans = (rawClansAll || []).filter(c => !c.name.startsWith('_placeholder_'));
  if (qErr) return res.status(500).json({ error: qErr.message });

  const clanIds = (rawClans || []).map(c => c.id);
  const [{ data: members }, { data: leaders }] = await Promise.all([
    clanIds.length > 0
      ? supabase.from('clan_members').select('clan_id').in('clan_id', clanIds).is('left_at', null)
      : { data: [] },
    (() => {
      const leaderIds = [...new Set((rawClans || []).map(c => c.leader_id).filter(Boolean))];
      return leaderIds.length > 0
        ? supabase.from('players').select('id, game_username, username').in('id', leaderIds)
        : { data: [] };
    })(),
  ]);

  const countMap = {};
  for (const m of (members || [])) countMap[m.clan_id] = (countMap[m.clan_id] || 0) + 1;
  const leaderMap = {};
  for (const l of (leaders || [])) leaderMap[l.id] = l.game_username || l.username || '???';

  const clans = (rawClans || []).map(c => {
    const config = getClanLevel(c.level);
    const mc = countMap[c.id] || 0;
    return {
      ...c, member_count: mc, leader_name: leaderMap[c.leader_id] || '???',
      max_members: config.maxMembers, income_bonus: config.income, defense_bonus: config.defense, radius: config.radius,
      can_join: !playerClanId && playerLevel >= (c.min_level || 1) && mc < config.maxMembers && playerHasClanHq,
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
  if (player.clan_id) return res.status(400).json({ error: 'Вы уже в клане' });

  // No join cooldown

  const { data: clanHq } = await supabase.from('clan_headquarters').select('id').eq('player_id', player.id).maybeSingle();
  if (!clanHq) return res.status(400).json({ error: 'Сначала постройте штаб клана' });

  const { data: clan } = await supabase.from('clans').select('id, name, level, min_level, leader_id').eq('id', clan_id).single();
  if (!clan) return res.status(404).json({ error: 'Клан не найден' });
  if ((player.level ?? 1) < (clan.min_level || 1)) return res.status(400).json({ error: `Мин. уровень: ${clan.min_level}` });

  const config = getClanLevel(clan.level);
  const { count } = await supabase.from('clan_members').select('*', { count: 'exact', head: true }).eq('clan_id', clan_id).is('left_at', null);
  if ((count || 0) >= config.maxMembers) return res.status(400).json({ error: 'Клан переполнен' });

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
  const name = player.game_username || player.username || 'Игрок';
  const { data: leader } = await supabase.from('players').select('telegram_id').eq('id', clan.leader_id).single();
  if (leader?.telegram_id) sendTelegramNotification(leader.telegram_id, `⚔️ ${name} вступил в клан ${clan.name}!`);

  const { data: mems } = await supabase.from('clan_members').select('player_id').eq('clan_id', clan_id).is('left_at', null);
  if (mems?.length) {
    const notifs = mems.filter(m => m.player_id !== player.id).map(m => ({
      player_id: m.player_id, type: 'clan_join', message: `⚔️ ${name} вступил в клан!`,
    }));
    if (notifs.length) supabase.from('notifications').insert(notifs).then(() => {}).catch(() => {});
  }

  return res.json({ success: true });
}

// ── LEAVE CLAN ──────────────────────────────────────────────
async function handleLeave(req, res) {
  const { telegram_id } = req.body;
  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, clan_role');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.clan_id) return res.status(400).json({ error: 'Вы не в клане' });
  if (player.clan_role === 'leader') return res.status(400).json({ error: 'Лидер не может покинуть клан. Сначала передайте лидерство.' });

  const nowISO = new Date().toISOString();
  const leavingClanId = player.clan_id;
  await Promise.all([
    supabase.from('clan_members').update({ left_at: nowISO }).eq('player_id', player.id).eq('clan_id', leavingClanId).is('left_at', null),
    supabase.from('players').update({ clan_id: null, clan_role: null, clan_left_at: nowISO }).eq('id', player.id),
    supabase.from('clan_headquarters').update({ clan_id: null }).eq('player_id', player.id),
  ]);

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
  if (isNaN(donateAmount) || donateAmount <= 0) return res.status(400).json({ error: 'Некорректная сумма' });

  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, diamonds, game_username, username');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.clan_id) return res.status(400).json({ error: 'Вы не в клане' });

  const currentDiamonds = player.diamonds ?? 0;
  if (currentDiamonds < donateAmount) return res.status(400).json({ error: 'Недостаточно алмазов' });

  const { data: clan } = await supabase.from('clans').select('id, treasury').eq('id', player.clan_id).single();
  if (!clan) return res.status(500).json({ error: 'Клан не найден' });

  const newDiamonds = currentDiamonds - donateAmount;
  const newTreasury = (clan.treasury ?? 0) + donateAmount;

  const [{ data: dOk }, { error: tErr }] = await Promise.all([
    supabase.from('players').update({ diamonds: newDiamonds }).eq('id', player.id).eq('diamonds', currentDiamonds).select('id').maybeSingle(),
    supabase.from('clans').update({ treasury: newTreasury }).eq('id', clan.id),
  ]);
  if (!dOk) return res.status(409).json({ error: 'Конфликт — попробуйте снова' });
  if (tErr) return res.status(500).json({ error: tErr.message });

  // Update gameState
  if (gameState.loaded) {
    const p = gameState.getPlayerById(player.id);
    if (p) { p.diamonds = newDiamonds; gameState.markDirty('players', p.id); }
    const c = gameState.getClanById(clan.id);
    if (c) { c.treasury = newTreasury; gameState.markDirty('clans', c.id); }
  }

  const name = player.game_username || player.username || 'Игрок';
  const { data: mems } = await supabase.from('clan_members').select('player_id').eq('clan_id', player.clan_id).is('left_at', null);
  if (mems?.length) {
    const notifs = mems.filter(m => m.player_id !== player.id).map(m => ({
      player_id: m.player_id, type: 'clan_donate', message: `💎 ${name} пополнил казну на ${donateAmount} алмазов`,
    }));
    if (notifs.length) supabase.from('notifications').insert(notifs).then(() => {}).catch(() => {});
  }

  return res.json({ success: true, treasury: newTreasury, player_diamonds: newDiamonds });
}

// ── UPGRADE CLAN ────────────────────────────────────────────
async function handleUpgrade(req, res) {
  const { telegram_id } = req.body;
  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, clan_role');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.clan_id) return res.status(400).json({ error: 'Вы не в клане' });
  if (player.clan_role !== 'leader' && player.clan_role !== 'officer') return res.status(403).json({ error: 'Только лидер или офицер' });

  const { data: clan } = await supabase.from('clans').select('id, level, treasury').eq('id', player.clan_id).single();
  if (!clan) return res.status(500).json({ error: 'Клан не найден' });
  if (clan.level >= 10) return res.status(400).json({ error: 'Максимальный уровень' });

  const nextConfig = getClanLevel(clan.level + 1);
  if ((clan.treasury ?? 0) < nextConfig.cost) return res.status(400).json({ error: `Нужно ${nextConfig.cost} алмазов в казне` });

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
    const notifs = mems.map(m => ({ player_id: m.player_id, type: 'clan_upgrade', message: `🎉 Клан достиг уровня ${newLevel}! Новые бонусы активны` }));
    supabase.from('notifications').insert(notifs).then(() => {}).catch(() => {});
  }

  return res.json({ success: true, clan: { ...clan, level: newLevel, treasury: newTreasury }, config: nextConfig });
}

// ── SET ROLE ────────────────────────────────────────────────
async function handleSetRole(req, res) {
  const { telegram_id, target_telegram_id, role } = req.body;
  if (!['officer', 'member'].includes(role)) return res.status(400).json({ error: 'role: officer | member' });

  const { player } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, clan_role');
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (player.clan_role !== 'leader') return res.status(403).json({ error: 'Только лидер может менять роли' });

  const tgtTgId = parseTgId(target_telegram_id);
  const { data: target } = await supabase.from('players').select('id, clan_id').eq('telegram_id', tgtTgId).maybeSingle();
  if (!target || target.clan_id !== player.clan_id) return res.status(400).json({ error: 'Игрок не в вашем клане' });

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
  if (!['leader', 'officer'].includes(player.clan_role)) return res.status(403).json({ error: 'Недостаточно прав' });

  const tgtTgId = parseTgId(target_telegram_id);
  const { data: target } = await supabase.from('players').select('id, clan_id, clan_role').eq('telegram_id', tgtTgId).maybeSingle();
  if (!target || target.clan_id !== player.clan_id) return res.status(400).json({ error: 'Игрок не в вашем клане' });
  if (target.clan_role === 'leader') return res.status(403).json({ error: 'Нельзя кикнуть лидера' });
  if (player.clan_role === 'officer' && target.clan_role === 'officer') return res.status(403).json({ error: 'Офицер не может кикнуть другого офицера' });

  const nowISO = new Date().toISOString();
  const kickedClanId = player.clan_id;
  await Promise.all([
    supabase.from('clan_members').update({ left_at: nowISO }).eq('player_id', target.id).eq('clan_id', kickedClanId).is('left_at', null),
    supabase.from('players').update({ clan_id: null, clan_role: null, clan_left_at: nowISO }).eq('id', target.id),
    supabase.from('clan_headquarters').update({ clan_id: null }).eq('player_id', target.id),
  ]);
  supabase.from('notifications').insert({ player_id: target.id, type: 'clan_kick', message: '👢 Вы были исключены из клана' }).catch(() => {});

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
  if (player.clan_role !== 'leader') return res.status(403).json({ error: 'Только лидер может передать лидерство' });

  const tgtTgId = parseTgId(target_telegram_id);
  const { data: target } = await supabase.from('players').select('id, clan_id').eq('telegram_id', tgtTgId).maybeSingle();
  if (!target || target.clan_id !== player.clan_id) return res.status(400).json({ error: 'Игрок не в вашем клане' });

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
  if (!clan) return res.status(404).json({ error: 'Клан не найден' });

  const config = getClanLevel(clan.level);

  const { data: members } = await supabase
    .from('clan_members')
    .select('player_id, role, joined_at, players(telegram_id, game_username, username, avatar, level, last_seen)')
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

  return res.json({
    clan: { ...clan, ...config, member_count: (members || []).length, leader_name: leader?.game_username || leader?.username || '???' },
    members: (members || []).map(m => ({ ...m, mine_count: mineCountMap[m.player_id] || 0 })),
    headquarters: hqs || [],
  });
}

// ── BOOST ──────────────────────────────────────────────────
async function handleBoost(req, res) {
  const { telegram_id } = req.body;
  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, clan_role');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.clan_id) return res.status(400).json({ error: 'Вы не в клане' });
  if (player.clan_role !== 'leader' && player.clan_role !== 'officer') return res.status(403).json({ error: 'Только лидер или офицер' });

  const { data: clan } = await supabase.from('clans').select('id, level, treasury, boost_expires_at').eq('id', player.clan_id).single();
  if (!clan) return res.status(500).json({ error: 'Клан не найден' });

  // Check if boost is already active
  if (clan.boost_expires_at && new Date(clan.boost_expires_at) > new Date()) {
    return res.status(400).json({ error: 'Буст уже активен' });
  }

  const config = getClanLevel(clan.level);
  const boostCost = config.boostCost || 500;
  const boostMul = config.boostMul || 2.0;

  if ((clan.treasury ?? 0) < boostCost) {
    return res.status(400).json({ error: `Нужно ${boostCost} алмазов в казне` });
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
        sendTelegramNotification(p.telegram_id,
          `🚀 Клан-буст x${boostMul} активирован${activatorName ? ` (${activatorName})` : ''}! Доход увеличен на 24ч.`
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
  if (!hq) return res.status(404).json({ error: 'Штаб не найден' });

  const refund = Math.round(CLAN_HQ_COST / 2);
  const currentCoins = player.coins ?? 0;
  const newCoins = currentCoins + refund;

  const [{ data: coinsOk }, { error: delErr }] = await Promise.all([
    supabase.from('players').update({ coins: newCoins }).eq('id', player.id).eq('coins', currentCoins).select('id').maybeSingle(),
    supabase.from('clan_headquarters').delete().eq('id', hq.id),
  ]);

  if (delErr) return res.status(500).json({ error: delErr.message });
  if (!coinsOk) return res.status(409).json({ error: 'Конфликт — попробуйте снова' });

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
  if (!player.clan_id) return res.status(400).json({ error: 'Вы не в клане' });
  if (player.clan_role !== 'leader') return res.status(403).json({ error: 'Только лидер может распустить клан' });

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
    const notifs = members.filter(m => m.player_id !== player.id).map(m => ({
      player_id: m.player_id, type: 'clan_disband', message: '💀 Клан был распущен лидером',
    }));
    if (notifs.length) supabase.from('notifications').insert(notifs).then(() => {}).catch(() => {});
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
  const { telegram_id, name, symbol, color, description, min_level } = req.body;
  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, clan_role, diamonds');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.clan_id) return res.status(400).json({ error: 'Вы не в клане' });
  if (player.clan_role !== 'leader') return res.status(403).json({ error: 'Только лидер может редактировать клан' });

  const { data: clan } = await supabase.from('clans').select('*').eq('id', player.clan_id).single();
  if (!clan) return res.status(500).json({ error: 'Клан не найден' });

  const update = {};
  let diamondCost = 0;

  // Free changes: color, description, min_level
  if (color && ALLOWED_CLAN_COLORS.includes(color)) update.color = color;
  if (description != null) update.description = (description || '').slice(0, 100);
  if (min_level != null) update.min_level = Math.max(1, parseInt(min_level) || 1);

  // Paid changes: name (100💎), symbol (100💎)
  if (name && name.trim() !== clan.name) {
    const trimName = name.trim();
    if (trimName.length < 3 || trimName.length > 20) return res.status(400).json({ error: 'Название: 3-20 символов' });
    const { data: dup } = await supabase.from('clans').select('id').eq('name', trimName).neq('id', clan.id).maybeSingle();
    if (dup) return res.status(409).json({ error: 'Название уже занято' });
    update.name = trimName;
    diamondCost += 100;
  }
  if (symbol && symbol !== clan.symbol) {
    if (symbol.length > 4) return res.status(400).json({ error: 'Символ: один emoji' });
    update.symbol = symbol;
    diamondCost += 100;
  }

  if (Object.keys(update).length === 0) return res.status(400).json({ error: 'Нечего менять' });

  // Check diamonds
  const currentDiamonds = player.diamonds ?? 0;
  if (diamondCost > 0 && currentDiamonds < diamondCost) {
    return res.status(400).json({ error: `Нужно ${diamondCost} 💎` });
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
    case 'edit':      return handleEdit(req, res);
    default:          return res.status(400).json({ error: 'Unknown action' });
  }
});
