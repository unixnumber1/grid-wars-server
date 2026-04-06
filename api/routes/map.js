import { Router } from 'express';
import { supabase, getPlayerByTelegramId, parseTgId } from '../../lib/supabase.js';
import { log } from '../../lib/log.js';
import { getCellsInRange } from '../../lib/grid.js';
import { BOT_TYPES, getRandomBotType, getRandomReward } from '../../lib/bots.js';
import { haversine } from '../../lib/haversine.js';
import { addXp, XP_REWARDS } from '../../lib/xp.js';
import { getMineIncome, getMineCapacity, calcHpRegen, xpForLevel, getMineHp, getMineHpRegen, calcMineHpRegen, SMALL_RADIUS, LARGE_RADIUS, MINE_BOOST_RADIUS, getMineCountBoost } from '../../lib/formulas.js';
import { getCoresTotalBoost } from '../../lib/cores.js';
import { getOreIncome } from '../../lib/oreNodes.js';
import { gameState } from '../../lib/gameState.js';
import { getClanLevel, getClanDefenseForMine } from '../../lib/clans.js';
import { getPlayerSkillEffects } from '../../config/skills.js';
import { BOTS_PER_ZONE, BOT_TTL_MS, GLOBAL_BOT_CAP, BOT_SPEED_METERS, DRAIN_LIMITS, ORE_TYPES } from '../../config/constants.js';

const SPEED_METERS = BOT_SPEED_METERS;

async function handleLeaderboard(req, res) {
  const { telegram_id } = req.query;

  if (gameState.loaded) {
    const top = gameState.getLeaderboard(100);
    let current = null;
    if (telegram_id) {
      let tgId;
      try { tgId = parseTgId(telegram_id); } catch (e) { /* ignore */ }
      if (tgId) {
        const inTop = top.find(p => String(p.telegram_id) === String(tgId));
        if (!inTop) {
          const player = gameState.getPlayerByTgId(tgId);
          if (player) {
            let rank = 1;
            for (const p of gameState.players.values()) {
              if ((p.xp || 0) > (player.xp || 0)) rank++;
            }
            current = {
              telegram_id: player.telegram_id,
              username: player.username,
              game_username: player.game_username,
              avatar: player.avatar,
              level: player.level,
              xp: player.xp,
              rank,
              active_badge: player.active_badge || null,
            };
          }
        }
      }
    }
    return res.json({ top, current });
  }

  // Fallback to DB
  const { data: top, error } = await supabase
    .from('players')
    .select('telegram_id, username, game_username, avatar, level, xp')
    .order('xp', { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });

  const ranked = top.map((p, i) => ({ ...p, rank: i + 1 }));

  let current = null;
  if (telegram_id) {
    let tgId;
    try { tgId = parseTgId(telegram_id); } catch (e) { /* ignore */ }
    if (tgId) {
      const inTop = ranked.find(p => String(p.telegram_id) === String(tgId));
      if (!inTop) {
        const { data: player } = await supabase
          .from('players')
          .select('telegram_id, username, game_username, avatar, level, xp')
          .eq('telegram_id', tgId)
          .maybeSingle();
        if (player) {
          const { count } = await supabase
            .from('players')
            .select('*', { count: 'exact', head: true })
            .gt('xp', player.xp);
          current = { ...player, rank: (count || 0) + 1 };
        }
      }
    }
  }

  return res.status(200).json({ top: ranked, current });
}

// ── Unified game tick (POST) ─────────────────────────────────
async function handleTick(req, res) {
  const _t0 = Date.now();
  const { telegram_id, lat, lng, north, south, east, west } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  const n = parseFloat(north), s = parseFloat(south);
  const e = parseFloat(east),  w = parseFloat(west);
  const pLat = parseFloat(lat), pLng = parseFloat(lng);
  const hasBbox = !isNaN(n) && !isNaN(s) && !isNaN(e) && !isNaN(w);
  const hasPos  = !isNaN(pLat) && !isNaN(pLng) && pLat !== 0;

  // Reject overly large bbox
  if (hasBbox && ((n - s) > 0.3 || (e - w) > 0.3)) {
    return res.json({ mines: [], headquarters: [], bots: [], vases: [], online_players: [], couriers: [], courier_drops: [], markets: [] });
  }

  // ── Player lookup ────────────────────────────────────────
  let player = gameState.loaded ? gameState.getPlayerByTgId(telegram_id) : null;
  if (!player) {
    const { player: dbPlayer, error: pErr } = await getPlayerByTelegramId(
      telegram_id,
      'id,telegram_id,username,game_username,avatar,level,xp,hp,max_hp,bonus_attack,bonus_hp,bonus_crit,kills,deaths,diamonds,coins,equipped_sword,equipped_shield,respawn_until,last_hp_regen,shield_until,clan_id,clan_role,is_banned,ban_reason,ban_until'
    );
    if (pErr) return res.status(500).json({ error: pErr });
    if (!dbPlayer) return res.status(404).json({ error: 'Player not found' });
    player = dbPlayer;
    if (gameState.loaded) gameState.upsertPlayer(player);
  }

  // Ban check — kick banned player immediately
  if (player.is_banned) {
    const bannedForever = !player.ban_until;
    const stillBanned = bannedForever || new Date(player.ban_until) > new Date();
    if (stillBanned) {
      return res.status(403).json({ banned: true, reason: player.ban_reason, until: player.ban_until, avatar: player.avatar });
    }
  }

  const currentPlayerId = player.id;
  const nowMs  = Date.now();
  const nowISO = new Date(nowMs).toISOString();

  // ── Auto-clear stale death state ──
  if (player.is_dead) {
    const respawnPassed = !player._respawn_at || nowMs >= new Date(player._respawn_at).getTime();
    if (respawnPassed) {
      player.is_dead = false;
      player.hp = 1000 + (player.bonus_hp || 0);
      player._respawn_at = null;
      player.last_hp_regen = null;
      if (gameState.loaded) gameState.markDirty('players', player.id);
    }
  }

  // ── 1. Update player location (in-memory only, persist loop writes to DB) ──
  if (hasPos) {
    player.last_lat = pLat;
    player.last_lng = pLng;
    player.last_seen = nowISO;
    if (gameState.loaded) gameState.markDirty('players', player.id);
  }

  const _t1 = Date.now();
  // ── 2. Bot spawn (with global cap + per-player cooldown) ──
  const _spawnCd = mapRouter._spawnCooldown || (mapRouter._spawnCooldown = new Map());
  let spawnedBots = [];
  const spawnTgKey = String(telegram_id);
  const lastSpawnMs = _spawnCd.get(spawnTgKey) || 0;
  const canSpawnNow = Date.now() - lastSpawnMs >= 10_000; // 10s cooldown
  if (hasPos && canSpawnNow) {
    try {
      let botsInZone, globalCount;

      if (gameState.loaded) {
        const nearby = gameState.getBotsNearby(pLat, pLng, 2000, nowISO);
        botsInZone = nearby;
        globalCount = gameState.getBotCount(nowISO);
      } else {
        const PAD_DEG = 0.025;
        const [{ data: nearbyRows }, { count: gc }] = await Promise.all([
          supabase.from('bots').select('id,lat,lng')
            .gt('expires_at', nowISO)
            .gte('lat', pLat - PAD_DEG).lte('lat', pLat + PAD_DEG)
            .gte('lng', pLng - PAD_DEG).lte('lng', pLng + PAD_DEG),
          supabase.from('bots').select('*', { count: 'exact', head: true })
            .gt('expires_at', nowISO),
        ]);
        botsInZone = (nearbyRows || []).filter(
          b => haversine(pLat, pLng, b.lat, b.lng) <= 2000
        );
        globalCount = gc || 0;
      }

      const needed = Math.max(0, BOTS_PER_ZONE - botsInZone.length);
      const canSpawn = Math.max(0, GLOBAL_BOT_CAP - globalCount);
      const toSpawn = Math.min(needed, canSpawn);

      if (toSpawn > 0) {
        const cosLat = Math.cos(pLat * Math.PI / 180);
        const expiresAt = new Date(nowMs + BOT_TTL_MS).toISOString();
        const newBots = [];
        for (let i = 0; i < toSpawn; i++) {
          const type = getRandomBotType();
          const cfg  = BOT_TYPES[type];
          const angle = Math.random() * 2 * Math.PI;
          const distM = 500 + Math.random() * 1500;
          const distLat = distM / 111000;
          const distLng = distM / (111000 * (cosLat || 1));
          const botLat = pLat + Math.cos(angle) * distLat;
          const botLng = pLng + Math.sin(angle) * distLng;
          newBots.push({
            type, category: cfg.category, emoji: cfg.emoji,
            lat: botLat, lng: botLng, spawn_lat: botLat, spawn_lng: botLng,
            direction: Math.random() * 2 * Math.PI,
            status: 'roaming', drained_amount: 0,
            drain_limit: DRAIN_LIMITS[type] || 0,
            spawned_for_player_id: currentPlayerId,
            target_mine_id: null,
            reward_min: cfg.reward_min, reward_max: cfg.reward_max,
            drain_per_sec: cfg.drain_per_sec, speed: cfg.speed,
            hp: cfg.hp, max_hp: cfg.hp, attack: cfg.attack, size: cfg.size,
            expires_at: expiresAt,
          });
        }
        const { data: inserted } = await supabase.from('bots').insert(newBots).select(
          'id,type,emoji,category,lat,lng,coins_drained,drain_per_sec,reward_min,reward_max,speed,hp,max_hp,attack,size,status,target_mine_id,drained_amount,direction'
        );
        if (inserted) {
          for (const b of inserted) gameState.addBot(b);
          spawnedBots = inserted;
          _spawnCd.set(spawnTgKey, Date.now());
        }
      }
    } catch (e) { console.error('[tick] spawn error:', e.message); }
  }

  // Bot move and courier move are now handled by gameLoop.js — skip them here.

  // ── 3. Complete upgrades ────────────────────────────────
  let completedUpgrades = [];
  try {
    if (gameState.loaded) {
      const playerMinesAll = gameState.getPlayerMines(currentPlayerId);
      for (const mine of playerMinesAll) {
        if (mine.pending_level != null && mine.upgrade_finish_at && new Date(mine.upgrade_finish_at) <= new Date(nowISO)) {
          const upgCores = mine.cell_id ? gameState.getCoresForMine(mine.cell_id) : [];
          const upgCoreHp = upgCores.length > 0 ? getCoresTotalBoost(upgCores, 'hp') : 1;
          const upgClanDef = getClanDefenseForMine(mine.owner_id, mine.lat, mine.lng);
          const newMineMaxHp = Math.round(getMineHp(mine.pending_level) * upgCoreHp * upgClanDef);
          mine.level = mine.pending_level;
          mine.pending_level = null;
          mine.upgrade_finish_at = null;
          mine.hp = newMineMaxHp;
          mine.max_hp = newMineMaxHp;
          gameState.markDirty('mines', mine.id);
          // Persist immediately — must await to prevent stale DB reads
          await supabase.from('mines').update({
            level: mine.level,
            pending_level: null,
            upgrade_finish_at: null,
            hp: newMineMaxHp,
            max_hp: newMineMaxHp,
          }).eq('id', mine.id);
          let xpResult = null;
          try { xpResult = await addXp(currentPlayerId, XP_REWARDS.UPGRADE_MINE(mine.level)); } catch (_) {}
          completedUpgrades.push({ ...mine, xp: xpResult });
        }
      }
    } else {
      // DB fallback
      const { data: readyMines } = await supabase
        .from('mines').select('id,owner_id,level,pending_level')
        .eq('owner_id', currentPlayerId)
        .not('pending_level', 'is', null)
        .lte('upgrade_finish_at', nowISO);

      if (readyMines?.length) {
        for (const mine of readyMines) {
          const newMineMaxHp = getMineHp(mine.pending_level);
          const { data: updated, error: upErr } = await supabase
            .from('mines')
            .update({ level: mine.pending_level, pending_level: null, upgrade_finish_at: null, hp: newMineMaxHp, max_hp: newMineMaxHp })
            .eq('id', mine.id).select().single();
          if (upErr) continue;
          let xpResult = null;
          try { xpResult = await addXp(currentPlayerId, XP_REWARDS.UPGRADE_MINE(mine.pending_level)); } catch (_) {}
          completedUpgrades.push({ ...updated, xp: xpResult });
        }
      }
    }
  } catch (e) { console.error('[tick] upgrade poll error:', e.message); }

  // ── 4. HP regen ─────────────────────────────────────────
  const level = player.level ?? 1;
  const _earlySkFx = gameState.loaded ? getPlayerSkillEffects(gameState.getPlayerSkills(player.telegram_id)) : null;
  const maxHp = Math.round((1000 + (player.bonus_hp ?? 0)) * (1 + (_earlySkFx?.player_hp_bonus || 0)));
  let currentHp = player.hp ?? maxHp;
  if (currentHp < maxHp) {
    if (!player.last_hp_regen) player.last_hp_regen = new Date().toISOString();
    currentHp = calcHpRegen(currentHp, maxHp, player.last_hp_regen);
    // Persist regen result to gameState so next tick continues from here
    if (gameState.loaded) {
      player.hp = currentHp;
      if (currentHp >= maxHp) { player.last_hp_regen = null; }
      gameState.markDirty('players', player.id);
    }
  }
  if (currentHp > maxHp) currentHp = maxHp;

  const _t2 = Date.now();
  // ── 5. Fetch map data ────────────────────────────────────
  let mapData = { headquarters: [], mines: [], online_players: [], bots: [], vases: [], couriers: [], courier_drops: [], markets: [], clan_hqs: [], ore_nodes: [], collectors: [], monuments: [], monument_defenders: [], fire_trucks: [], firefighters: [] };
  if (hasBbox) {
    if (gameState.loaded) {
      const snapshot = gameState.getMapSnapshot(n, s, e, w, currentPlayerId, nowMs);

      // Apply mine HP calculations and income fields
      let playerRange = null;
      if (hasPos) playerRange = getCellsInRange(pLat, pLng);

      snapshot.mines = snapshot.mines.map(m => {
        const cores = gameState.loaded && m.cell_id ? gameState.getCoresForMine(m.cell_id) : [];
        const bHp = cores.length > 0 ? getCoresTotalBoost(cores, 'hp') : 1;
        const bRegen = cores.length > 0 ? getCoresTotalBoost(cores, 'regen') : 1;
        const bCap = cores.length > 0 ? getCoresTotalBoost(cores, 'capacity') : 1;
        const clanDef = getClanDefenseForMine(m.owner_id, m.lat, m.lng);
        const computedMaxHp = Math.round(getMineHp(m.level) * bHp * clanDef);
        const regenPerHour = Math.round(getMineHpRegen(m.level) * bRegen);
        const rawHp = Math.min(m.hp ?? computedMaxHp, computedMaxHp);
        const canRegen = !m.status || m.status === 'normal' || m.status === 'under_attack';
        // If mine HP below max but no last_hp_update, start regen timer now
        if (canRegen && rawHp < computedMaxHp && !m.last_hp_update) {
          const gm = gameState.mines.get(m.id);
          if (gm) { gm.last_hp_update = nowISO; gameState.markDirty('mines', m.id); }
          m.last_hp_update = nowISO;
        }
        const regenedHp = canRegen ? calcMineHpRegen(rawHp, computedMaxHp, regenPerHour, m.last_hp_update) : rawHp;
        return {
          ...m,
          max_hp: computedMaxHp,
          hp: regenedHp,
          hp_regen: regenPerHour,
          income: getMineIncome(m.level),
          capacity: Math.round(getMineCapacity(m.level) * bCap),
          can_capture: playerRange ? m.owner_id !== currentPlayerId && playerRange.has(m.cell_id) : false,
        };
      });

      mapData = snapshot;
    } else {
      // DB fallback — keep old 9-query approach
      let playerRange = null;
      if (hasPos) playerRange = getCellsInRange(pLat, pLng);

      const onlineThreshold = new Date(nowMs - 3 * 60 * 1000).toISOString();

      const [
        { data: allHQ },     { data: allMines },  { data: allOnline },
        { data: allBots },   { data: allVases },
        { data: allCouriers }, { data: allDrops }, { data: allMarkets },
        { data: allClanHqs },
      ] = await Promise.all([
        supabase.from('headquarters')
          .select('id,lat,lng,level,player_id,players(username,game_username,avatar,last_seen,level)')
          .gte('lat', s).lte('lat', n).gte('lng', w).lte('lng', e).limit(2000),
        supabase.from('mines')
          .select('id,lat,lng,level,owner_id,cell_id,upgrade_finish_at,pending_level,last_collected,hp,max_hp,last_hp_update,status,burning_started_at,attacker_id,attack_ends_at,players!mines_owner_id_fkey(username,game_username,avatar,level)')
          .gte('lat', s).lte('lat', n).gte('lng', w).lte('lng', e).limit(2000),
        supabase.from('players')
          .select('id,telegram_id,username,game_username,avatar,last_lat,last_lng,last_seen,level,shield_until,bonus_hp,bonus_attack')
          .gte('last_lat', s).lte('last_lat', n).gte('last_lng', w).lte('last_lng', e)
          .gte('last_seen', onlineThreshold).not('last_lat', 'is', null).limit(100),
        supabase.from('bots')
          .select('id,type,emoji,category,lat,lng,coins_drained,drain_per_sec,reward_min,reward_max,speed,hp,max_hp,attack,size,status,target_mine_id,drained_amount,direction')
          .gt('expires_at', nowISO).gte('lat', s).lte('lat', n).gte('lng', w).lte('lng', e).limit(500),
        supabase.from('vases')
          .select('id,lat,lng,expires_at')
          .gt('expires_at', nowISO).is('broken_by', null)
          .gte('lat', s).lte('lat', n).gte('lng', w).lte('lng', e).limit(200),
        supabase.from('couriers')
          .select('id,type,owner_id,current_lat,current_lng,target_lat,target_lng,hp,max_hp,speed,status,listing_id,owner:players!couriers_owner_id_fkey(game_username,username)')
          .eq('status', 'moving')
          .gte('current_lat', s).lte('current_lat', n).gte('current_lng', w).lte('current_lng', e).limit(200),
        supabase.from('courier_drops')
          .select('id,item_id,lat,lng,expires_at,drop_type,couriers!courier_drops_courier_id_fkey(owner_id),items(name,emoji,rarity,type,attack,crit_chance,defense)')
          .eq('picked_up', false).gt('expires_at', nowISO)
          .gte('lat', s).lte('lat', n).gte('lng', w).lte('lng', e).limit(100),
        supabase.from('markets').select('id,lat,lng,name')
          .gte('lat', s).lte('lat', n).gte('lng', w).lte('lng', e).limit(50),
        supabase.from('clan_headquarters')
          .select('id,lat,lng,player_id,clan_id,clans(name,symbol,color,level)')
          .gte('lat', s).lte('lat', n).gte('lng', w).lte('lng', e).limit(200),
      ]);

      const ONLINE_MS = 3 * 60 * 1000;
      // Pre-compute best mine level per player (for HQ icons)
      const bestMineLvl = {};
      for (const m of (allMines || [])) {
        if (m.status === 'destroyed' || !m.owner_id) continue;
        if ((m.level || 0) > (bestMineLvl[m.owner_id] || 0)) bestMineLvl[m.owner_id] = m.level;
      }
      mapData.headquarters = (allHQ || []).map(hq => ({
        ...hq, is_mine: hq.player_id === currentPlayerId,
        is_online: hq.players?.last_seen ? (nowMs - new Date(hq.players.last_seen).getTime()) < ONLINE_MS : false,
        best_mine_level: bestMineLvl[hq.player_id] || 0,
      }));
      mapData.clan_hqs = (allClanHqs || []).map(ch => {
        const isPlaceholder = ch.clans?.name?.startsWith('_placeholder_');
        return {
          ...ch,
          is_mine: ch.player_id === currentPlayerId,
          is_active: !!ch.clan_id && !isPlaceholder,
          clan_name: isPlaceholder ? null : (ch.clans?.name || null),
          symbol: isPlaceholder ? null : (ch.clans?.symbol || null),
          color: isPlaceholder ? null : (ch.clans?.color || null),
          clan_level: isPlaceholder ? 1 : (ch.clans?.level || 1),
        };
      });
      mapData.mines = (allMines || []).map(m => {
        if (m.status === 'destroyed') return null;
        const cores = gameState.loaded && m.cell_id ? gameState.getCoresForMine(m.cell_id) : [];
        const bHp = cores.length > 0 ? getCoresTotalBoost(cores, 'hp') : 1;
        const bRegen = cores.length > 0 ? getCoresTotalBoost(cores, 'regen') : 1;
        const bCap = cores.length > 0 ? getCoresTotalBoost(cores, 'capacity') : 1;
        const clanDef = getClanDefenseForMine(m.owner_id, m.lat, m.lng);
        const computedMaxHp = Math.round(getMineHp(m.level) * bHp * clanDef);
        const regenPerHour = Math.round(getMineHpRegen(m.level) * bRegen);
        const rawHp = Math.min(m.hp ?? computedMaxHp, computedMaxHp);
        const canRegen = !m.status || m.status === 'normal' || m.status === 'under_attack';
        const regenedHp = canRegen ? calcMineHpRegen(rawHp, computedMaxHp, regenPerHour, m.last_hp_update) : rawHp;
        return {
          ...m,
          max_hp: computedMaxHp,
          hp: regenedHp,
          hp_regen: regenPerHour,
          income: getMineIncome(m.level),
          capacity: Math.round(getMineCapacity(m.level) * bCap),
          is_mine: m.owner_id === currentPlayerId,
          can_capture: playerRange ? m.owner_id !== currentPlayerId && playerRange.has(m.cell_id) : false,
        };
      }).filter(Boolean);
      mapData.online_players = (allOnline || []).filter(p => p.id !== currentPlayerId);
      mapData.bots = allBots || [];
      mapData.vases = allVases || [];
      mapData.couriers = allCouriers || [];
      const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
      mapData.courier_drops = (allDrops || []).map(d => ({
        ...d, drop_type: d.drop_type || ((d.expires_at && new Date(d.expires_at).getTime() - nowMs > SEVEN_DAYS_MS) ? 'delivery' : 'loot'),
      }));
      mapData.markets = allMarkets || [];
    }
  }

  // ── 6. Notifications ───────────────────────────────────
  let notifications = [];
  try {
    if (gameState.loaded) {
      notifications = gameState.getPlayerNotifications(currentPlayerId, 20);
      if (notifications.length > 0) {
        const ids = notifications.map(n => n.id);
        gameState.markNotificationsRead(ids);
        supabase.from('notifications').update({ read: true }).in('id', ids).then(() => {}).catch(e => console.error('[map] DB error:', e.message));
      }
    } else {
      const { data: notifs } = await supabase
        .from('notifications').select('id,type,message,data,created_at')
        .eq('player_id', currentPlayerId).eq('read', false)
        .order('created_at', { ascending: false }).limit(20);
      if (notifs?.length) {
        notifications = notifs;
        supabase.from('notifications').update({ read: true })
          .in('id', notifs.map(n => n.id)).then(() => {}).catch(e => console.error('[map] DB error:', e.message));
      }
    }
  } catch (_) {}

  const _t3 = Date.now();
  // ── 7. Player mines + inventory (with 10s cache for expensive computations) ─
  let playerMines = [];
  let inventory = [];
  let totalIncome = 0;
  let _clanBoost = null;
  let mineCountBoost = 1;
  let perMineBoost = new Map();
  const _skillRow = gameState.loaded ? gameState.getPlayerSkills(player.telegram_id) : null;
  const _skillFx = _skillRow ? getPlayerSkillEffects(_skillRow) : null;

  // Cache key: player ID + mine count + total levels (invalidates on build/upgrade/destroy)
  const _mineCache = mapRouter._mineCache || (mapRouter._mineCache = new Map());
  const _rawMines = gameState.loaded ? gameState.getPlayerMines(currentPlayerId) : null;
  const _mcHash = _rawMines ? _rawMines.length + '_' + _rawMines.reduce((s, m) => s + m.level, 0) : null;
  const _mcCached = _mineCache.get(currentPlayerId);

  try {
    if (gameState.loaded && _mcCached && Date.now() - _mcCached.t < 10000 && _mcCached.h === _mcHash) {
      // Cache hit — use cached mines with fresh HP regen only
      playerMines = _mcCached.mines.map(cm => {
        const gm = gameState.mines.get(cm.id);
        const rawHp = gm ? Math.min(gm.hp ?? cm.max_hp, cm.max_hp) : cm.hp;
        const canRegen = !cm.status || cm.status === 'normal' || cm.status === 'under_attack';
        return { ...cm, hp: canRegen ? calcMineHpRegen(rawHp, cm.max_hp, cm.hp_regen, gm?.last_hp_update || cm.last_hp_update) : rawHp, status: gm?.status || cm.status };
      });
      totalIncome = _mcCached.totalIncome;
      mineCountBoost = _mcCached.mineCountBoost;
      _clanBoost = _mcCached.clanBoost;
      inventory = gameState.getPlayerItems(currentPlayerId).map(i => ({ ...i, equipped: !!i.equipped, on_market: !!i.on_market }));
    } else if (gameState.loaded) {
      playerMines = _rawMines.map(m => {
        const cores = m.cell_id ? gameState.getCoresForMine(m.cell_id) : [];
        const bHp = cores.length > 0 ? getCoresTotalBoost(cores, 'hp') : 1;
        const bRegen = cores.length > 0 ? getCoresTotalBoost(cores, 'regen') : 1;
        const bCap = cores.length > 0 ? getCoresTotalBoost(cores, 'capacity') : 1;
        const bInc = cores.length > 0 ? getCoresTotalBoost(cores, 'income') : 1;
        const clanDef = getClanDefenseForMine(m.owner_id, m.lat, m.lng);
        const sHp = _skillFx ? (1 + _skillFx.mine_hp_bonus) : 1;
        const sRegen = _skillFx ? (1 + _skillFx.mine_regen_bonus) : 1;
        const sCap = _skillFx ? (1 + _skillFx.mine_capacity_bonus) : 1;
        const cMax = Math.round(getMineHp(m.level) * bHp * clanDef * sHp);
        const rph = Math.round(getMineHpRegen(m.level) * bRegen * sRegen);
        const rawHp = Math.min(m.hp ?? cMax, cMax);
        const canRegen = !m.status || m.status === 'normal' || m.status === 'under_attack';
        if (canRegen && rawHp < cMax && !m.last_hp_update) {
          const gm = gameState.mines.get(m.id);
          if (gm) { gm.last_hp_update = nowISO; gameState.markDirty('mines', m.id); }
          m.last_hp_update = nowISO;
        }
        return {
          ...m,
          max_hp: cMax,
          hp: canRegen ? calcMineHpRegen(rawHp, cMax, rph, m.last_hp_update) : rawHp,
          hp_regen: rph,
          income: getMineIncome(m.level) * bInc,
          capacity: Math.round(getMineCapacity(m.level) * bCap * sCap),
        };
      });
      inventory = gameState.getPlayerItems(currentPlayerId).map(i => ({ ...i, equipped: !!i.equipped, on_market: !!i.on_market }));
    } else {
      const [{ data: pm }, { data: inv }] = await Promise.all([
        supabase.from('mines').select('id,lat,lng,level,owner_id,cell_id,upgrade_finish_at,pending_level,last_collected,hp,max_hp,last_hp_update,status,burning_started_at,attacker_id,attack_ends_at').eq('owner_id', currentPlayerId),
        supabase.from('items').select('id,type,rarity,name,emoji,stat_value,attack,crit_chance,defense,block_chance,equipped,on_market,obtained_at,upgrade_level,base_attack,base_crit_chance,base_defense').eq('owner_id', currentPlayerId).eq('on_market', false).order('obtained_at', { ascending: false }),
      ]);
      playerMines = (pm || []).filter(m => m.status !== 'destroyed').map(m => {
        const cores = gameState.loaded && m.cell_id ? gameState.getCoresForMine(m.cell_id) : [];
        const bHp = cores.length > 0 ? getCoresTotalBoost(cores, 'hp') : 1;
        const bRegen = cores.length > 0 ? getCoresTotalBoost(cores, 'regen') : 1;
        const bCap = cores.length > 0 ? getCoresTotalBoost(cores, 'capacity') : 1;
        const bInc = cores.length > 0 ? getCoresTotalBoost(cores, 'income') : 1;
        const clanDef = getClanDefenseForMine(m.owner_id, m.lat, m.lng);
        const sHp = _skillFx ? (1 + _skillFx.mine_hp_bonus) : 1;
        const sRegen = _skillFx ? (1 + _skillFx.mine_regen_bonus) : 1;
        const sCap = _skillFx ? (1 + _skillFx.mine_capacity_bonus) : 1;
        const cMax = Math.round(getMineHp(m.level) * bHp * clanDef * sHp);
        const rph = Math.round(getMineHpRegen(m.level) * bRegen * sRegen);
        const rawHp = Math.min(m.hp ?? cMax, cMax);
        const canRegen = !m.status || m.status === 'normal' || m.status === 'under_attack';
        return { ...m, max_hp: cMax, hp: canRegen ? calcMineHpRegen(rawHp, cMax, rph, m.last_hp_update) : rawHp, hp_regen: rph, income: getMineIncome(m.level) * bInc, capacity: Math.round(getMineCapacity(m.level) * bCap * sCap) };
      });
      inventory = inv || [];
    }

    // ── Income calculation (O(N²) boost + per-mine income) ──
    {
      const R_DEG = MINE_BOOST_RADIUS / 111320;
      let maxBoost = 1;
      for (const m of playerMines) {
        if (m.lat == null || m.lng == null) continue;
        let pts = 0;
        for (const other of playerMines) {
          if (other.lat == null || other.lng == null) continue;
          if (Math.abs(m.lat - other.lat) > R_DEG || Math.abs(m.lng - other.lng) > R_DEG * 1.8) continue;
          if (haversine(m.lat, m.lng, other.lat, other.lng) <= MINE_BOOST_RADIUS) {
            pts += (other.level || 1);
          }
        }
        const boost = getMineCountBoost(pts);
        perMineBoost.set(m.id, boost);
        if (boost > maxBoost) maxBoost = boost;
      }
      mineCountBoost = maxBoost;

      try {
        let clanCfg = null, clanHqs = [], boostMul = 1;
        if (player.clan_id && gameState.loaded) {
          const pClan = gameState.getClanById(player.clan_id);
          if (pClan) {
            clanCfg = getClanLevel(pClan.level || 1);
            for (const ch of gameState.clanHqs.values()) { if (ch.clan_id === player.clan_id) clanHqs.push(ch); }
            const boostActive = pClan.boost_expires_at && new Date(pClan.boost_expires_at).getTime() > Date.now();
            boostMul = boostActive ? (pClan.boost_multiplier || 1) : 1;
            if (boostActive) _clanBoost = { expires_at: pClan.boost_expires_at, multiplier: pClan.boost_multiplier };
          }
        }

        const _isOnline = player.last_seen ? (Date.now() - new Date(player.last_seen).getTime()) < 180000 : false;

        for (const m of playerMines) {
          let inc = getMineIncome(m.level) * (perMineBoost.get(m.id) || 1);
          if (_skillFx?.mine_income_bonus) inc *= (1 + _skillFx.mine_income_bonus);
          if (gameState.loaded && m.cell_id) {
            const cores = gameState.getCoresForMine(m.cell_id);
            if (cores.length > 0) inc *= getCoresTotalBoost(cores, 'income');
          }
          if (clanCfg && clanHqs.length > 0 && clanHqs.some(h => haversine(m.lat, m.lng, h.lat, h.lng) <= clanCfg.radius)) {
            inc *= (1 + (clanCfg.income || 0) / 100);
            if (boostMul > 1) inc *= boostMul;
          }
          if (_skillFx?.landlord_bonus && _isOnline && player.last_lat && player.last_lng && haversine(player.last_lat, player.last_lng, m.lat, m.lng) <= SMALL_RADIUS) {
            inc *= 1.15;
          }
          m.income = inc;
        }
        totalIncome = playerMines.reduce((sum, m) => sum + m.income, 0);
      } catch (incErr) {
        console.error('[tick] income calc error:', incErr.message);
        totalIncome = playerMines.reduce((sum, m) => sum + getMineIncome(m.level), 0);
      }

      // Cache full result (mines + income + boosts)
      _mineCache.set(currentPlayerId, { t: Date.now(), h: _mcHash, mines: playerMines, totalIncome, mineCountBoost, clanBoost: _clanBoost });
    }
  } catch (mineErr) { console.error('[map] mines/boost error:', mineErr.message); }

  // ── Build response ─────────────────────────────────────
  const playerMineCount = playerMines.length;

  const playerData = {
    ...player, level, xp: player.xp ?? 0,
    xpForNextLevel: xpForLevel(level),
    hp: currentHp, max_hp: maxHp,
    attack: 10 + (player.bonus_attack ?? 0),
    crystals: player.crystals || 0,
    ether: player.ether || 0,
    smallRadius: SMALL_RADIUS + (_skillFx?.radius_bonus || 0), largeRadius: LARGE_RADIUS + (_skillFx?.attack_radius_bonus || 0),
    mine_count_boost: mineCountBoost,
    mine_level_points: playerMines.reduce((s, m) => s + (m.level || 1), 0),
    mine_count: playerMineCount,
  };

  // Calculate total ore income for this player (all ore nodes, not just visible)
  let oreIncome = 0;
  let etherIncome = 0;
  if (gameState.loaded) {
    for (const ore of gameState.oreNodes.values()) {
      if (ore.owner_id === currentPlayerId) {
        const inc = getOreIncome(ore.level, ore.ore_type);
        const cfg = ORE_TYPES[ore.ore_type] || ORE_TYPES.hill;
        if (cfg.dualCurrency) {
          oreIncome += inc;
          etherIncome += inc;
        } else if (ore.currency === 'ether') {
          etherIncome += inc;
        } else {
          oreIncome += inc;
        }
      }
    }
  }

  // Base income = perMineBoost + cores, WITHOUT clan zone/boost
  const baseIncome = playerMines.reduce((sum, m) => {
    let inc = getMineIncome(m.level) * (perMineBoost.get(m.id) || 1);
    if (gameState.loaded && m.cell_id) {
      const cores = gameState.getCoresForMine(m.cell_id);
      if (cores.length > 0) inc *= getCoresTotalBoost(cores, 'income');
    }
    return sum + inc;
  }, 0);

  // Clan color for UI
  let clanColor = null;
  if (player.clan_id && gameState.loaded) {
    const pc = gameState.getClanById(player.clan_id);
    if (pc) clanColor = pc.color;
  }

  // Check if player has a clan HQ (regardless of viewport)
  let hasClanHq = false;
  if (gameState.loaded) {
    hasClanHq = !!gameState.getClanHqByPlayerId(currentPlayerId);
  }

  // ── Loot boxes — cached 30s per player to avoid DB query every tick ──
  let loot_boxes = [];
  if (hasBbox) {
    const _lbCache = mapRouter._lbCache || (mapRouter._lbCache = new Map());
    const _lbKey = currentPlayerId;
    const _lbCached = _lbCache.get(_lbKey);
    if (_lbCached && Date.now() - _lbCached.t < 30000) {
      loot_boxes = _lbCached.d;
    } else {
      try {
        const { data: boxes } = await supabase.from('monument_loot_boxes')
          .select('id,monument_id,player_id,player_name,player_avatar,box_type,monument_level,gems,opened,lat,lng,expires_at')
          .eq('opened', false)
          .gt('expires_at', nowISO)
          .gte('lat', s).lte('lat', n).gte('lng', w).lte('lng', e)
          .limit(50);
        loot_boxes = boxes || [];
        _lbCache.set(_lbKey, { d: loot_boxes, t: Date.now() });
      } catch (_) {}
    }
  }

  // Always include ALL own collectors (not just viewport)
  let own_collectors = [];
  if (gameState.loaded) {
    for (const c of gameState.collectors.values()) {
      if (c.owner_id === currentPlayerId) {
        own_collectors.push({ ...c, is_mine: true });
      }
    }
  }
  // Merge into mapData collectors (add own that are outside viewport)
  const viewportCollectorIds = new Set((mapData.collectors || []).map(c => c.id));
  for (const c of own_collectors) {
    if (!viewportCollectorIds.has(c.id)) {
      mapData.collectors = mapData.collectors || [];
      mapData.collectors.push(c);
    }
  }

  // Always include ALL own fire trucks (not just viewport)
  if (gameState.loaded) {
    const viewportTruckIds = new Set((mapData.fire_trucks || []).map(ft => ft.id));
    for (const ft of gameState.fireTrucks.values()) {
      if (ft.owner_id === currentPlayerId && ft.status !== 'destroyed' && !viewportTruckIds.has(ft.id)) {
        mapData.fire_trucks = mapData.fire_trucks || [];
        mapData.fire_trucks.push({ ...ft, is_mine: true });
      }
    }
  }

  // Always include ALL own active scouts (not just viewport)
  if (gameState.loaded) {
    const viewportScoutIds = new Set((mapData.active_scouts || []).map(s => s.id));
    for (const s of gameState.activeScouts.values()) {
      if (Number(s.owner_id) === Number(player.telegram_id) && !viewportScoutIds.has(s.id)) {
        mapData.active_scouts = mapData.active_scouts || [];
        mapData.active_scouts.push({
          id: s.id, owner_id: s.owner_id,
          lat: s.current_lat, lng: s.current_lng,
          target_lat: s.target_lat, target_lng: s.target_lng,
          speed: s.speed, hp: s.hp, max_hp: s.max_hp,
          level: s.unit_level, status: s.status,
          target_ore_id: s.target_ore_id,
        });
      }
    }
  }

  const _t4 = Date.now();
  const _tTotal = _t4 - _t0;
  if (_tTotal > 300) console.log(`[TICK-SLOW] ${telegram_id} total=${_tTotal}ms player=${_t1-_t0}ms spawn=${_t2-_t1}ms map=${_t3-_t2}ms income=${_t4-_t3}ms`);

  return res.json({
    ...mapData,
    player: playerData,
    mines_own: playerMines,
    totalIncome,
    baseIncome,
    clanColor,
    oreIncome,
    etherIncome,
    hasClanHq,
    inventory,
    player_cores: gameState.loaded ? gameState.getPlayerCores(Number(player.telegram_id)).concat(gameState.getPlayerCores(currentPlayerId)).filter((c, i, arr) => arr.findIndex(x => x.id === c.id) === i).map(c => ({ id: c.id, core_type: c.core_type, level: c.level, mine_cell_id: c.mine_cell_id || null, slot_index: c.slot_index ?? null, on_market: c.on_market || false })) : [],
    notifications,
    completedUpgrades,
    loot_boxes,
    spawned: spawnedBots.length,
    ..._clanBoost ? { clan_boost: _clanBoost } : {},
    player_skills: _skillRow || { farmer: {}, raider: {}, skill_points_used: 0 },
    skill_effects: _skillFx || {},
    skill_points_available: Math.max(0, (level || 1) - (_skillRow?.skill_points_used || 0)),
    shadow_active: player._shadow_until ? Date.now() < player._shadow_until : false,
    shadow_until: player._shadow_until || null,
    shadow_cooldown: player._shadow_cooldown || null,
  });
}

export const mapRouter = Router();

mapRouter.get('/', async (req, res) => {
  const { north, south, east, west, telegram_id, lat, lng, view } = req.query;

  if (view === 'leaderboard') return handleLeaderboard(req, res);
  if (view === 'markets') {
    if (gameState.loaded) {
      return res.json({ markets: gameState.getAllMarkets() });
    }
    const { data: mkts, error: mkErr } = await supabase
      .from('markets').select('id,lat,lng,name').limit(200);
    if (mkErr) return res.status(500).json({ error: mkErr.message });
    return res.json({ markets: mkts || [] });
  }

  if (view === 'health') {
    try {
      const { error } = await supabase.from('app_settings').select('key').limit(1);
      if (error) throw error;
      return res.json({ status: 'ok', db: 'connected', gameState: gameState.loaded ? gameState.stats() : null });
    } catch (err) {
      return res.status(503).json({ status: 'error', db: err.message });
    }
  }

  if (north == null || south == null || east == null || west == null) {
    return res.status(400).json({ error: 'north, south, east, west are required' });
  }

  const n = parseFloat(north), s = parseFloat(south);
  const e = parseFloat(east),  w = parseFloat(west);

  if (isNaN(n) || isNaN(s) || isNaN(e) || isNaN(w)) {
    return res.status(400).json({ error: 'Invalid bbox params' });
  }

  // Reject if bbox is too large
  if ((n - s) > 0.3 || (e - w) > 0.3) {
    return res.json({ mines: [], headquarters: [], bots: [], vases: [], online_players: [] });
  }

  const nowMs = Date.now();
  const nowISO = new Date(nowMs).toISOString();

  // Resolve current player UUID for is_mine / can_capture
  let currentPlayerId = null;
  if (telegram_id) {
    if (gameState.loaded) {
      const p = gameState.getPlayerByTgId(telegram_id);
      if (p) currentPlayerId = p.id;
    }
    if (!currentPlayerId) {
      const { player } = await getPlayerByTelegramId(telegram_id, 'id');
      if (player) currentPlayerId = player.id;
    }
  }

  // Player cell range for can_capture
  let playerRange = null;
  const pLat = parseFloat(lat);
  const pLng = parseFloat(lng);
  if (!isNaN(pLat) && !isNaN(pLng)) {
    playerRange = getCellsInRange(pLat, pLng);
  }

  if (gameState.loaded) {
    const snapshot = gameState.getMapSnapshot(n, s, e, w, currentPlayerId, nowMs);

    snapshot.mines = snapshot.mines.map(m => {
      const cores = m.cell_id ? gameState.getCoresForMine(m.cell_id) : [];
      const bHp = cores.length > 0 ? getCoresTotalBoost(cores, 'hp') : 1;
      const bRegen = cores.length > 0 ? getCoresTotalBoost(cores, 'regen') : 1;
      const bCap = cores.length > 0 ? getCoresTotalBoost(cores, 'capacity') : 1;
      const clanDef = getClanDefenseForMine(m.owner_id, m.lat, m.lng);
      const computedMaxHp = Math.round(getMineHp(m.level) * bHp * clanDef);
      const regenPerHour = Math.round(getMineHpRegen(m.level) * bRegen);
      const rawHp = Math.min(m.hp ?? computedMaxHp, computedMaxHp);
      const canRegen = !m.status || m.status === 'normal' || m.status === 'under_attack';
      const regenedHp = canRegen ? calcMineHpRegen(rawHp, computedMaxHp, regenPerHour, m.last_hp_update) : rawHp;
      return {
        ...m,
        max_hp: computedMaxHp,
        hp: regenedHp,
        hp_regen: regenPerHour,
        income: getMineIncome(m.level),
        capacity: Math.round(getMineCapacity(m.level) * bCap),
        can_capture: playerRange ? m.owner_id !== currentPlayerId && playerRange.has(m.cell_id) : false,
      };
    });

    return res.status(200).json(snapshot);
  }

  // DB fallback — 9 parallel queries
  const onlineThreshold = new Date(nowMs - 3 * 60 * 1000).toISOString();

  const [
    { data: allHQ,     error: hqErr },
    { data: allMines,  error: minesErr },
    { data: allOnline, error: onlineErr },
    { data: allBots,   error: botsErr },
    { data: allVases,  error: vasesErr },
    { data: allCouriers, error: couriersErr },
    { data: allDrops,    error: dropsErr },
    { data: allMarkets,  error: marketsErr },
    { data: allClanHqs,  error: clanHqErr },
  ] = await Promise.all([
    supabase
      .from('headquarters')
      .select('id,lat,lng,level,player_id,players(username,game_username,avatar,last_seen,level)')
      .gte('lat', s).lte('lat', n)
      .gte('lng', w).lte('lng', e)
      .limit(2000),

    supabase
      .from('mines')
      .select('id,lat,lng,level,owner_id,cell_id,upgrade_finish_at,pending_level,last_collected,hp,max_hp,last_hp_update,status,burning_started_at,attacker_id,attack_ends_at,players!mines_owner_id_fkey(username,game_username,avatar,level)')
      .gte('lat', s).lte('lat', n)
      .gte('lng', w).lte('lng', e)
      .limit(2000),

    supabase
      .from('players')
      .select('id,telegram_id,username,game_username,avatar,last_lat,last_lng,last_seen,level,shield_until,bonus_hp,bonus_attack')
      .gte('last_lat', s).lte('last_lat', n)
      .gte('last_lng', w).lte('last_lng', e)
      .gte('last_seen', onlineThreshold)
      .not('last_lat', 'is', null)
      .limit(100),

    supabase
      .from('bots')
      .select('id,type,emoji,category,lat,lng,coins_drained,drain_per_sec,reward_min,reward_max,speed,hp,max_hp,attack,size')
      .gt('expires_at', nowISO)
      .gte('lat', s).lte('lat', n)
      .gte('lng', w).lte('lng', e)
      .limit(500),

    supabase
      .from('vases')
      .select('id,lat,lng,expires_at')
      .gt('expires_at', nowISO)
      .is('broken_by', null)
      .gte('lat', s).lte('lat', n)
      .gte('lng', w).lte('lng', e)
      .limit(200),

    supabase
      .from('couriers')
      .select('id,type,owner_id,current_lat,current_lng,target_lat,target_lng,hp,max_hp,speed,status,listing_id,owner:players!couriers_owner_id_fkey(game_username,username)')
      .eq('status', 'moving')
      .gte('current_lat', s).lte('current_lat', n)
      .gte('current_lng', w).lte('current_lng', e)
      .limit(200),

    supabase
      .from('courier_drops')
      .select('id,item_id,lat,lng,expires_at,couriers!courier_drops_courier_id_fkey(owner_id),items(name,emoji,rarity,type,attack,crit_chance,defense)')
      .eq('picked_up', false)
      .gt('expires_at', nowISO)
      .gte('lat', s).lte('lat', n)
      .gte('lng', w).lte('lng', e)
      .limit(100),

    supabase
      .from('markets')
      .select('id,lat,lng,name')
      .gte('lat', s).lte('lat', n)
      .gte('lng', w).lte('lng', e)
      .limit(50),

    supabase
      .from('clan_headquarters')
      .select('id,lat,lng,player_id,clan_id,clans(name,symbol,color,level)')
      .gte('lat', s).lte('lat', n)
      .gte('lng', w).lte('lng', e)
      .limit(200),
  ]);

  if (hqErr)       console.error('[map] hq error:', hqErr);
  if (minesErr)    console.error('[map] mines error:', minesErr);
  if (onlineErr)   console.error('[map] online error:', onlineErr);
  if (botsErr)     console.error('[map] bots error:', botsErr);
  if (vasesErr)    console.error('[map] vases error:', vasesErr);
  if (couriersErr) console.error('[map] couriers error:', couriersErr);
  if (dropsErr)    console.error('[map] drops error:', dropsErr);
  if (marketsErr)  console.error('[map] markets error:', marketsErr);
  if (clanHqErr)   console.error('[map] clan_hq error:', clanHqErr);

  const ONLINE_MS = 3 * 60 * 1000;

  // Pre-compute best mine level per player (for HQ icons)
  const bestMineLvl = {};
  for (const m of (allMines || [])) {
    if (m.status === 'destroyed' || !m.owner_id) continue;
    if ((m.level || 0) > (bestMineLvl[m.owner_id] || 0)) bestMineLvl[m.owner_id] = m.level;
  }

  const headquarters = (allHQ || []).map((hq) => ({
    id: hq.id, lat: hq.lat, lng: hq.lng, level: hq.level, player_id: hq.player_id,
    players: hq.players,
    is_mine:   currentPlayerId ? hq.player_id === currentPlayerId : false,
    is_online: hq.players?.last_seen
      ? (Date.now() - new Date(hq.players.last_seen).getTime()) < ONLINE_MS
      : false,
    best_mine_level: bestMineLvl[hq.player_id] || 0,
  }));

  const mines = (allMines || []).map((m) => {
    if (m.status === 'destroyed') return null;
    const cores = gameState.loaded && m.cell_id ? gameState.getCoresForMine(m.cell_id) : [];
    const bHp = cores.length > 0 ? getCoresTotalBoost(cores, 'hp') : 1;
    const bRegen = cores.length > 0 ? getCoresTotalBoost(cores, 'regen') : 1;
    const bCap = cores.length > 0 ? getCoresTotalBoost(cores, 'capacity') : 1;
    const computedMaxHp = Math.round(getMineHp(m.level) * bHp);
    const regenPerHour = Math.round(getMineHpRegen(m.level) * bRegen);
    const rawHp = Math.min(m.hp ?? computedMaxHp, computedMaxHp);
    const canRegen = !m.status || m.status === 'normal' || m.status === 'under_attack';
    const regenedHp = canRegen ? calcMineHpRegen(rawHp, computedMaxHp, regenPerHour, m.last_hp_update) : rawHp;
    return {
      id: m.id, lat: m.lat, lng: m.lng, level: m.level, owner_id: m.owner_id,
      cell_id: m.cell_id, last_collected: m.last_collected,
      upgrade_finish_at: m.upgrade_finish_at, pending_level: m.pending_level,
      hp: regenedHp, max_hp: computedMaxHp, hp_regen: regenPerHour,
      income: getMineIncome(m.level), capacity: Math.round(getMineCapacity(m.level) * bCap),
      status: m.status || 'normal', burning_started_at: m.burning_started_at,
      attacker_id: m.attacker_id, attack_ends_at: m.attack_ends_at,
      players: m.players,
      is_mine:     currentPlayerId ? m.owner_id === currentPlayerId : false,
      can_capture: currentPlayerId && playerRange
        ? m.owner_id !== currentPlayerId && playerRange.has(m.cell_id)
        : false,
    };
  }).filter(Boolean);

  const online_players = (allOnline || []).filter((p) => p.id !== currentPlayerId);
  const bots    = allBots    || [];
  const vases   = allVases   || [];
  const couriers     = allCouriers || [];
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const courier_drops = (allDrops || []).map(d => ({
    ...d,
    drop_type: d.drop_type || ((d.expires_at && new Date(d.expires_at).getTime() - Date.now() > SEVEN_DAYS_MS) ? 'delivery' : 'loot'),
  }));
  const markets      = allMarkets  || [];
  const clan_hqs = (allClanHqs || []).map(ch => {
    const isPlaceholder = ch.clans?.name?.startsWith('_placeholder_');
    return {
      ...ch,
      is_mine: currentPlayerId ? ch.player_id === currentPlayerId : false,
      is_active: !!ch.clan_id && !isPlaceholder,
      clan_name: isPlaceholder ? null : (ch.clans?.name || null),
      symbol: isPlaceholder ? null : (ch.clans?.symbol || null),
      color: isPlaceholder ? null : (ch.clans?.color || null),
      clan_level: isPlaceholder ? 1 : (ch.clans?.level || 1),
    };
  });

  const responseData = { headquarters, mines, online_players, bots, vases, couriers, courier_drops, markets, clan_hqs };
  return res.status(200).json(responseData);
});

mapRouter.post('/', async (req, res) => {
  const { action } = req.body || {};
  if (action === 'tick') return handleTick(req, res);
  return res.status(400).json({ error: 'Unknown POST action' });
});
