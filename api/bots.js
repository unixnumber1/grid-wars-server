import { supabase, getPlayerByTelegramId } from '../lib/supabase.js';
import { BOT_TYPES, getRandomBotType, getRandomReward } from '../lib/bots.js';
import { haversine } from '../lib/haversine.js';
import { addXp } from '../lib/xp.js';
import { getHQLimit, getBuildRadius, getMaxHp, getPlayerAttack, calcHpRegen } from '../lib/formulas.js';

const BOTS_PER_ZONE = 10;          // target bot count within 2km of each player
const BOT_TTL_MS    = 5 * 60 * 1000; // bots expire after 5 minutes

// Speed in metres per move tick
const SPEED_METERS = { slow: 15, medium: 30, fast: 55, very_fast: 90 };

// Max coins an undead bot will drain before leaving
const DRAIN_LIMITS = {
  spirit: 50, goblin: 150, werewolf: 400,
  demon: 1000, dragon: 3000, boss: 10000,
};

// ── SPAWN ──────────────────────────────────────────────────────────────────
// Each player has their own 2km zone. Always keep 10 bots in that zone.
// No global cap — each player's zone is independent.
async function handleSpawn(player, body) {
  const { lat, lng } = body;
  if (lat == null || lng == null) return { status: 400, error: 'lat, lng required' };

  const playerLat = parseFloat(lat);
  const playerLng = parseFloat(lng);
  if (isNaN(playerLat) || isNaN(playerLng) || playerLat === 0)
    return { status: 400, error: 'Invalid coordinates' };

  const now      = new Date().toISOString();
  const ZONE_M   = 2000; // 2km zone radius
  const PAD_DEG  = 0.025; // slightly larger than 2km for DB pre-filter

  // Count active bots within 2km (bbox pre-filter, then haversine)
  const { data: nearbyRows } = await supabase
    .from('bots')
    .select('id, lat, lng')
    .gt('expires_at', now)
    .gte('lat', playerLat - PAD_DEG).lte('lat', playerLat + PAD_DEG)
    .gte('lng', playerLng - PAD_DEG).lte('lng', playerLng + PAD_DEG);

  const botsInZone = (nearbyRows || []).filter(
    b => haversine(playerLat, playerLng, b.lat, b.lng) <= ZONE_M
  );

  console.log('[spawn] total bots in DB near player:', botsInZone.length);

  // Global cap: don't spawn if DB already has too many bots
  const { count: globalCount } = await supabase
    .from('bots').select('*', { count: 'exact', head: true })
    .gt('expires_at', now);
  if ((globalCount || 0) > 30) return { skipped: true, reason: 'too many bots', spawned: 0 };

  const needed = Math.max(0, BOTS_PER_ZONE - botsInZone.length);
  if (needed === 0) return { spawned: 0, bots: [] };

  console.log('[spawn] attempting to spawn near:', playerLat.toFixed(4), playerLng.toFixed(4), '— need:', needed);

  const cosLat    = Math.cos(playerLat * Math.PI / 180);
  const expiresAt = new Date(Date.now() + BOT_TTL_MS).toISOString();
  const newBots   = [];

  for (let i = 0; i < needed; i++) {
    const type  = getRandomBotType();
    const cfg   = BOT_TYPES[type];
    const angle = Math.random() * 2 * Math.PI;
    // Spawn in ring 500m–2000m from player (in metres, converted to degrees)
    const distM   = 500 + Math.random() * 1500;
    const distLat = distM / 111000;
    const distLng = distM / (111000 * (cosLat || 1));

    const botLat = playerLat + Math.cos(angle) * distLat;
    const botLng = playerLng + Math.sin(angle) * distLng;

    newBots.push({
      type, category: cfg.category, emoji: cfg.emoji,
      lat: botLat, lng: botLng,
      spawn_lat: botLat, spawn_lng: botLng,
      direction:       Math.random() * 2 * Math.PI,
      status:          'roaming',
      drained_amount:  0,
      drain_limit:     DRAIN_LIMITS[type] || 0,
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
      expires_at:      expiresAt,
    });
  }

  const { data: bots, error } = await supabase.from('bots').insert(newBots).select();
  if (error) {
    console.error('[spawn] insert error:', error.message);
    return { status: 500, error: error.message };
  }
  console.log('[spawn] spawned:', bots.length, 'bots');
  return { spawned: bots.length, bots };
}

// ── MOVE ───────────────────────────────────────────────────────────────────
// Moves ALL bots globally. Undead have roaming/attacking/leaving state machine.
// Called every 10s from each client — global lock ensures max 1 move per 8s.
async function handleMove(player, body) {
  // Global lock: skip if another client already ran move in last 8s
  const { data: moveSetting } = await supabase
    .from('app_settings').select('value').eq('key', 'last_bots_move').single();
  const lastMove = parseInt(moveSetting?.value || '0');
  const nowMs    = Date.now();
  if (nowMs - lastMove < 8000) return { skipped: true, bots: [] };
  await supabase.from('app_settings')
    .update({ value: nowMs.toString() }).eq('key', 'last_bots_move');

  const now = new Date().toISOString();

  const { data: bots, error } = await supabase
    .from('bots').select('*').gt('expires_at', now);

  if (error) return { status: 500, error: error.message };
  console.log('[move] bots to move:', bots?.length);
  if (!bots?.length) {
    await supabase.from('bots').delete().lt('expires_at', now);
    return { bots: [] };
  }

  // Fetch all mines once — needed for undead targeting
  const { data: allMines } = await supabase
    .from('mines').select('id, lat, lng, owner_id');
  const mineMap = {};
  for (const m of (allMines || [])) mineMap[m.id] = m;

  const updates      = [];
  const minesToDrain = new Map(); // mineId → drainAmount

  for (const bot of bots) {
    const cfg     = BOT_TYPES[bot.type] || {};
    const speedM  = SPEED_METERS[cfg.speed || bot.speed] || 30;
    const cosLat  = Math.cos(bot.lat * Math.PI / 180);
    const stepLat = speedM / 111000;
    const stepLng = speedM / (111000 * (cosLat || 1));

    const spawnLat = bot.spawn_lat ?? bot.lat;
    const spawnLng = bot.spawn_lng ?? bot.lng;

    let newLat    = bot.lat;
    let newLng    = bot.lng;
    let newDir    = bot.direction ?? Math.random() * Math.PI * 2;
    let newStatus = bot.status   || 'roaming';
    let newTarget = bot.target_mine_id;
    let newDrained = bot.drained_amount || 0;

    const isUndead = bot.category === 'undead';

    // ── Helper: smooth directional step ──────────────────────────
    function smoothStep(dir) {
      const shouldTurn  = Math.random() < 0.05;
      const turnAmount  = (Math.random() - 0.5) * 0.3;
      const d = shouldTurn ? dir + turnAmount : dir;
      return {
        lat: bot.lat + Math.cos(d) * stepLat,
        lng: bot.lng + Math.sin(d) * stepLng,
        dir: d,
      };
    }

    if (isUndead && newStatus === 'attacking' && newTarget) {
      const target = mineMap[newTarget];
      if (!target) {
        // Mine was deleted — back to roaming
        newStatus = 'roaming'; newTarget = null;
        const s = smoothStep(newDir); newLat = s.lat; newLng = s.lng; newDir = s.dir;
      } else {
        const dLat = target.lat - bot.lat;
        const dLng = target.lng - bot.lng;
        const dist = Math.sqrt(dLat * dLat + dLng * dLng);
        newDir     = Math.atan2(dLng, dLat);

        if (dist < 0.0005) {
          // At mine — drain with 20% chance per tick
          if (Math.random() < 0.2) {
            const drainAmt = (bot.drain_per_sec || cfg.drain_per_sec || 0) * 3;
            newDrained += drainAmt;
            if (drainAmt > 0) {
              minesToDrain.set(newTarget, (minesToDrain.get(newTarget) || 0) + drainAmt);
            }
          }
          // Small jitter in place
          newLat = bot.lat + (Math.random() - 0.5) * stepLat * 0.3;
          newLng = bot.lng + (Math.random() - 0.5) * stepLng * 0.3;
          // Leave when drain limit reached
          if ((bot.drain_limit || 0) > 0 && newDrained >= bot.drain_limit) {
            newStatus = 'leaving'; newTarget = null;
          }
        } else {
          newLat = bot.lat + Math.cos(newDir) * stepLat;
          newLng = bot.lng + Math.sin(newDir) * stepLng;
        }
      }

    } else if (isUndead && newStatus === 'leaving') {
      const s = smoothStep(newDir); newLat = s.lat; newLng = s.lng; newDir = s.dir;
      // ~10s to return: 1/(3s tick × 0.09) ≈ 3.7 ticks ≈ 11s
      if (Math.random() < 0.09) { newStatus = 'roaming'; }

    } else {
      // Roaming (all bots default, neutral always)
      const s = smoothStep(newDir); newLat = s.lat; newLng = s.lng; newDir = s.dir;

      // Undead: 15% per tick to start attacking a random mine
      if (isUndead && allMines?.length > 0 && Math.random() < 0.15) {
        const target = allMines[Math.floor(Math.random() * allMines.length)];
        newStatus = 'attacking'; newTarget = target.id; newDrained = 0;
        newDir = Math.atan2(target.lng - bot.lng, target.lat - bot.lat);
      }
    }

    // 3km boundary check — turn back toward spawn point
    const distFromSpawn = haversine(spawnLat, spawnLng, newLat, newLng);
    if (distFromSpawn > 3000) {
      const backAngle = Math.atan2(spawnLng - bot.lng, spawnLat - bot.lat)
        + (Math.random() - 0.5) * 0.5;
      newLat = bot.lat + Math.cos(backAngle) * stepLat;
      newLng = bot.lng + Math.sin(backAngle) * stepLng;
      newDir = backAngle;
    }

    updates.push({
      id: bot.id, lat: newLat, lng: newLng, direction: newDir,
      status: newStatus, target_mine_id: newTarget, drained_amount: newDrained,
    });
  }

  // Write bot positions (always) and state (separate call to isolate schema errors)
  await Promise.all(updates.map(async u => {
    const { error: posErr } = await supabase.from('bots')
      .update({ lat: u.lat, lng: u.lng, direction: u.direction })
      .eq('id', u.id);
    if (posErr) { console.error('[move] position update error:', posErr.message); return; }

    const { error: stateErr } = await supabase.from('bots')
      .update({ status: u.status, target_mine_id: u.target_mine_id, drained_amount: u.drained_amount })
      .eq('id', u.id);
    if (stateErr) console.error('[move] state update error (run SQL migrations):', stateErr.message);
  }));

  // Update last_collected on drained mines (resets their coin accumulation)
  if (minesToDrain.size > 0) {
    await Promise.all([...minesToDrain.keys()].map(mineId =>
      supabase.from('mines').update({ last_collected: now }).eq('id', mineId)
    ));
  }

  // Purge expired bots
  await supabase.from('bots').delete().lt('expires_at', now);

  // Return bots in caller's viewport
  const updatedBots = bots.map((bot, i) => ({
    ...bot,
    lat:            updates[i].lat,
    lng:            updates[i].lng,
    direction:      updates[i].direction,
    status:         updates[i].status,
    target_mine_id: updates[i].target_mine_id,
    drained_amount: updates[i].drained_amount,
  }));

  const vN = parseFloat(body.north), vS = parseFloat(body.south);
  const vE = parseFloat(body.east),  vW = parseFloat(body.west);
  let nearbyBots;
  if (!isNaN(vN) && !isNaN(vS) && !isNaN(vE) && !isNaN(vW)) {
    nearbyBots = updatedBots.filter(b => b.lat >= vS && b.lat <= vN && b.lng >= vW && b.lng <= vE);
  } else {
    const pLat = parseFloat(body.lat), pLng = parseFloat(body.lng);
    const R    = 0.09;
    nearbyBots = (!isNaN(pLat) && !isNaN(pLng))
      ? updatedBots.filter(b => Math.abs(b.lat - pLat) < R && Math.abs(b.lng - pLng) < R)
      : updatedBots;
  }
  return { bots: nearbyBots };
}

// ── ATTACK ─────────────────────────────────────────────────────────────────
async function handleAttack(player, body) {
  const { bot_id, lat, lng } = body;
  if (!bot_id || lat == null || lng == null) return { status: 400, error: 'bot_id, lat, lng required' };

  // Respawn check
  if (player.respawn_until && new Date(player.respawn_until) > new Date()) {
    const secsLeft = Math.ceil((new Date(player.respawn_until) - Date.now()) / 1000);
    return { status: 400, error: `Возрождение через ${secsLeft} сек` };
  }

  const { data: bot, error: botErr } = await supabase
    .from('bots').select('*').eq('id', bot_id).maybeSingle();
  if (botErr) return { status: 500, error: botErr.message };
  if (!bot)   return { status: 404, error: 'Bot not found' };

  const radius = getBuildRadius(player.level ?? 1);
  const dist   = haversine(parseFloat(lat), parseFloat(lng), bot.lat, bot.lng);
  if (dist > radius) return { status: 400, error: `Подойди ближе (${Math.round(dist)}м > ${radius}м)` };

  const { data: pFull, error: pErr } = await supabase
    .from('players').select('hp, max_hp, last_hp_regen, kills, deaths, level').eq('id', player.id).single();
  if (pErr) return { status: 500, error: pErr.message };

  const lvl       = pFull.level ?? 1;
  const maxHp     = getMaxHp(lvl);
  const playerAtk = getPlayerAttack(lvl);
  let   playerHp  = calcHpRegen(pFull.hp ?? maxHp, maxHp, pFull.last_hp_regen);
  if (playerHp > maxHp) playerHp = maxHp;

  // Player attacks bot
  const isCrit     = Math.random() < 0.2;
  let   damage     = Math.floor(playerAtk * (0.8 + Math.random() * 0.4));
  if (isCrit) damage = Math.floor(damage * 2);

  const botHpAfter = (bot.hp ?? bot.max_hp ?? BOT_TYPES[bot.type]?.hp ?? 50) - damage;
  const result = { damage, isCrit, botDefeated: false, counterDamage: 0, playerDied: false };

  if (botHpAfter <= 0) {
    result.botDefeated = true;
    await supabase.from('bots').delete().eq('id', bot_id);

    const botCfg  = BOT_TYPES[bot.type];
    const xpMult  = botCfg?.category === 'undead' ? 20 : 100;
    const xpGain  = Math.floor((bot.max_hp ?? botCfg?.hp ?? 50) / 5) * xpMult;
    result.xp = await addXp(player.id, xpGain).catch(() => null);

    if (botCfg?.category === 'neutral' && botCfg.reward_max > 0) {
      const reward = getRandomReward(botCfg);
      result.reward = reward;
      const { data: hq } = await supabase
        .from('headquarters').select('id, coins, level').eq('player_id', player.id).maybeSingle();
      if (hq) {
        const newCoins = Math.min(hq.coins + reward, getHQLimit(hq.level ?? 1));
        await supabase.from('headquarters').update({ coins: newCoins }).eq('id', hq.id);
        result.hq_coins = newCoins;
      }
    }

    await supabase.from('players').update({
      hp: playerHp, max_hp: maxHp, last_hp_regen: new Date().toISOString(),
      kills: (pFull.kills ?? 0) + 1,
    }).eq('id', player.id);

  } else {
    await supabase.from('bots').update({ hp: botHpAfter }).eq('id', bot_id);
    result.botHp    = botHpAfter;
    result.botMaxHp = bot.max_hp ?? (botHpAfter + damage);

    const cfg = BOT_TYPES[bot.type];
    if (cfg?.attackChance && Math.random() < cfg.attackChance) {
      const botAtk     = bot.attack ?? cfg.attack ?? 5;
      const counterDmg = Math.floor(botAtk * (0.8 + Math.random() * 0.4));
      result.counterDamage = counterDmg;
      playerHp -= counterDmg;

      if (playerHp <= 0) {
        // Respawn: 10s timer, restore 30% HP
        const respawnHp    = Math.max(1, Math.ceil(maxHp * 0.3));
        const respawnUntil = new Date(Date.now() + 10_000).toISOString();
        result.playerDied  = true;
        result.respawnUntil = respawnUntil;
        playerHp = respawnHp;
        await supabase.from('players').update({
          hp: respawnHp, max_hp: maxHp, last_hp_regen: new Date().toISOString(),
          deaths: (pFull.deaths ?? 0) + 1, respawn_until: respawnUntil,
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
    .from('bots').select('id, lat, lng, coins_drained, category')
    .eq('id', bot_id).maybeSingle();

  if (error) return { status: 500, error: error.message };
  if (!bot)  return { status: 404, error: 'Bot not found' };
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
    .from('bots').select('id, lat, lng, type, category, emoji, reward_min, reward_max')
    .eq('id', bot_id).maybeSingle();

  if (error) return { status: 500, error: error.message };
  if (!bot)  return { status: 404, error: 'Bot not found' };
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
  const xpResult = xpAmount > 0 ? await addXp(player.id, xpAmount).catch(() => null) : null;

  return { reward, emoji: bot.emoji, hq_coins: newCoins, xp: xpResult };
}

// ── ROUTER ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const action = req.method === 'GET' ? req.query.action : req.body?.action;
  if (!action) return res.status(400).json({ error: 'action required' });

  const telegram_id = req.method === 'GET' ? req.query.telegram_id : req.body?.telegram_id;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  // Include respawn_until so handleAttack can check it without extra query
  const { player, error } = await getPlayerByTelegramId(telegram_id, 'id, level, respawn_until');
  if (error) return res.status(500).json({ error });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  let result;
  if      (action === 'spawn')  result = await handleSpawn(player, req.body);
  else if (action === 'move')   result = await handleMove(player, req.body);
  else if (action === 'attack') result = await handleAttack(player, req.body);
  else if (action === 'repel')  result = await handleRepel(player, req.body);
  else if (action === 'lure')   result = await handleLure(player, req.body);
  else return res.status(400).json({ error: `Unknown action: ${action}` });

  const { status = 200, error: resultError, ...data } = result;
  if (resultError) return res.status(status).json({ error: resultError });
  return res.status(status).json(data);
}
