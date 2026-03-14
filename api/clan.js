import { supabase, getPlayerByTelegramId, parseTgId, sendTelegramNotification } from '../lib/supabase.js';
import { getClanLevel, CLAN_LEVELS, CLAN_HQ_COST, CLAN_LEAVE_COOLDOWN, ALLOWED_CLAN_COLORS, BOOST_DURATION_MS } from '../lib/clans.js';
import { getCellId } from '../lib/grid.js';
import { cellToLatLng } from 'h3-js';

// ── BUILD HQ ────────────────────────────────────────────────
async function handleBuildHq(req, res) {
  const { telegram_id, lat, lng } = req.body;
  if (!telegram_id || lat == null || lng == null) {
    return res.status(400).json({ error: 'telegram_id, lat, lng required' });
  }

  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, coins');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { data: existingHq } = await supabase
    .from('clan_headquarters').select('id').eq('player_id', player.id).maybeSingle();
  if (existingHq) return res.status(409).json({ error: 'У вас уже есть штаб клана' });

  const balance = player.coins ?? 0;
  if (balance < CLAN_HQ_COST) {
    return res.status(400).json({ error: `Нужно ${CLAN_HQ_COST.toLocaleString()} монет` });
  }

  const cell_id = getCellId(parseFloat(lat), parseFloat(lng));
  const [cellLat, cellLng] = cellToLatLng(cell_id);

  const [{ data: hqOnCell }, { data: mineOnCell }, { data: clanHqOnCell }] = await Promise.all([
    supabase.from('headquarters').select('id').eq('cell_id', cell_id).maybeSingle(),
    supabase.from('mines').select('id').eq('cell_id', cell_id).maybeSingle(),
    supabase.from('clan_headquarters').select('id').eq('cell_id', cell_id).maybeSingle(),
  ]);
  if (hqOnCell || mineOnCell || clanHqOnCell) {
    return res.status(409).json({ error: 'Клетка занята' });
  }

  const newBalance = balance - CLAN_HQ_COST;
  const [{ data: coinsOk }, { data: hq, error: insertErr }] = await Promise.all([
    supabase.from('players').update({ coins: newBalance }).eq('id', player.id).eq('coins', balance).select('id').maybeSingle(),
    supabase.from('clan_headquarters').insert({ player_id: player.id, lat: cellLat, lng: cellLng, cell_id }).select().single(),
  ]);

  if (insertErr) return res.status(500).json({ error: insertErr.message });
  if (!coinsOk) return res.status(409).json({ error: 'Конфликт — попробуйте снова' });

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
  if (player.clan_id) return res.status(400).json({ error: 'Вы уже в клане' });

  const { data: clanHq } = await supabase.from('clan_headquarters').select('id').eq('player_id', player.id).maybeSingle();
  if (!clanHq) return res.status(400).json({ error: 'Сначала постройте штаб клана' });

  const { data: dup } = await supabase.from('clans').select('id').eq('name', trimName).maybeSingle();
  if (dup) return res.status(409).json({ error: 'Название клана уже занято' });

  const { data: clan, error: clanErr } = await supabase.from('clans').insert({
    name: trimName, symbol, color,
    description: (description || '').slice(0, 100),
    min_level: Math.max(1, parseInt(min_level) || 1),
    leader_id: player.id,
  }).select().single();
  if (clanErr) return res.status(500).json({ error: clanErr.message });

  await Promise.all([
    supabase.from('clan_members').insert({ clan_id: clan.id, player_id: player.id, role: 'leader' }),
    supabase.from('players').update({ clan_id: clan.id, clan_role: 'leader' }).eq('id', player.id),
    supabase.from('clan_headquarters').update({ clan_id: clan.id }).eq('player_id', player.id),
  ]);

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

  const { data: rawClans, error: qErr } = await supabase
    .from('clans').select('id, name, symbol, color, description, min_level, level, treasury, leader_id')
    .order('level', { ascending: false }).limit(100);
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

  if (player.clan_left_at) {
    const elapsed = Date.now() - new Date(player.clan_left_at).getTime();
    if (elapsed < CLAN_LEAVE_COOLDOWN) {
      return res.status(400).json({ error: `Кулдаун: подождите ещё ${Math.ceil((CLAN_LEAVE_COOLDOWN - elapsed) / 3600000)}ч` });
    }
  }

  const { data: clanHq } = await supabase.from('clan_headquarters').select('id').eq('player_id', player.id).maybeSingle();
  if (!clanHq) return res.status(400).json({ error: 'Сначала постройте штаб клана' });

  const { data: clan } = await supabase.from('clans').select('id, name, level, min_level, leader_id').eq('id', clan_id).single();
  if (!clan) return res.status(404).json({ error: 'Клан не найден' });
  if ((player.level ?? 1) < (clan.min_level || 1)) return res.status(400).json({ error: `Мин. уровень: ${clan.min_level}` });

  const config = getClanLevel(clan.level);
  const { count } = await supabase.from('clan_members').select('*', { count: 'exact', head: true }).eq('clan_id', clan_id).is('left_at', null);
  if ((count || 0) >= config.maxMembers) return res.status(400).json({ error: 'Клан переполнен' });

  await Promise.all([
    supabase.from('clan_members').insert({ clan_id, player_id: player.id, role: 'member' }),
    supabase.from('players').update({ clan_id, clan_role: 'member' }).eq('id', player.id),
    supabase.from('clan_headquarters').update({ clan_id }).eq('player_id', player.id),
  ]);

  const name = player.game_username || player.username || 'Игрок';
  const { data: leader } = await supabase.from('players').select('telegram_id').eq('id', clan.leader_id).single();
  if (leader?.telegram_id) sendTelegramNotification(leader.telegram_id, `⚔️ ${name} вступил в клан ${clan.name}!`);

  const { data: mems } = await supabase.from('clan_members').select('player_id').eq('clan_id', clan_id).is('left_at', null);
  if (mems?.length) {
    const notifs = mems.filter(m => m.player_id !== player.id).map(m => ({
      player_id: m.player_id, type: 'clan_join', message: `⚔️ ${name} вступил в клан!`,
    }));
    if (notifs.length) supabase.from('notifications').insert(notifs).catch(() => {});
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
  await Promise.all([
    supabase.from('clan_members').update({ left_at: nowISO }).eq('player_id', player.id).eq('clan_id', player.clan_id).is('left_at', null),
    supabase.from('players').update({ clan_id: null, clan_role: null, clan_left_at: nowISO }).eq('id', player.id),
    supabase.from('clan_headquarters').update({ clan_id: null }).eq('player_id', player.id),
  ]);
  return res.json({ success: true });
}

// ── DONATE ──────────────────────────────────────────────────
async function handleDonate(req, res) {
  try {
    const { telegram_id, amount } = req.body;
    const donateAmount = parseInt(amount);
    if (isNaN(donateAmount) || donateAmount <= 0) return res.status(400).json({ error: 'Некорректная сумма' });

    const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, diamonds, game_username, username');
    if (pErr) return res.status(500).json({ error: typeof pErr === 'string' ? pErr : pErr.message || 'DB error' });
    if (!player) return res.status(404).json({ error: 'Player not found' });
    if (!player.clan_id) return res.status(400).json({ error: 'Вы не в клане' });

    const currentDiamonds = player.diamonds ?? 0;
    if (currentDiamonds < donateAmount) return res.status(400).json({ error: 'Недостаточно алмазов' });

    const { data: clan, error: clanErr } = await supabase.from('clans').select('id, treasury').eq('id', player.clan_id).single();
    if (clanErr || !clan) return res.status(500).json({ error: 'Клан не найден' });

    const newDiamonds = currentDiamonds - donateAmount;
    const newTreasury = Number(clan.treasury ?? 0) + donateAmount;

    const { data: dOk, error: dErr } = await supabase.from('players')
      .update({ diamonds: newDiamonds }).eq('id', player.id).eq('diamonds', currentDiamonds).select('id').maybeSingle();
    if (dErr) return res.status(500).json({ error: dErr.message });
    if (!dOk) return res.status(409).json({ error: 'Конфликт — попробуйте снова' });

    const { error: tErr } = await supabase.from('clans')
      .update({ treasury: newTreasury }).eq('id', clan.id);
    if (tErr) return res.status(500).json({ error: tErr.message });

    const name = player.game_username || player.username || 'Игрок';
    supabase.from('clan_members').select('player_id').eq('clan_id', player.clan_id).is('left_at', null)
      .then(({ data: mems }) => {
        if (mems?.length) {
          const notifs = mems.filter(m => m.player_id !== player.id).map(m => ({
            player_id: m.player_id, type: 'clan_donate', message: `💎 ${name} пополнил казну на ${donateAmount} алмазов`,
          }));
          if (notifs.length) supabase.from('notifications').insert(notifs).catch(() => {});
        }
      }).catch(() => {});

    return res.json({ success: true, treasury: newTreasury, player_diamonds: newDiamonds });
  } catch (err) {
    console.error('[donate] crash:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}

// ── UPGRADE CLAN ────────────────────────────────────────────
async function handleUpgrade(req, res) {
  try {
    const { telegram_id } = req.body;
    const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, clan_role');
    if (pErr) return res.status(500).json({ error: typeof pErr === 'string' ? pErr : pErr.message || 'DB error' });
    if (!player) return res.status(404).json({ error: 'Player not found' });
    if (!player.clan_id) return res.status(400).json({ error: 'Вы не в клане' });
    if (player.clan_role !== 'leader' && player.clan_role !== 'officer') return res.status(403).json({ error: 'Только лидер или офицер' });

    const { data: clan } = await supabase.from('clans').select('id, level, treasury').eq('id', player.clan_id).single();
    if (!clan) return res.status(500).json({ error: 'Клан не найден' });
    if (clan.level >= 10) return res.status(400).json({ error: 'Максимальный уровень' });

    const nextConfig = getClanLevel(clan.level + 1);
    const treasury = Number(clan.treasury ?? 0);
    if (treasury < nextConfig.cost) return res.status(400).json({ error: `Нужно ${nextConfig.cost} алмазов в казне` });

    const newTreasury = treasury - nextConfig.cost;
    await supabase.from('clans').update({ level: clan.level + 1, treasury: newTreasury }).eq('id', clan.id);

    supabase.from('clan_members').select('player_id').eq('clan_id', clan.id).is('left_at', null)
      .then(({ data: mems }) => {
        if (mems?.length) {
          const notifs = mems.map(m => ({ player_id: m.player_id, type: 'clan_upgrade', message: `🎉 Клан достиг уровня ${clan.level + 1}! Новые бонусы активны` }));
          supabase.from('notifications').insert(notifs).catch(() => {});
        }
      }).catch(() => {});

    return res.json({ success: true, clan: { ...clan, level: clan.level + 1, treasury: newTreasury }, config: nextConfig });
  } catch (err) {
    console.error('[upgrade] crash:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
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
  await Promise.all([
    supabase.from('clan_members').update({ left_at: nowISO }).eq('player_id', target.id).eq('clan_id', player.clan_id).is('left_at', null),
    supabase.from('players').update({ clan_id: null, clan_role: null, clan_left_at: nowISO }).eq('id', target.id),
    supabase.from('clan_headquarters').update({ clan_id: null }).eq('player_id', target.id),
  ]);
  supabase.from('notifications').insert({ player_id: target.id, type: 'clan_kick', message: '👢 Вы были исключены из клана' }).catch(() => {});
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

  await Promise.all([
    supabase.from('clan_members').update({ role: 'officer' }).eq('player_id', player.id).eq('clan_id', player.clan_id),
    supabase.from('players').update({ clan_role: 'officer' }).eq('id', player.id),
    supabase.from('clan_members').update({ role: 'leader' }).eq('player_id', target.id).eq('clan_id', player.clan_id),
    supabase.from('players').update({ clan_role: 'leader' }).eq('id', target.id),
    supabase.from('clans').update({ leader_id: target.id }).eq('id', player.clan_id),
  ]);
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
    .select('player_id, role, joined_at, players(telegram_id, game_username, username, avatar, level)')
    .eq('clan_id', clan_id).is('left_at', null)
    .order('joined_at', { ascending: true });

  const memberIds = (members || []).map(m => m.player_id);
  const { data: mines } = memberIds.length > 0
    ? await supabase.from('mines').select('owner_id, level').in('owner_id', memberIds)
    : { data: [] };
  const mineCountMap = {};
  for (const m of (mines || [])) mineCountMap[m.owner_id] = (mineCountMap[m.owner_id] || 0) + 1;

  const { data: hqs } = await supabase.from('clan_headquarters').select('id, player_id, lat, lng').eq('clan_id', clan_id);
  const { data: leader } = await supabase.from('players').select('game_username, username').eq('id', clan.leader_id).maybeSingle();

  return res.json({
    clan: { ...clan, ...config, member_count: (members || []).length, leader_name: leader?.game_username || leader?.username || '???' },
    members: (members || []).map(m => ({ ...m, mine_count: mineCountMap[m.player_id] || 0 })),
    headquarters: hqs || [],
  });
}

// ── SELL HQ ──────────────────────────────────────────────────
async function handleSellHq(req, res) {
  const { telegram_id } = req.body;
  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, coins');
  if (pErr) return res.status(500).json({ error: typeof pErr === 'string' ? pErr : pErr.message });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (player.clan_id) return res.status(400).json({ error: 'Сначала покиньте клан' });

  const { data: hq } = await supabase.from('clan_headquarters').select('id').eq('player_id', player.id).maybeSingle();
  if (!hq) return res.status(404).json({ error: 'Штаб клана не найден' });

  const refund = Math.round(CLAN_HQ_COST * 0.5);
  const newCoins = (player.coins ?? 0) + refund;

  const [{ error: delErr }, { data: coinsOk }] = await Promise.all([
    supabase.from('clan_headquarters').delete().eq('id', hq.id),
    supabase.from('players').update({ coins: newCoins }).eq('id', player.id).eq('coins', player.coins ?? 0).select('id').maybeSingle(),
  ]);
  if (delErr) return res.status(500).json({ error: delErr.message });
  if (!coinsOk) return res.status(409).json({ error: 'Конфликт — попробуйте снова' });

  return res.json({ success: true, refund, player_coins: newCoins });
}

// ── BOOST ────────────────────────────────────────────────────
async function handleBoost(req, res) {
  try {
    const { telegram_id } = req.body;
    const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, clan_role');
    if (pErr) return res.status(500).json({ error: typeof pErr === 'string' ? pErr : pErr.message });
    if (!player) return res.status(404).json({ error: 'Player not found' });
    if (!player.clan_id) return res.status(400).json({ error: 'Вы не в клане' });
    if (player.clan_role !== 'leader' && player.clan_role !== 'officer') {
      return res.status(403).json({ error: 'Только лидер или офицер' });
    }

    const { data: clan } = await supabase.from('clans').select('id, level, treasury, boost_expires_at').eq('id', player.clan_id).single();
    if (!clan) return res.status(500).json({ error: 'Клан не найден' });

    // Check if boost already active
    if (clan.boost_expires_at && new Date(clan.boost_expires_at) > new Date()) {
      const remaining = Math.ceil((new Date(clan.boost_expires_at) - Date.now()) / 60000);
      return res.status(400).json({ error: `Буст уже активен (осталось ${remaining} мин)` });
    }

    const config = getClanLevel(clan.level);
    const cost = config.boostCost;
    const multiplier = config.boostMul;
    const treasury = Number(clan.treasury ?? 0);

    if (treasury < cost) return res.status(400).json({ error: `Нужно ${cost} 💎 в казне (сейчас ${treasury})` });

    const newTreasury = treasury - cost;
    const expiresAt = new Date(Date.now() + BOOST_DURATION_MS).toISOString();

    const { error: upErr } = await supabase.from('clans').update({
      treasury: newTreasury,
      boost_started_at: new Date().toISOString(),
      boost_expires_at: expiresAt,
      boost_multiplier: multiplier,
    }).eq('id', clan.id).eq('treasury', treasury); // optimistic lock

    if (upErr) return res.status(500).json({ error: upErr.message });

    // Notify members
    supabase.from('clan_members').select('player_id').eq('clan_id', clan.id).is('left_at', null)
      .then(({ data: mems }) => {
        if (mems?.length) {
          const notifs = mems.map(m => ({
            player_id: m.player_id, type: 'clan_boost',
            message: `🚀 Буст дохода x${multiplier} активирован на 24ч!`,
          }));
          supabase.from('notifications').insert(notifs).catch(() => {});
        }
      }).catch(() => {});

    return res.json({ success: true, boost_expires_at: expiresAt, boost_multiplier: multiplier, treasury: newTreasury });
  } catch (err) {
    console.error('[boost] crash:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}

// ── DISBAND CLAN ─────────────────────────────────────────────
async function handleDisband(req, res) {
  try {
    const { telegram_id } = req.body;
    const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id, clan_id, clan_role');
    if (pErr) return res.status(500).json({ error: typeof pErr === 'string' ? pErr : pErr.message });
    if (!player) return res.status(404).json({ error: 'Player not found' });
    if (!player.clan_id) return res.status(400).json({ error: 'Вы не в клане' });
    if (player.clan_role !== 'leader') return res.status(403).json({ error: 'Только лидер может распустить клан' });

    const clanId = player.clan_id;
    const nowISO = new Date().toISOString();

    // Get all members
    const { data: mems } = await supabase.from('clan_members').select('player_id').eq('clan_id', clanId).is('left_at', null);

    // Reset all members: clear clan_id, set left_at
    const memberIds = (mems || []).map(m => m.player_id);
    await Promise.all([
      supabase.from('clan_members').update({ left_at: nowISO }).eq('clan_id', clanId).is('left_at', null),
      memberIds.length > 0
        ? supabase.from('players').update({ clan_id: null, clan_role: null, clan_left_at: nowISO }).in('id', memberIds)
        : Promise.resolve(),
      supabase.from('clan_headquarters').update({ clan_id: null }).eq('clan_id', clanId),
      supabase.from('clans').delete().eq('id', clanId),
    ]);

    // Notify members
    if (memberIds.length > 1) {
      const notifs = memberIds.filter(id => id !== player.id).map(id => ({
        player_id: id, type: 'clan_disband', message: '⚔️ Клан был распущен лидером',
      }));
      supabase.from('notifications').insert(notifs).catch(() => {});
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[disband] crash:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}

// ── HANDLER ──────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'GET') {
    const { view } = req.query;
    if (view === 'list') return handleList(req, res);
    if (view === 'info') return handleInfo(req, res);
    return res.status(400).json({ error: 'Unknown view' });
  }

  if (req.method === 'POST') {
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
      case 'sell-hq':   return handleSellHq(req, res);
      case 'disband':   return handleDisband(req, res);
      case 'boost':     return handleBoost(req, res);
      default:          return res.status(400).json({ error: 'Unknown action' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
