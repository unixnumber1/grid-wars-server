import { supabase, getPlayerByTelegramId, parseTgId } from '../../lib/supabase.js';
import { getCellsInRange } from '../../lib/grid.js';
import { BOT_TYPES, getRandomBotType, getRandomReward } from '../../lib/bots.js';
import { haversine } from '../../lib/haversine.js';
import { addXp, XP_REWARDS } from '../../lib/xp.js';
import { getMineIncome, calcHpRegen, xpForLevel, getMineHp, getMineHpRegen, calcMineHpRegen, SMALL_RADIUS, LARGE_RADIUS } from '../../lib/formulas.js';
import { calcTotalIncomeWithClanBonus } from '../../lib/clans.js';

// ── Bot constants ────────────────────────────────────────────
const BOTS_PER_ZONE    = 10;
const BOT_TTL_MS       = 5 * 60 * 1000;
const GLOBAL_BOT_CAP   = 20;
const SPEED_METERS     = { slow: 15, medium: 30, fast: 55, very_fast: 90 };
const DRAIN_LIMITS     = { spirit: 50, goblin: 150, werewolf: 400, demon: 1000, dragon: 3000, boss: 10000 };

// ── Tick counter for periodic cleanup ────────────────────────
let _tickCount = 0;

async function handleLeaderboard(req, res) {
  const { telegram_id } = req.query;

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
  const { telegram_id, lat, lng, north, south, east, west } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  const n = parseFloat(north), s = parseFloat(south);
  const e = parseFloat(east),  w = parseFloat(west);
  const pLat = parseFloat(lat), pLng = parseFloat(lng);
  const hasBbox = !isNaN(n) && !isNaN(s) && !isNaN(e) && !isNaN(w);
  const hasPos  = !isNaN(pLat) && !isNaN(pLng) && pLat !== 0;

  // Reject overly large bbox
  if (hasBbox && ((n - s) > 0.1 || (e - w) > 0.1)) {
    return res.json({ mines: [], headquarters: [], bots: [], vases: [], online_players: [], couriers: [], courier_drops: [], markets: [] });
  }

  const { player, error: pErr } = await getPlayerByTelegramId(
    telegram_id,
    'id,telegram_id,username,game_username,avatar,level,xp,hp,max_hp,bonus_attack,bonus_hp,bonus_crit,kills,deaths,diamonds,coins,equipped_sword,equipped_shield,respawn_until,last_hp_regen,shield_until,clan_id,clan_role'
  );
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const currentPlayerId = player.id;
  const nowMs  = Date.now();
  const nowISO = new Date(nowMs).toISOString();
  _tickCount++;

  // ── 1. Update player location ────────────────────────────
  if (hasPos) {
    supabase.from('players')
      .update({ last_lat: pLat, last_lng: pLng, last_seen: nowISO })
      .eq('id', currentPlayerId)
      .then(() => {}).catch(() => {});
  }

  // ── 2. Bot spawn (inline, with global cap) ──────────────
  let spawnedBots = [];
  if (hasPos) {
    try {
      const PAD_DEG = 0.025;
      const [{ data: nearbyRows }, { count: globalCount }] = await Promise.all([
        supabase.from('bots').select('id,lat,lng')
          .gt('expires_at', nowISO)
          .gte('lat', pLat - PAD_DEG).lte('lat', pLat + PAD_DEG)
          .gte('lng', pLng - PAD_DEG).lte('lng', pLng + PAD_DEG),
        supabase.from('bots').select('*', { count: 'exact', head: true })
          .gt('expires_at', nowISO),
      ]);
      const botsInZone = (nearbyRows || []).filter(
        b => haversine(pLat, pLng, b.lat, b.lng) <= 2000
      );
      const needed = Math.max(0, BOTS_PER_ZONE - botsInZone.length);
      const canSpawn = Math.max(0, GLOBAL_BOT_CAP - (globalCount || 0));
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
        spawnedBots = inserted || [];
      }
    } catch (e) { console.error('[tick] spawn error:', e.message); }
  }

  // ── 3. Bot move (with global lock) ──────────────────────
  let movedBots = null;
  try {
    const { data: moveSetting } = await supabase
      .from('app_settings').select('value').eq('key', 'last_bots_move').single();
    const lastMove = parseInt(moveSetting?.value || '0');
    if (nowMs - lastMove >= 8000) {
      await supabase.from('app_settings')
        .update({ value: nowMs.toString() }).eq('key', 'last_bots_move');

      const { data: allBots } = await supabase
        .from('bots')
        .select('id,type,category,lat,lng,spawn_lat,spawn_lng,direction,status,target_mine_id,drained_amount,drain_limit,drain_per_sec,speed,hp,max_hp,attack,size,emoji,coins_drained,reward_min,reward_max,expires_at')
        .gt('expires_at', nowISO);

      if (allBots?.length) {
        const { data: allMines } = await supabase.from('mines').select('id,lat,lng,owner_id');
        const mineMap = {};
        for (const m of (allMines || [])) mineMap[m.id] = m;

        const updates = [];
        const minesToDrain = new Map();

        for (const bot of allBots) {
          const cfg = BOT_TYPES[bot.type] || {};
          const speedM = SPEED_METERS[cfg.speed || bot.speed] || 30;
          const cosLat = Math.cos(bot.lat * Math.PI / 180);
          const stepLat = speedM / 111000;
          const stepLng = speedM / (111000 * (cosLat || 1));
          const spawnLat = bot.spawn_lat ?? bot.lat;
          const spawnLng = bot.spawn_lng ?? bot.lng;

          let newLat = bot.lat, newLng = bot.lng;
          let newDir = bot.direction ?? Math.random() * Math.PI * 2;
          let newStatus = bot.status || 'roaming';
          let newTarget = bot.target_mine_id;
          let newDrained = bot.drained_amount || 0;
          const isUndead = bot.category === 'undead';

          function smoothStep(dir) {
            const shouldTurn = Math.random() < 0.05;
            const turnAmount = (Math.random() - 0.5) * 0.3;
            const d = shouldTurn ? dir + turnAmount : dir;
            return { lat: bot.lat + Math.cos(d) * stepLat, lng: bot.lng + Math.sin(d) * stepLng, dir: d };
          }

          if (isUndead && newStatus === 'attacking' && newTarget) {
            const target = mineMap[newTarget];
            if (!target) {
              newStatus = 'roaming'; newTarget = null;
              const ss = smoothStep(newDir); newLat = ss.lat; newLng = ss.lng; newDir = ss.dir;
            } else {
              const dLat = target.lat - bot.lat, dLng = target.lng - bot.lng;
              const dist = Math.sqrt(dLat * dLat + dLng * dLng);
              newDir = Math.atan2(dLng, dLat);
              if (dist < 0.0005) {
                if (Math.random() < 0.2) {
                  const drainAmt = (bot.drain_per_sec || cfg.drain_per_sec || 0) * 3;
                  newDrained += drainAmt;
                  if (drainAmt > 0) minesToDrain.set(newTarget, (minesToDrain.get(newTarget) || 0) + drainAmt);
                }
                newLat = bot.lat + (Math.random() - 0.5) * stepLat * 0.3;
                newLng = bot.lng + (Math.random() - 0.5) * stepLng * 0.3;
                if ((bot.drain_limit || 0) > 0 && newDrained >= bot.drain_limit) {
                  newStatus = 'leaving'; newTarget = null;
                }
              } else {
                newLat = bot.lat + Math.cos(newDir) * stepLat;
                newLng = bot.lng + Math.sin(newDir) * stepLng;
              }
            }
          } else if (isUndead && newStatus === 'leaving') {
            const ss = smoothStep(newDir); newLat = ss.lat; newLng = ss.lng; newDir = ss.dir;
            if (Math.random() < 0.09) newStatus = 'roaming';
          } else {
            const ss = smoothStep(newDir); newLat = ss.lat; newLng = ss.lng; newDir = ss.dir;
            if (isUndead && allMines?.length > 0 && Math.random() < 0.15) {
              const target = allMines[Math.floor(Math.random() * allMines.length)];
              newStatus = 'attacking'; newTarget = target.id; newDrained = 0;
              newDir = Math.atan2(target.lng - bot.lng, target.lat - bot.lat);
            }
          }

          const distFromSpawn = haversine(spawnLat, spawnLng, newLat, newLng);
          if (distFromSpawn > 3000) {
            const backAngle = Math.atan2(spawnLng - bot.lng, spawnLat - bot.lat) + (Math.random() - 0.5) * 0.5;
            newLat = bot.lat + Math.cos(backAngle) * stepLat;
            newLng = bot.lng + Math.sin(backAngle) * stepLng;
            newDir = backAngle;
          }

          updates.push({ id: bot.id, lat: newLat, lng: newLng, direction: newDir,
            status: newStatus, target_mine_id: newTarget, drained_amount: newDrained });
        }

        // Batch update bots
        await Promise.all(updates.map(u =>
          supabase.from('bots')
            .update({ lat: u.lat, lng: u.lng, direction: u.direction, status: u.status, target_mine_id: u.target_mine_id, drained_amount: u.drained_amount })
            .eq('id', u.id)
        ));

        if (minesToDrain.size > 0) {
          await Promise.all([...minesToDrain.keys()].map(mineId =>
            supabase.from('mines').update({ last_collected: nowISO }).eq('id', mineId)
          ));
        }

        // Build updated bot list for response
        movedBots = allBots.map((bot, i) => ({
          id: bot.id, type: bot.type, emoji: bot.emoji, category: bot.category,
          lat: updates[i].lat, lng: updates[i].lng,
          coins_drained: bot.coins_drained, drain_per_sec: bot.drain_per_sec,
          reward_min: bot.reward_min, reward_max: bot.reward_max,
          speed: bot.speed, hp: bot.hp, max_hp: bot.max_hp, attack: bot.attack, size: bot.size,
          status: updates[i].status, target_mine_id: updates[i].target_mine_id,
          drained_amount: updates[i].drained_amount, direction: updates[i].direction,
        }));
      }

      // Purge expired bots
      supabase.from('bots').delete().lt('expires_at', nowISO).then(() => {}).catch(() => {});
    }
  } catch (e) { console.error('[tick] bot move error:', e.message); }

  // ── 4. Move couriers ────────────────────────────────────
  let courierResult = null;
  try {
    const { data: couriers } = await supabase
      .from('couriers')
      .select('id,start_lat,start_lng,current_lat,current_lng,target_lat,target_lng,speed,status,created_at,type,item_id,listing_id,to_market_id,owner_id')
      .eq('status', 'moving');

    if (couriers?.length) {
      const cUpdates = [];
      const cArrived = [];
      for (const c of couriers) {
        const routeLat = c.target_lat - c.start_lat;
        const routeLng = c.target_lng - c.start_lng;
        const routeDist = Math.sqrt(routeLat * routeLat + routeLng * routeLng);
        if (routeDist < 0.0001) { cArrived.push(c); continue; }
        const speedDegPerSec = (c.speed || 0.0002) / 4;
        const elapsedSec = (nowMs - new Date(c.created_at).getTime()) / 1000;
        const traveled = speedDegPerSec * elapsedSec;
        const progress = Math.min(traveled / routeDist, 1.0);
        const maxSec = c.type === 'delivery' ? 300 : 1800;
        if (progress >= 0.99 || elapsedSec > maxSec) { cArrived.push(c); continue; }
        const newLat = c.start_lat + routeLat * progress;
        const newLng = c.start_lng + routeLng * progress;
        cUpdates.push({ id: c.id, current_lat: newLat, current_lng: newLng });
      }

      const promises = cUpdates.map(u =>
        supabase.from('couriers').update({ current_lat: u.current_lat, current_lng: u.current_lng }).eq('id', u.id)
      );
      if (cArrived.length > 0) {
        promises.push(supabase.from('couriers').update({ status: 'delivered' }).in('id', cArrived.map(c => c.id)));
      }
      if (promises.length > 0) await Promise.all(promises);

      // Handle delivered couriers
      for (const dc of cArrived) {
        try {
          if (dc.type === 'to_market' && dc.listing_id) {
            await supabase.from('market_listings').update({ status: 'active' }).eq('id', dc.listing_id).eq('status', 'pending');
            if (dc.item_id) await supabase.from('items').update({ held_by_courier: null, held_by_market: dc.to_market_id || null }).eq('id', dc.item_id);
          } else if (dc.type === 'delivery') {
            const { data: buyerPos } = await supabase.from('players').select('last_lat,last_lng').eq('id', dc.owner_id).single();
            const dropLat = (buyerPos?.last_lat ?? dc.target_lat) + (Math.random() - 0.5) * 0.0004;
            const dropLng = (buyerPos?.last_lng ?? dc.target_lng) + (Math.random() - 0.5) * 0.0004;
            await supabase.from('courier_drops').insert({
              courier_id: dc.id, item_id: dc.item_id, listing_id: dc.listing_id,
              lat: dropLat, lng: dropLng, drop_type: 'delivery',
              expires_at: new Date(nowMs + 30 * 24 * 60 * 60 * 1000).toISOString(),
            });
            if (dc.item_id) await supabase.from('items').update({ held_by_courier: null, held_by_market: null }).eq('id', dc.item_id);
            try { await supabase.from('notifications').insert({ player_id: dc.owner_id, type: 'delivery_arrived', message: '📦 Ваш заказ доставлен! Найдите коробку на карте.' }); } catch (_) {}
          }
        } catch (e) { console.error('[tick] courier delivery error:', e.message); }
      }

      courierResult = { moved: cUpdates.length, delivered: cArrived.length };
    }
  } catch (e) { console.error('[tick] courier move error:', e.message); }

  // ── 5. Complete upgrades ────────────────────────────────
  let completedUpgrades = [];
  try {
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
  } catch (e) { console.error('[tick] upgrade poll error:', e.message); }

  // ── 6. HP regen ─────────────────────────────────────────
  const level = player.level ?? 1;
  const maxHp = 100 + (player.bonus_hp ?? 0);
  let currentHp = player.hp ?? maxHp;
  if (currentHp < maxHp) {
    currentHp = calcHpRegen(currentHp, maxHp, player.last_hp_regen);
  }
  if (currentHp > maxHp) currentHp = maxHp;

  // ── 7. Fetch map data (same as GET) ────────────────────
  let mapData = { headquarters: [], mines: [], online_players: [], bots: [], vases: [], couriers: [], courier_drops: [], markets: [], clan_hqs: [] };
  if (hasBbox) {
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
    mapData.headquarters = (allHQ || []).map(hq => ({
      ...hq, is_mine: hq.player_id === currentPlayerId,
      is_online: hq.players?.last_seen ? (nowMs - new Date(hq.players.last_seen).getTime()) < ONLINE_MS : false,
    }));
    mapData.clan_hqs = (allClanHqs || []).map(ch => ({
      ...ch,
      is_mine: ch.player_id === currentPlayerId,
      is_active: !!ch.clan_id,
      clan_name: ch.clans?.name || null,
      symbol: ch.clans?.symbol || null,
      color: ch.clans?.color || null,
      clan_level: ch.clans?.level || 1,
    }));
    mapData.mines = (allMines || []).map(m => {
      if (m.status === 'destroyed') return null;
      const computedMaxHp = getMineHp(m.level);
      const regenPerHour = getMineHpRegen(m.level);
      const rawHp = Math.min(m.hp ?? computedMaxHp, computedMaxHp);
      const canRegen = !m.status || m.status === 'normal';
      const regenedHp = canRegen ? calcMineHpRegen(rawHp, computedMaxHp, regenPerHour, m.last_hp_update) : rawHp;
      return {
        ...m,
        max_hp: computedMaxHp,
        hp: regenedHp,
        hp_regen: regenPerHour,
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

  // ── 8. Notifications ───────────────────────────────────
  let notifications = [];
  try {
    const { data: notifs } = await supabase
      .from('notifications').select('id,type,message,data,created_at')
      .eq('player_id', currentPlayerId).eq('read', false)
      .order('created_at', { ascending: false }).limit(20);
    if (notifs?.length) {
      notifications = notifs;
      supabase.from('notifications').update({ read: true })
        .in('id', notifs.map(n => n.id)).then(() => {}).catch(() => {});
    }
  } catch (_) {}

  // ── 9. Player mines + inventory (for income calc + UI) ─
  let playerMines = [];
  let inventory = [];
  let totalIncome = 0;
  try {
    const [{ data: pm }, { data: inv }] = await Promise.all([
      supabase.from('mines').select('id,lat,lng,level,owner_id,cell_id,upgrade_finish_at,pending_level,last_collected,hp,max_hp,last_hp_update,status,burning_started_at,attacker_id,attack_ends_at').eq('owner_id', currentPlayerId),
      supabase.from('items').select('id,type,rarity,name,emoji,stat_value,attack,crit_chance,defense,equipped,on_market,obtained_at').eq('owner_id', currentPlayerId).eq('on_market', false).order('obtained_at', { ascending: false }),
    ]);
    playerMines = (pm || []).filter(m => m.status !== 'destroyed').map(m => {
      const cMax = getMineHp(m.level);
      const rph = getMineHpRegen(m.level);
      const rawHp = Math.min(m.hp ?? cMax, cMax);
      const canRegen = !m.status || m.status === 'normal';
      return { ...m, max_hp: cMax, hp: canRegen ? calcMineHpRegen(rawHp, cMax, rph, m.last_hp_update) : rawHp, hp_regen: rph };
    });
    inventory = inv || [];
    totalIncome = await calcTotalIncomeWithClanBonus(playerMines, getMineIncome, player.clan_id, supabase);
  } catch (_) {}

  // ── 10. Periodic DB cleanup (every 60 ticks ≈ 5 min) ──
  if (_tickCount % 60 === 0) {
    const cleanupCutoff = nowMs;
    Promise.all([
      supabase.from('bots').delete().lt('expires_at', nowISO),
      supabase.from('couriers').delete().in('status', ['delivered', 'killed', 'cancelled']).lt('created_at', new Date(cleanupCutoff - 3600000).toISOString()),
      supabase.from('courier_drops').delete().eq('picked_up', true).lt('created_at', new Date(cleanupCutoff - 3600000).toISOString()),
      supabase.from('notifications').delete().eq('read', true).lt('created_at', new Date(cleanupCutoff - 86400000).toISOString()),
    ]).catch(e => console.error('[tick] cleanup error:', e.message));

    // Expire old listings
    supabase.from('market_listings').select('id,item_id,seller_id')
      .in('status', ['active', 'pending']).lt('expires_at', nowISO).limit(50)
      .then(async ({ data: expired }) => {
        if (!expired?.length) return;
        for (const listing of expired) {
          await Promise.all([
            supabase.from('market_listings').update({ status: 'expired' }).eq('id', listing.id),
            supabase.from('items').update({ on_market: false, held_by_courier: null, held_by_market: null }).eq('id', listing.item_id),
          ]);
          supabase.from('couriers').update({ status: 'cancelled' }).eq('listing_id', listing.id).eq('status', 'moving').then(() => {}).catch(() => {});
        }
      }).catch(() => {});

    // Expire loot drops
    supabase.from('courier_drops').select('id,item_id').eq('picked_up', false).not('expires_at', 'is', null).lt('expires_at', nowISO).limit(50)
      .then(async ({ data: expired }) => {
        if (!expired?.length) return;
        for (const drop of expired) {
          await Promise.all([
            supabase.from('items').update({ on_market: false, held_by_courier: null, held_by_market: null }).eq('id', drop.item_id),
            supabase.from('courier_drops').update({ picked_up: true }).eq('id', drop.id),
          ]);
        }
      }).catch(() => {});

    // Destroy mines that burned for >24h, warn at 18h
    supabase.from('mines').select('id,owner_id,level').eq('status', 'burning')
      .lt('burning_started_at', new Date(nowMs - 86400000).toISOString()).limit(50)
      .then(async ({ data: burned }) => {
        if (!burned?.length) return;
        for (const m of burned) {
          await supabase.from('mines').update({ status: 'destroyed' }).eq('id', m.id);
          await supabase.from('notifications').insert({
            player_id: m.owner_id, type: 'mine_destroyed',
            message: `💀 Шахта Ур.${m.level} уничтожена огнём.`,
          }).catch(() => {});
        }
      }).catch(() => {});

    // Warning at ~18h (between 64800s and 65400s = 10min window)
    supabase.from('mines').select('id,owner_id,level').eq('status', 'burning')
      .lt('burning_started_at', new Date(nowMs - 64800000).toISOString())
      .gt('burning_started_at', new Date(nowMs - 65400000).toISOString()).limit(50)
      .then(async ({ data: soon }) => {
        if (!soon?.length) return;
        for (const m of soon) {
          await supabase.from('notifications').insert({
            player_id: m.owner_id, type: 'mine_burning_warning',
            message: `⚠️ Шахта Ур.${m.level} сгорит через ~6 часов!`,
          }).catch(() => {});
        }
      }).catch(() => {});

    // ── Inactive clan leader auto-transfer ──
    supabase.from('clan_members').select('clan_id,player_id,players(last_seen)')
      .eq('role', 'leader').is('left_at', null).limit(20)
      .then(async ({ data: leaders }) => {
        if (!leaders?.length) return;
        const sevenDaysAgo = new Date(nowMs - 7 * 24 * 60 * 60 * 1000);
        for (const lm of leaders) {
          const lastSeen = lm.players?.last_seen ? new Date(lm.players.last_seen) : null;
          if (!lastSeen || lastSeen >= sevenDaysAgo) continue;
          // Find senior officer
          const { data: officers } = await supabase.from('clan_members')
            .select('player_id').eq('clan_id', lm.clan_id).eq('role', 'officer').is('left_at', null)
            .order('joined_at', { ascending: true }).limit(1);
          const newLeader = officers?.[0];
          if (!newLeader) continue;
          await Promise.all([
            supabase.from('clan_members').update({ role: 'member' }).eq('player_id', lm.player_id).eq('clan_id', lm.clan_id),
            supabase.from('players').update({ clan_role: 'member' }).eq('id', lm.player_id),
            supabase.from('clan_members').update({ role: 'leader' }).eq('player_id', newLeader.player_id).eq('clan_id', lm.clan_id),
            supabase.from('players').update({ clan_role: 'leader' }).eq('id', newLeader.player_id),
            supabase.from('clans').update({ leader_id: newLeader.player_id }).eq('id', lm.clan_id),
          ]);
        }
      }).catch(e => console.error('[tick] clan leader transfer error:', e.message));
  }

  // ── Build response ─────────────────────────────────────
  const playerData = {
    ...player, level, xp: player.xp ?? 0,
    xpForNextLevel: xpForLevel(level),
    hp: currentHp, max_hp: maxHp,
    attack: 10 + (player.bonus_attack ?? 0),
    smallRadius: SMALL_RADIUS, largeRadius: LARGE_RADIUS,
  };

  return res.json({
    ...mapData,
    player: playerData,
    mines_own: playerMines,
    totalIncome,
    inventory,
    notifications,
    completedUpgrades,
    spawned: spawnedBots.length,
  });
}

export default async function handler(req, res) {
  // POST: unified game tick
  if (req.method === 'POST') {
    const { action } = req.body || {};
    if (action === 'tick') return handleTick(req, res);
    return res.status(400).json({ error: 'Unknown POST action' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { north, south, east, west, telegram_id, lat, lng, view } = req.query;

  if (view === 'leaderboard') return handleLeaderboard(req, res);
  if (view === 'markets') {
    const { data: mkts, error: mkErr } = await supabase
      .from('markets').select('id,lat,lng,name').limit(200);
    if (mkErr) return res.status(500).json({ error: mkErr.message });
    return res.json({ markets: mkts || [] });
  }

  if (view === 'health') {
    try {
      const { error } = await supabase.from('app_settings').select('key').limit(1);
      if (error) throw error;
      return res.json({ status: 'ok', db: 'connected' });
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

  // Reject if bbox is too large (prevents loading thousands of objects)
  // At minZoom 15 + 20% pad, max bbox ~0.04° lat × 0.07° lng; 0.1° gives margin
  if ((n - s) > 0.1 || (e - w) > 0.1) {
    return res.json({ mines: [], headquarters: [], bots: [], vases: [], online_players: [] });
  }

  // Resolve current player UUID for is_mine / can_capture
  let currentPlayerId = null;
  if (telegram_id) {
    const { player } = await getPlayerByTelegramId(telegram_id, 'id');
    if (player) currentPlayerId = player.id;
  }

  // Player cell range for can_capture (optional, needs lat/lng)
  let playerRange = null;
  const pLat = parseFloat(lat);
  const pLng = parseFloat(lng);
  if (!isNaN(pLat) && !isNaN(pLng)) {
    playerRange = getCellsInRange(pLat, pLng);
  }

  const onlineThreshold = new Date(Date.now() - 3 * 60 * 1000).toISOString();

  const nowISO = new Date().toISOString();

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

  const headquarters = (allHQ || []).map((hq) => ({
    id: hq.id, lat: hq.lat, lng: hq.lng, level: hq.level, player_id: hq.player_id,
    players: hq.players,
    is_mine:   currentPlayerId ? hq.player_id === currentPlayerId : false,
    is_online: hq.players?.last_seen
      ? (Date.now() - new Date(hq.players.last_seen).getTime()) < ONLINE_MS
      : false,
  }));

  const mines = (allMines || []).map((m) => {
    if (m.status === 'destroyed') return null;
    const computedMaxHp = getMineHp(m.level);
    const regenPerHour = getMineHpRegen(m.level);
    const rawHp = Math.min(m.hp ?? computedMaxHp, computedMaxHp);
    const canRegen = !m.status || m.status === 'normal';
    const regenedHp = canRegen ? calcMineHpRegen(rawHp, computedMaxHp, regenPerHour, m.last_hp_update) : rawHp;
    return {
    id: m.id, lat: m.lat, lng: m.lng, level: m.level, owner_id: m.owner_id,
    cell_id: m.cell_id, last_collected: m.last_collected,
    upgrade_finish_at: m.upgrade_finish_at, pending_level: m.pending_level,
    hp: regenedHp, max_hp: computedMaxHp, hp_regen: regenPerHour,
    status: m.status || 'normal', burning_started_at: m.burning_started_at,
    attacker_id: m.attacker_id, attack_ends_at: m.attack_ends_at,
    players: m.players,
    is_mine:     currentPlayerId ? m.owner_id === currentPlayerId : false,
    can_capture: currentPlayerId && playerRange
      ? m.owner_id !== currentPlayerId && playerRange.has(m.cell_id)
      : false,
  };}).filter(Boolean);

  const online_players = (allOnline || []).filter((p) => p.id !== currentPlayerId);
  const bots    = allBots    || [];
  const vases   = allVases   || [];
  const couriers     = allCouriers || [];
  // Infer drop_type from expires_at: delivery drops have 30-day expiry (>7 days from now)
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const courier_drops = (allDrops || []).map(d => ({
    ...d,
    drop_type: d.drop_type || ((d.expires_at && new Date(d.expires_at).getTime() - Date.now() > SEVEN_DAYS_MS) ? 'delivery' : 'loot'),
  }));
  const markets      = allMarkets  || [];
  const clan_hqs = (allClanHqs || []).map(ch => ({
    ...ch,
    is_mine: currentPlayerId ? ch.player_id === currentPlayerId : false,
    is_active: !!ch.clan_id,
    clan_name: ch.clans?.name || null,
    symbol: ch.clans?.symbol || null,
    color: ch.clans?.color || null,
    clan_level: ch.clans?.level || 1,
  }));

  const responseData = { headquarters, mines, online_players, bots, vases, couriers, courier_drops, markets, clan_hqs };
  console.log('[map] response size:', JSON.stringify(responseData).length, 'bytes, items:',
    { hq: headquarters.length, mines: mines.length, bots: bots.length, vases: vases.length, online: online_players.length, couriers: couriers.length, drops: courier_drops.length, markets: markets.length });

  return res.status(200).json(responseData);
}
