import { supabase, getPlayerByTelegramId, parseTgId, rateLimit, sendTelegramNotification } from '../../lib/supabase.js';
import { xpForLevel, SMALL_RADIUS, LARGE_RADIUS, calcHpRegen, getMineIncome, getMineHp, getMineHpRegen, calcMineHpRegen, ALLOWED_AVATARS } from '../../lib/formulas.js';
import { haversine } from '../../lib/haversine.js';
import { addXp } from '../../lib/xp.js';
import { calcTotalIncomeWithClanBonus } from '../../lib/clans.js';

// ── SET USERNAME ─────────────────────────────────────────────────────────────
const USERNAME_RE = /^[a-zA-Zа-яА-ЯёЁ0-9_]+$/;
const RENAME_COST_DIAMONDS = 10;

async function handleSetUsername(req, res) {
  const { telegram_id, username } = req.body || {};
  if (!telegram_id || !username)
    return res.status(400).json({ error: 'telegram_id and username are required' });

  const trimmed = username.trim();
  if (trimmed.length < 3 || trimmed.length > 16)
    return res.status(400).json({ error: 'Ник должен быть 3-16 символов' });
  if (!USERNAME_RE.test(trimmed))
    return res.status(400).json({ error: 'Только буквы, цифры и _' });

  const { player, error: findErr } = await getPlayerByTelegramId(
    telegram_id, 'id,game_username,username_changes,diamonds'
  );
  if (findErr) return res.status(500).json({ error: findErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { data: existing } = await supabase
    .from('players').select('id')
    .ilike('game_username', trimmed)
    .neq('id', player.id)
    .maybeSingle();
  if (existing)
    return res.status(400).json({ error: 'Этот ник уже занят' });

  const changes = player.username_changes ?? 0;
  let newDiamonds = player.diamonds ?? 0;
  if (changes > 0) {
    if (newDiamonds < RENAME_COST_DIAMONDS)
      return res.status(400).json({ error: `Недостаточно алмазов (нужно ${RENAME_COST_DIAMONDS} 💎)` });
    newDiamonds -= RENAME_COST_DIAMONDS;
  }

  const updateObj = { game_username: trimmed, username_changes: changes + 1 };
  if (changes > 0) updateObj.diamonds = newDiamonds;

  const { error: updateErr } = await supabase
    .from('players').update(updateObj).eq('id', player.id);
  if (updateErr)
    return res.status(500).json({ error: updateErr.message });

  return res.status(200).json({
    success: true,
    game_username: trimmed,
    diamonds: newDiamonds,
    username_changes: changes + 1,
  });
}

// ── AVATAR ──────────────────────────────────────────────────────────────────
async function handleAvatar(req, res) {
  const { telegram_id, avatar } = req.body;
  if (!telegram_id || !avatar)
    return res.status(400).json({ error: 'telegram_id and avatar are required' });
  if (!ALLOWED_AVATARS.includes(avatar))
    return res.status(400).json({ error: 'Invalid avatar' });

  const { player, error: findError } = await getPlayerByTelegramId(telegram_id);
  if (findError) return res.status(500).json({ error: findError });
  if (!player)   return res.status(404).json({ error: 'Player not found' });

  const { data: updated, error: updateError } = await supabase
    .from('players').update({ avatar }).eq('id', player.id)
    .select('id, telegram_id, username, avatar').single();
  if (updateError) return res.status(500).json({ error: updateError.message });
  return res.status(200).json({ player: updated });
}

// ── LOCATION ────────────────────────────────────────────────────────────────
async function handleLocation(req, res) {
  const { telegram_id, lat, lng } = req.body;
  if (!telegram_id || lat == null || lng == null)
    return res.status(400).json({ error: 'telegram_id, lat, lng are required' });

  const playerLat = parseFloat(lat), playerLng = parseFloat(lng);
  if (isNaN(playerLat) || isNaN(playerLng))
    return res.status(400).json({ error: 'lat and lng must be numbers' });

  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id);
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player)     return res.status(404).json({ error: 'Player not found' });

  const { error } = await supabase.from('players')
    .update({ last_lat: playerLat, last_lng: playerLng, last_seen: new Date().toISOString() })
    .eq('id', player.id);
  if (error) return res.status(500).json({ error: 'Failed to update location' });
  return res.status(200).json({ ok: true });
}

// ── PVP INITIATE ─────────────────────────────────────────────────────────────
function simulateBattle(attacker, defender, attackerWeapon, defenderWeapon) {
  const ROUNDS = 3;
  const rounds = [];
  let attackerHp = 100 + (attacker.bonus_hp || 0);
  let defenderHp = 100 + (defender.bonus_hp || 0);
  const attackerBonus = 1.2; // first-strike bonus

  for (let r = 0; r < ROUNDS; r++) {
    const roundResult = {};
    // Attacker hits
    const atkBase = 10 + (attackerWeapon?.attack || 0);
    const atkCrit = attackerWeapon?.type === 'sword' ? (attackerWeapon.crit_chance || 0) : 0;
    const atkIsCrit = Math.random() * 100 < atkCrit;
    const atkDmg = Math.round(atkBase * (r === 0 ? attackerBonus : 1) * (atkIsCrit ? 2 : 1));
    defenderHp = Math.max(0, defenderHp - atkDmg);
    roundResult.attackerDmg = atkDmg;
    roundResult.attackerCrit = atkIsCrit;
    roundResult.defenderHpAfter = defenderHp;
    if (defenderHp <= 0) { rounds.push(roundResult); break; }

    // Defender hits
    const defBase = 10 + (defenderWeapon?.attack || 0);
    const defCrit = defenderWeapon?.type === 'sword' ? (defenderWeapon.crit_chance || 0) : 0;
    const defIsCrit = Math.random() * 100 < defCrit;
    const defDmg = Math.round(defBase * (defIsCrit ? 2 : 1));
    attackerHp = Math.max(0, attackerHp - defDmg);
    roundResult.defenderDmg = defDmg;
    roundResult.defenderCrit = defIsCrit;
    roundResult.attackerHpAfter = attackerHp;
    rounds.push(roundResult);
    if (attackerHp <= 0) break;
  }

  const winner = attackerHp > defenderHp ? 'attacker' : 'defender';
  return { rounds, winner, attackerHpLeft: attackerHp, defenderHpLeft: defenderHp };
}

async function handlePvpInitiate(req, res) {
  const { telegram_id, defender_telegram_id, lat, lng } = req.body || {};
  if (!telegram_id || !defender_telegram_id || lat == null || lng == null)
    return res.status(400).json({ error: 'Missing fields' });
  if (String(telegram_id) === String(defender_telegram_id))
    return res.status(400).json({ error: 'Нельзя атаковать себя' });
  if (!rateLimit(telegram_id, 10))
    return res.status(429).json({ error: 'Too many requests' });

  const { player: attacker, error: aErr } = await getPlayerByTelegramId(
    telegram_id, 'id,telegram_id,game_username,avatar,level,xp,coins,bonus_attack,bonus_hp,bonus_crit,equipped_sword'
  );
  if (aErr || !attacker) return res.status(404).json({ error: 'Attacker not found' });

  const { player: defender, error: dErr } = await getPlayerByTelegramId(
    defender_telegram_id, 'id,telegram_id,game_username,avatar,level,xp,coins,bonus_attack,bonus_hp,bonus_crit,equipped_sword,shield_until,last_lat,last_lng'
  );
  if (dErr || !defender) return res.status(404).json({ error: 'Defender not found' });

  // Distance check
  const pLat = parseFloat(lat), pLng = parseFloat(lng);
  const dist = haversine(pLat, pLng, defender.last_lat, defender.last_lng);
  if (dist > LARGE_RADIUS) return res.status(400).json({ error: 'Слишком далеко', distance: Math.round(dist) });

  // Shield check
  if (defender.shield_until && new Date(defender.shield_until) > new Date())
    return res.status(400).json({ error: 'Игрок под защитой', shield_until: defender.shield_until });

  // Cooldown check
  const { data: cd } = await supabase.from('pvp_cooldowns')
    .select('expires_at')
    .eq('attacker_id', attacker.id).eq('defender_id', defender.id)
    .gt('expires_at', new Date().toISOString()).maybeSingle();
  if (cd) {
    const mins = Math.ceil((new Date(cd.expires_at) - Date.now()) / 60000);
    return res.status(400).json({ error: `Реванш заблокирован ещё ${mins}м` });
  }

  // Get equipped weapons
  const [{ data: atkItems }, { data: defItems }] = await Promise.all([
    supabase.from('items').select('type,attack,crit_chance,emoji,rarity,name,defense')
      .eq('owner_id', attacker.id).eq('equipped', true),
    supabase.from('items').select('type,attack,crit_chance,emoji,rarity,name,defense')
      .eq('owner_id', defender.id).eq('equipped', true),
  ]);
  const atkWeapon = (atkItems || []).find(i => i.type === 'sword' || i.type === 'axe');
  const defWeapon = (defItems || []).find(i => i.type === 'sword' || i.type === 'axe');
  const atkShield = (atkItems || []).find(i => i.type === 'shield');
  const defShield = (defItems || []).find(i => i.type === 'shield');

  // Simulate battle
  const battleResult = simulateBattle(attacker, defender, atkWeapon, defWeapon);
  const winnerIsAttacker = battleResult.winner === 'attacker';
  const loser = winnerIsAttacker ? defender : attacker;
  const winner = winnerIsAttacker ? attacker : defender;

  const coinsLost = Math.round((loser.coins || 0) * 0.1);
  const coinsWon = Math.round(coinsLost * 0.5);
  const xpGain = 100 + (winner.level || 1) * 10;

  // Apply results — optimistic locking on coins
  const [loserUpdate, winnerUpdate] = await Promise.all([
    supabase.from('players').update({
      coins: Math.max(0, (loser.coins || 0) - coinsLost),
      shield_until: new Date(Date.now() + 1 * 60 * 1000).toISOString(),
    }).eq('id', loser.id).eq('coins', loser.coins || 0),
    supabase.from('players').update({
      coins: (winner.coins || 0) + coinsWon,
      last_fight_at: new Date().toISOString(),
    }).eq('id', winner.id).eq('coins', winner.coins || 0),
  ]);

  // Add XP to winner
  let xpResult = null;
  try { xpResult = await addXp(winner.id, xpGain); } catch (_) {}

  // Cooldown: 30 min both directions
  const cdExpires = new Date(Date.now() + 1 * 60 * 1000).toISOString();
  await supabase.from('pvp_cooldowns').upsert([
    { attacker_id: attacker.id, defender_id: defender.id, expires_at: cdExpires },
    { attacker_id: defender.id, defender_id: attacker.id, expires_at: cdExpires },
  ]);

  // Log the fight
  await supabase.from('pvp_log').insert({
    attacker_id: attacker.id, defender_id: defender.id,
    winner_id: winner.id,
    attacker_hp_left: battleResult.attackerHpLeft,
    defender_hp_left: battleResult.defenderHpLeft,
    rounds: battleResult.rounds,
    coins_transferred: coinsWon,
  });

  // Notify defender with full battle data for animation
  const notifMsg = winnerIsAttacker
    ? `⚔️ ${attacker.game_username || 'Игрок'} победил вас! -${coinsLost} монет`
    : `🏆 Вы отразили атаку ${attacker.game_username || 'Игрок'}! Противник потерял монеты.`;
  const battlePayload = {
    battle: battleResult,
    attacker: {
      telegram_id: attacker.telegram_id,
      username: attacker.game_username, avatar: attacker.avatar, level: attacker.level,
      weapon: atkWeapon ? { emoji: atkWeapon.emoji, type: atkWeapon.type, name: atkWeapon.name, rarity: atkWeapon.rarity, attack: atkWeapon.attack } : null,
      shield: atkShield ? { emoji: atkShield.emoji, name: atkShield.name, defense: atkShield.defense } : null,
      bonusHp: attacker.bonus_hp || 0,
    },
    defender: {
      telegram_id: defender.telegram_id,
      username: defender.game_username, avatar: defender.avatar, level: defender.level,
      weapon: defWeapon ? { emoji: defWeapon.emoji, type: defWeapon.type, name: defWeapon.name, rarity: defWeapon.rarity, attack: defWeapon.attack } : null,
      shield: defShield ? { emoji: defShield.emoji, name: defShield.name, defense: defShield.defense } : null,
      bonusHp: defender.bonus_hp || 0,
    },
    winner: battleResult.winner,
    coinsLost, coinsWon, xpGain,
  };
  await supabase.from('notifications').insert({
    player_id: defender.id, type: 'pvp_battle', message: notifMsg,
    data: battlePayload,
  });

  // Telegram notification to defender
  sendTelegramNotification(defender.telegram_id, notifMsg);

  // Update kills/deaths
  await Promise.all([
    supabase.from('players').update({ kills: (winner.kills ?? 0) + 1 }).eq('id', winner.id),
    supabase.from('players').update({ deaths: (loser.deaths ?? 0) + 1 }).eq('id', loser.id),
  ]);

  return res.json({
    success: true,
    battle: battleResult,
    attacker: {
      telegram_id: attacker.telegram_id,
      username: attacker.game_username, avatar: attacker.avatar, level: attacker.level,
      weapon: atkWeapon ? { emoji: atkWeapon.emoji, type: atkWeapon.type, name: atkWeapon.name, rarity: atkWeapon.rarity, attack: atkWeapon.attack } : null,
      shield: atkShield ? { emoji: atkShield.emoji, name: atkShield.name, defense: atkShield.defense } : null,
      bonusHp: attacker.bonus_hp || 0,
    },
    defender: {
      telegram_id: defender.telegram_id,
      username: defender.game_username, avatar: defender.avatar, level: defender.level,
      weapon: defWeapon ? { emoji: defWeapon.emoji, type: defWeapon.type, name: defWeapon.name, rarity: defWeapon.rarity, attack: defWeapon.attack } : null,
      shield: defShield ? { emoji: defShield.emoji, name: defShield.name, defense: defShield.defense } : null,
      bonusHp: defender.bonus_hp || 0,
    },
    winner: battleResult.winner,
    coinsLost, coinsWon, xpGain,
    xp: xpResult,
  });
}

// ── PVP FLEE ─────────────────────────────────────────────────────────────────
async function handlePvpFlee(req, res) {
  const { telegram_id, attacker_telegram_id } = req.body || {};
  if (!telegram_id || !attacker_telegram_id)
    return res.status(400).json({ error: 'Missing fields' });

  const { player, error: pErr } = await getPlayerByTelegramId(
    telegram_id, 'id,coins'
  );
  if (pErr || !player) return res.status(404).json({ error: 'Player not found' });

  const fleeCost = Math.round((player.coins || 0) * 0.03);
  const { error: upErr } = await supabase.from('players')
    .update({ coins: Math.max(0, (player.coins || 0) - fleeCost) })
    .eq('id', player.id).eq('coins', player.coins || 0);

  if (upErr) return res.status(500).json({ error: 'Failed to flee' });
  return res.json({ success: true, fleeCost, coinsLeft: Math.max(0, (player.coins || 0) - fleeCost) });
}

// ── INIT ────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  console.log('[init] start', { action: req.body?.action, tg: req.body?.telegram_id });

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error('[init] Missing env vars!');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const { action } = req.body || {};
  if (action === 'avatar')       return handleAvatar(req, res);
  if (action === 'location')     return handleLocation(req, res);
  if (action === 'set-username') return handleSetUsername(req, res);
  if (action === 'pvp-initiate') return handlePvpInitiate(req, res);
  if (action === 'pvp-flee')     return handlePvpFlee(req, res);
  if (action === 'pvp-reset') {
    // Admin: clear all cooldowns and shields
    const ADMIN_TG = 560013667;
    let tg; try { tg = parseTgId(req.body.telegram_id); } catch(_) {}
    if (tg !== ADMIN_TG) return res.status(403).json({ error: 'Admin only' });
    const [cd, sh] = await Promise.all([
      supabase.from('pvp_cooldowns').delete().gt('expires_at', '1900-01-01'),
      supabase.from('players').update({ shield_until: null }).not('shield_until', 'is', null),
    ]);
    return res.json({ success: true, cooldowns_deleted: !cd.error, shields_reset: !sh.error });
  }

  // Default: full player init
  const { telegram_id, username } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });

  const ADMIN_TG_ID = 560013667;
  let tgId;
  try { tgId = parseTgId(telegram_id); } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  console.log('[init] step 1 - maintenance check');
  // Maintenance mode check — admin always bypasses
  if (tgId !== ADMIN_TG_ID) {
    const { data: setting } = await supabase
      .from('app_settings').select('value').eq('key', 'maintenance_mode').single();
    if (setting?.value === 'true') return res.status(503).json({ maintenance: true });
  }
  console.log('[init] step 1 done');

  // Helper: reject if DB takes more than 5s
  const withTimeout = (promise) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 5000)),
  ]);

  console.log('[init] step 2 - upsert player');
  let player;
  try {
    const { data, error: playerError } = await withTimeout(
      supabase
        .from('players')
        .upsert(
          { telegram_id: tgId, username: username || null },
          { onConflict: 'telegram_id', ignoreDuplicates: false }
        )
        .select('id,telegram_id,username,game_username,username_changes,avatar,level,xp,hp,max_hp,bonus_attack,bonus_hp,kills,deaths,diamonds,coins,equipped_sword,equipped_shield,respawn_until,starting_bonus_claimed,last_hp_regen,shield_until,clan_id,clan_role')
        .single()
    );
    if (playerError) throw new Error(playerError.message);
    player = data;
  } catch (err) {
    console.error('[init] step 2 error:', err.message);
    return res.status(503).json({
      error: 'DB unavailable',
      message: 'Сервер временно недоступен, попробуй через минуту',
    });
  }
  console.log('[init] step 2 done, player id:', player.id);

  // ── Ban check (separate query — columns may not exist yet) ──
  try {
    const { data: banData } = await supabase
      .from('players')
      .select('is_banned,ban_reason,ban_until')
      .eq('id', player.id)
      .single();

    if (banData?.is_banned) {
      const bannedForever = !banData.ban_until;
      const bannedUntil = banData.ban_until ? new Date(banData.ban_until) : null;
      const stillBanned = bannedForever || bannedUntil > new Date();

      if (stillBanned) {
        return res.status(403).json({
          banned: true,
          reason: banData.ban_reason,
          until: banData.ban_until,
          avatar: player.avatar,
        });
      } else {
        await supabase.from('players').update({
          is_banned: false, ban_reason: null, ban_until: null,
        }).eq('id', player.id);
      }
    }
  } catch (_banErr) {
    // Ban columns don't exist yet — skip check
  }

  console.log('[init] step 3 - fetch hq + mines + inventory + notifications');
  let headquarters, mines, inventory, notifications;
  try {
    const [hqRes, minesRes, itemsRes, notifRes] = await withTimeout(Promise.all([
      supabase.from('headquarters').select('id,lat,lng,level,player_id,coins').eq('player_id', player.id).order('created_at', { ascending: true }).limit(1).maybeSingle(),
      supabase.from('mines').select('id,lat,lng,level,owner_id,cell_id,upgrade_finish_at,pending_level,last_collected,hp,max_hp,last_hp_update,status,burning_started_at,attacker_id,attack_ends_at').eq('owner_id', player.id),
      supabase.from('items').select('id,type,rarity,name,emoji,stat_value,attack,crit_chance,defense,equipped,on_market,obtained_at').eq('owner_id', player.id).order('obtained_at', { ascending: false }),
      supabase.from('notifications').select('id,type,message,data,created_at').eq('player_id', player.id).eq('read', false).order('created_at', { ascending: false }).limit(20),
    ]));
    headquarters  = hqRes.data;
    mines         = (minesRes.data || []).map(m => {
      const cMax = getMineHp(m.level);
      const rph = getMineHpRegen(m.level);
      const rawHp = Math.min(m.hp ?? cMax, cMax);
      return { ...m, max_hp: cMax, hp: calcMineHpRegen(rawHp, cMax, rph, m.last_hp_update), hp_regen: rph };
    });
    inventory     = itemsRes.data;
    notifications = notifRes.data;
  } catch (err) {
    console.error('[init] step 3 error:', err.message);
    return res.status(503).json({
      error: 'DB unavailable',
      message: 'Сервер временно недоступен, попробуй через минуту',
    });
  }
  console.log('[init] step 3 done, mines:', mines?.length, 'inventory:', inventory?.length);

  const level  = player.level ?? 1;
  const xp     = player.xp    ?? 0;
  const maxHp  = 100 + (player.bonus_hp ?? 0);
  const attack = 10 + (player.bonus_attack ?? 0);

  console.log('[init] step 4 - hp regen update');
  let currentHp    = player.hp ?? maxHp;
  let regenApplied = false;
  if (currentHp > maxHp) { currentHp = maxHp; regenApplied = true; }
  if (currentHp < maxHp) {
    const regenedHp = calcHpRegen(currentHp, maxHp, player.last_hp_regen);
    if (regenedHp !== currentHp) { currentHp = regenedHp; regenApplied = true; }
  }
  if (player.hp == null || player.max_hp !== maxHp || regenApplied) {
    await supabase.from('players').update({
      hp: currentHp, max_hp: maxHp, last_hp_regen: new Date().toISOString(),
    }).eq('id', player.id);
  }
  console.log('[init] step 4 done');

  const { total: totalIncome } = await calcTotalIncomeWithClanBonus(mines || [], getMineIncome, player.clan_id, supabase);

  const needUsername = !player.game_username;

  // Mark fetched notifications as read
  const unreadNotifs = notifications || [];
  if (unreadNotifs.length > 0) {
    supabase.from('notifications')
      .update({ read: true })
      .in('id', unreadNotifs.map(n => n.id))
      .then(() => {})
      .catch(() => {});
  }

  console.log('[init] sending response');
  return res.status(200).json({
    needUsername,
    player: {
      ...player,
      level,
      xp,
      xpForNextLevel: xpForLevel(level),
      smallRadius:    SMALL_RADIUS,
      largeRadius:    LARGE_RADIUS,
      hp:             currentHp,
      max_hp:         maxHp,
      attack,
      kills:          player.kills        ?? 0,
      deaths:         player.deaths       ?? 0,
      diamonds:       player.diamonds     ?? 0,
      bonus_attack:   player.bonus_attack ?? 0,
      bonus_hp:       player.bonus_hp     ?? 0,
      coins:          player.coins        ?? 0,
    },
    headquarters: headquarters || null,
    mines:        mines        || [],
    totalIncome,
    inventory:    inventory    || [],
    notifications: unreadNotifs,
  });
}
