import { supabase, getPlayerByTelegramId } from '../lib/supabase.js';
import { BOT_TYPES, SPEED_STEP, getRandomBotType, getRandomReward } from '../lib/bots.js';
import { haversine } from '../lib/haversine.js';
import { addXp } from '../lib/xp.js';
import { getHQLimit, getBuildRadius, getMaxHp, getPlayerAttack, calcHpRegen } from '../lib/formulas.js';

const MAX_BOTS   = 10;
const BOT_TTL_MS = 10 * 60 * 1000; // 10 min
const BOSS_SPAWN_CHANCE = 0.05;     // 5% chance per spawn cycle

// ── SPAWN ──────────────────────────────────────────────────────────────────
async function handleSpawn(player, body, telegramId) {
  const { lat, lng } = body;
  if (lat == null || lng == null) return { status: 400, error: 'lat, lng required' };

  const playerLat = parseFloat(lat);
  const playerLng = parseFloat(lng);
  const now       = new Date().toISOString();

  const { count } = await supabase
    .from('bots')
    .select('id', { count: 'exact', head: true })
    .eq('spawned_for_player_id', player.id)
    .gt('expires_at', now);

  const toSpawn = Math.max(0, MAX_BOTS - (count || 0));
  if (toSpawn === 0) return { spawned: 0, bots: [] };

  const cosLat  = Math.cos(playerLat * Math.PI / 180);
  const newBots = [];

  for (let i = 0; i < toSpawn; i++) {
    const type    = getRandomBotType();
    const cfg     = BOT_TYPES[type];
    const angle   = Math.random() * 2 * Math.PI;
    const distDeg = 0.009 + Math.random() * 0.036;
    const botLat  = playerLat + distDeg * Math.cos(angle);
    const botLng  = playerLng + (distDeg / (cosLat || 1)) * Math.sin(angle);

    newBots.push({
      type, category: cfg.category, emoji: cfg.emoji,
      lat: botLat, lng: botLng,
      spawned_for_player_id: player.id,
      target_mine_id:  null,
      reward_min:      cfg.reward_min,
      reward_max:      cfg.reward_max,
      drain_per_sec:   cfg.drain_per_sec,
      speed:           cfg.speed,
      hp:              cfg.hp,
      max_hp:          cfg.hp,
      attack:          cfg.attack,
      size:            cfg.size,
      expires_at:      new Date(Date.now() + BOT_TTL_MS).toISOString(),
    });
  }

  // Boss spawn attempt (5% chance, limited to 1 globally)
  if (Math.random() < BOSS_SPAWN_CHANCE) {
    const { count: bossCount } = await supabase
      .from('bots')
      .select('id', { count: 'exact', head: true })
      .eq('type', 'boss')
      .gt('expires_at', now);

    if ((bossCount || 0) === 0) {
      const cfg   = BOT_TYPES.boss;
      const angle = Math.random() * 2 * Math.PI;
      const dist  = 0.015 + Math.random() * 0.02;
      newBots.push({
        type: 'boss', category: cfg.category, emoji: cfg.emoji,
        lat: playerLat + dist * Math.cos(angle),
        lng: playerLng + (dist / (cosLat || 1)) * Math.sin(angle),
        spawned_for_player_id: player.id,
        target_mine_id: null,
        reward_min: 0, reward_max: 0,
        drain_per_sec: cfg.drain_per_sec,
        speed: cfg.speed,
        hp: cfg.hp, max_hp: cfg.hp,
        attack: cfg.attack, size: cfg.size,
        expires_at: new Date(Date.now() + BOT_TTL_MS).toISOString(),
      });

      // Telegram notification
      if (process.env.BOT_TOKEN && telegramId) {
        const msg = encodeURIComponent('💀 БОСС появился рядом с тобой! Атакуй его немедленно!');
        fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage?chat_id=${telegramId}&text=${msg}`)
          .catch(() => {});
      }
    }
  }

  const { data: bots, error } = await supabase.from('bots').insert(newBots).select();
  if (error) return { status: 500, error: error.message };
  return { spawned: bots.length, bots };
}

// ── NEARBY ─────────────────────────────────────────────────────────────────
async function handleNearby(player, query) {
  const { lat, lng } = query;
  if (lat == null || lng == null) return { status: 400, error: 'lat, lng required' };

  const playerLat = parseFloat(lat);
  const playerLng = parseFloat(lng);
  const now       = new Date().toISOString();

  const { data: bots, error } = await supabase
    .from('bots')
    .select('id, type, emoji, category, lat, lng, coins_drained, drain_per_sec, reward_min, reward_max, target_mine_id, speed, hp, max_hp, attack, size')
    .eq('spawned_for_player_id', player.id)
    .gt('expires_at', now)
    .gte('lat', playerLat - 0.045).lte('lat', playerLat + 0.045)
    .gte('lng', playerLng - 0.08 ).lte('lng', playerLng + 0.08);

  if (error) return { status: 500, error: error.message };
  return { bots: bots || [] };
}

// ── MOVE ───────────────────────────────────────────────────────────────────
async function handleMove(player, body) {
  const now = new Date().toISOString();

  await supabase.from('bots').delete()
    .eq('spawned_for_player_id', player.id).lt('expires_at', now);

  const { data: bots, error } = await supabase
    .from('bots').select('*')
    .eq('spawned_for_player_id', player.id).gt('expires_at', now);

  if (error) return { status: 500, error: error.message };
  if (!bots?.length) return { bots: [] };

  const { data: mines } = await supabase
    .from('mines').select('id, lat, lng').eq('owner_id', player.id);

  const updates        = [];
  const drainedMineIds = new Set();

  for (const bot of bots) {
    const step   = SPEED_STEP[bot.speed] || 0.0005;
    const cfg    = BOT_TYPES[bot.type];
    let newLat   = bot.lat + (Math.random() - 0.5) * step * 2;
    let newLng   = bot.lng + (Math.random() - 0.5) * step * 2;
    let newCoins = bot.coins_drained || 0;

    // Undead: check proximity to mines and drain via attackChance
    if (bot.category === 'undead' && mines?.length > 0) {
      for (const mine of mines) {
        const d = Math.hypot(mine.lat - bot.lat, mine.lng - bot.lng);
        if (d < 0.0007 && Math.random() < (cfg?.attackChance || 0.3)) {
          newCoins += bot.drain_per_sec * 2;
          drainedMineIds.add(mine.id);
        }
      }
    }

    updates.push({ id: bot.id, lat: newLat, lng: newLng, coins_drained: newCoins });
  }

  await Promise.all(updates.map(u =>
    supabase.from('bots')
      .update({ lat: u.lat, lng: u.lng, coins_drained: u.coins_drained })
      .eq('id', u.id)
  ));

  if (drainedMineIds.size > 0) {
    await supabase.from('mines').update({ last_collected: now }).in('id', [...drainedMineIds]);
  }

  return {
    bots: bots.map((bot, i) => ({
      ...bot,
      lat:           updates[i].lat,
      lng:           updates[i].lng,
      coins_drained: updates[i].coins_drained,
    })),
  };
}

// ── ATTACK ─────────────────────────────────────────────────────────────────
async function handleAttack(player, body) {
  const { bot_id, lat, lng } = body;
  if (!bot_id || lat == null || lng == null) return { status: 400, error: 'bot_id, lat, lng required' };

  const { data: bot, error: botErr } = await supabase
    .from('bots').select('*').eq('id', bot_id).maybeSingle();
  if (botErr) return { status: 500, error: botErr.message };
  if (!bot)   return { status: 404, error: 'Bot not found' };
  if (bot.spawned_for_player_id !== player.id) return { status: 403, error: 'Not your bot' };

  const radius = getBuildRadius(player.level ?? 1);
  const dist   = haversine(parseFloat(lat), parseFloat(lng), bot.lat, bot.lng);
  if (dist > radius) return { status: 400, error: `Подойди ближе (${Math.round(dist)}м > ${radius}м)` };

  // Get full player data
  const { data: pFull, error: pErr } = await supabase
    .from('players').select('hp, max_hp, last_hp_regen, kills, deaths, level').eq('id', player.id).single();
  if (pErr) return { status: 500, error: pErr.message };

  const lvl         = pFull.level ?? 1;
  const maxHp       = getMaxHp(lvl);
  const playerAtk   = getPlayerAttack(lvl);
  let   playerHp    = pFull.hp ?? maxHp;
  if (playerHp > maxHp) playerHp = maxHp;

  // Apply HP regen
  playerHp = calcHpRegen(playerHp, maxHp, pFull.last_hp_regen);

  // Player attacks bot
  const isCrit  = Math.random() < 0.2;
  let   damage  = Math.floor(playerAtk * (0.8 + Math.random() * 0.4));
  if (isCrit) damage = Math.floor(damage * 2);

  const botHpAfter = (bot.hp ?? bot.max_hp ?? BOT_TYPES[bot.type]?.hp ?? 50) - damage;
  const result = { damage, isCrit, botDefeated: false, counterDamage: 0, playerDied: false };

  if (botHpAfter <= 0) {
    // Bot defeated
    result.botDefeated = true;
    await supabase.from('bots').delete().eq('id', bot_id);

    // XP reward based on bot max HP
    const xpGain  = Math.floor((bot.max_hp ?? BOT_TYPES[bot.type]?.hp ?? 50) / 5);
    const xpResult = await addXp(player.id, xpGain).catch(() => null);
    result.xp = xpResult;

    // Coin reward for neutral bots
    const cfg = BOT_TYPES[bot.type];
    if (cfg?.category === 'neutral' && cfg.reward_max > 0) {
      const reward = getRandomReward(cfg);
      result.reward = reward;
      const { data: hq } = await supabase
        .from('headquarters').select('id, coins, level').eq('player_id', player.id).maybeSingle();
      if (hq) {
        const newCoins = Math.min(hq.coins + reward, getHQLimit(hq.level ?? 1));
        await supabase.from('headquarters').update({ coins: newCoins }).eq('id', hq.id);
        result.hq_coins = newCoins;
      }
    }

    // Increment kills
    await supabase.from('players').update({
      hp: playerHp, max_hp: maxHp, last_hp_regen: new Date().toISOString(),
      kills: (pFull.kills ?? 0) + 1,
    }).eq('id', player.id);

  } else {
    // Bot survived — update bot HP
    await supabase.from('bots').update({ hp: botHpAfter }).eq('id', bot_id);
    result.botHp    = botHpAfter;
    result.botMaxHp = bot.max_hp ?? (botHpAfter + damage);

    // Bot counterattacks
    const cfg = BOT_TYPES[bot.type];
    if (cfg?.attackChance && Math.random() < cfg.attackChance) {
      const botAtk      = bot.attack ?? cfg.attack ?? 5;
      const counterDmg  = Math.floor(botAtk * (0.8 + Math.random() * 0.4));
      result.counterDamage = counterDmg;
      playerHp -= counterDmg;

      if (playerHp <= 0) {
        result.playerDied = true;
        playerHp = maxHp; // respawn at full HP
        await supabase.from('players').update({
          hp: maxHp, max_hp: maxHp, last_hp_regen: new Date().toISOString(),
          deaths: (pFull.deaths ?? 0) + 1,
        }).eq('id', player.id);
      } else {
        await supabase.from('players').update({
          hp: playerHp, max_hp: maxHp, last_hp_regen: new Date().toISOString(),
        }).eq('id', player.id);
      }
    } else {
      await supabase.from('players').update({
        hp: playerHp, max_hp: maxHp, last_hp_regen: new Date().toISOString(),
      }).eq('id', player.id);
    }
  }

  result.playerHp    = playerHp;
  result.playerMaxHp = maxHp;
  return result;
}

// ── REPEL ──────────────────────────────────────────────────────────────────
async function handleRepel(player, body) {
  const { bot_id, lat, lng } = body;
  if (!bot_id || lat == null || lng == null) return { status: 400, error: 'bot_id, lat, lng required' };

  const { data: bot, error } = await supabase
    .from('bots').select('id, lat, lng, coins_drained, category, spawned_for_player_id')
    .eq('id', bot_id).maybeSingle();

  if (error) return { status: 500, error: error.message };
  if (!bot) return { status: 404, error: 'Bot not found' };
  if (bot.spawned_for_player_id !== player.id) return { status: 403, error: 'Not your bot' };
  if (bot.category !== 'undead') return { status: 400, error: 'Can only repel undead' };

  const radius = getBuildRadius(player.level ?? 1);
  const dist   = haversine(parseFloat(lat), parseFloat(lng), bot.lat, bot.lng);
  if (dist > radius) return { status: 400, error: `Подойди ближе (${Math.round(dist)}м > ${radius}м)` };

  const { error: delErr } = await supabase.from('bots').delete().eq('id', bot_id);
  if (delErr) return { status: 500, error: delErr.message };
  return { success: true, coins_drained: bot.coins_drained || 0 };
}

// ── LURE ───────────────────────────────────────────────────────────────────
async function handleLure(player, body) {
  const { bot_id, lat, lng } = body;
  if (!bot_id || lat == null || lng == null) return { status: 400, error: 'bot_id, lat, lng required' };

  const { data: bot, error } = await supabase
    .from('bots').select('id, lat, lng, type, category, emoji, reward_min, reward_max, spawned_for_player_id')
    .eq('id', bot_id).maybeSingle();

  if (error) return { status: 500, error: error.message };
  if (!bot) return { status: 404, error: 'Bot not found' };
  if (bot.spawned_for_player_id !== player.id) return { status: 403, error: 'Not your bot' };
  if (bot.category !== 'neutral') return { status: 400, error: 'Can only lure neutral bots' };

  const radius = getBuildRadius(player.level ?? 1);
  const dist   = haversine(parseFloat(lat), parseFloat(lng), bot.lat, bot.lng);
  if (dist > radius) return { status: 400, error: `Подойди ближе (${Math.round(dist)}м > ${radius}м)` };

  const cfg    = BOT_TYPES[bot.type] || { reward_min: bot.reward_min, reward_max: bot.reward_max };
  const reward = getRandomReward(cfg);

  const { data: hq, error: hqErr } = await supabase
    .from('headquarters').select('id, coins, level').eq('player_id', player.id).maybeSingle();
  if (hqErr || !hq) return { status: 404, error: 'HQ not found' };

  const newCoins = Math.min(hq.coins + reward, getHQLimit(hq.level ?? 1));
  const [{ error: hqUpdErr }, { error: delErr }] = await Promise.all([
    supabase.from('headquarters').update({ coins: newCoins }).eq('id', hq.id),
    supabase.from('bots').delete().eq('id', bot_id),
  ]);
  if (hqUpdErr) return { status: 500, error: hqUpdErr.message };

  const xpAmount = Math.floor(reward / 10);
  let xpResult   = null;
  if (xpAmount > 0) {
    xpResult = await addXp(player.id, xpAmount).catch(() => null);
  }

  return { reward, emoji: bot.emoji, hq_coins: newCoins, xp: xpResult };
}

// ── ROUTER ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const action = req.method === 'GET' ? req.query.action : req.body?.action;

  if (!action) return res.status(400).json({ error: 'action required' });

  const telegram_id = req.method === 'GET' ? req.query.telegram_id : req.body?.telegram_id;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  const { player, error } = await getPlayerByTelegramId(telegram_id, 'id, level');
  if (error) return res.status(500).json({ error });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  let result;
  if      (action === 'spawn')  result = await handleSpawn(player, req.body, telegram_id);
  else if (action === 'nearby') result = await handleNearby(player, req.query);
  else if (action === 'move')   result = await handleMove(player, req.body);
  else if (action === 'attack') result = await handleAttack(player, req.body);
  else if (action === 'repel')  result = await handleRepel(player, req.body);
  else if (action === 'lure')   result = await handleLure(player, req.body);
  else return res.status(400).json({ error: `Unknown action: ${action}` });

  const { status = 200, error: resultError, ...data } = result;
  if (resultError) return res.status(status).json({ error: resultError });
  return res.status(status).json(data);
}
