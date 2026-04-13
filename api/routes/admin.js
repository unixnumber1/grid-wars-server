import { Router } from 'express';
import os from 'os';
import { supabase, sendTelegramNotification } from '../../lib/supabase.js';
import { gameState } from '../../lib/gameState.js';
import { connectedPlayers, io } from '../../server.js';
import { log } from '../../lib/log.js';
import { getCellCenter, getCellId } from '../../lib/grid.js';
import { haversine } from '../../lib/haversine.js';
import { dailyMarketCheck } from '../../lib/markets.js';
import { resetSpoofRecord } from '../../lib/antispoof.js';
import { getPlayerLogs, logPlayer } from '../../lib/logger.js';
import { playerCityCache, clearCityBoundsCache } from '../../lib/geocity.js';
import { suspiciousActivity } from '../../security/rateLimit.js';
import { ts, getLang } from '../../config/i18n.js';
import { generateItem, getUpgradedStats, getMaxUpgradeLevel } from '../../game/mechanics/items.js';
import { CORE_TYPES } from '../../game/mechanics/cores.js';
import { clearSpawnErrorCache, clearSpawnPointsCache } from '../../game/mechanics/oreNodes.js';
import { addXp, XP_REWARDS } from '../../lib/xp.js';
import { gridDisk } from 'h3-js';

export const adminRouter = Router();
import { isAdmin as isAdminId, CONTEST_RULES, getContestIdForClan } from '../../config/constants.js';
import { getActiveContestClanIds, setActiveContestClanIds } from '../../game/mechanics/contest.js';
const ADMIN_TG_ID = 560013667;

function isAdmin(req) {
  if (!req.authVerified) return false;
  return isAdminId(req.verifiedTgId);
}

function getBannedPlayers() {
  const banned = [];
  for (const p of gameState.players.values()) {
    if (p.is_banned) {
      banned.push({
        telegram_id: p.telegram_id,
        game_username: p.game_username || p.username,
        ban_reason: p.ban_reason,
        ban_until: p.ban_until,
      });
      if (banned.length >= 10) break;
    }
  }
  return banned;
}

function getSuspiciousPlayers() {
  const result = [];
  const seen = new Set();
  for (const [key, data] of suspiciousActivity) {
    const isSpoof = key.startsWith('spoof:');
    const tgId = isSpoof ? key.slice(6) : key;
    if (seen.has(tgId)) {
      const existing = result.find(r => String(r.telegram_id) === String(tgId));
      if (existing && isSpoof) {
        existing.spoof_violations = data.totalViolations || 0;
      }
      continue;
    }
    seen.add(tgId);
    const player = gameState.getPlayerByTgId(tgId);
    const spoofKey = `spoof:${tgId}`;
    const spoofData = !isSpoof ? suspiciousActivity.get(spoofKey) : null;
    result.push({
      telegram_id: tgId,
      username: player?.game_username || player?.username || '???',
      violations: isSpoof ? 0 : (data.count || 0),
      spoof_violations: isSpoof ? (data.totalViolations || 0) : (spoofData?.totalViolations || 0),
      last_at: data.lastAt ? new Date(data.lastAt).toLocaleTimeString('ru') : null,
      is_banned: player?.is_banned || false,
    });
  }
  return result
    .filter(p => !p.telegram_id.startsWith('spoof:'))
    .filter(p => p.violations > 0 || p.spoof_violations > 0)
    .sort((a, b) => (b.violations + b.spoof_violations) - (a.violations + a.spoof_violations))
    .slice(0, 10);
}

async function _notifyAllPlayers(text) {
  const { data: players } = await supabase
    .from('players')
    .select('telegram_id')
    .not('telegram_id', 'is', null)
    .limit(10000);

  let sent = 0;
  const BOT = process.env.BOT_TOKEN;
  if (!BOT || !players?.length) return sent;

  // Send in batches of 30 (Telegram rate limit ~30 msg/sec)
  for (let i = 0; i < players.length; i += 30) {
    const batch = players.slice(i, i + 30);
    const results = await Promise.allSettled(
      batch.map(p =>
        fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: p.telegram_id, text, parse_mode: 'HTML' }),
        })
      )
    );
    sent += results.filter(r => r.status === 'fulfilled').length;
    // Small delay between batches to respect Telegram rate limits
    if (i + 30 < players.length) await new Promise(r => setTimeout(r, 1000));
  }
  return sent;
}

// ── GET ──────────────────────────────────────────────────────
adminRouter.get('/', async (req, res) => {
  const { action, search } = req.query || {};

  // ── players-list: search players by username ──
  if (action === 'players-list') {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });

    const q = (search || '').trim();
    if (!q) return res.status(200).json({ players: [] });

    const { data, error } = await supabase
      .from('players')
      .select('id, username, game_username, avatar, level, coins, diamonds, is_banned, ban_reason, ban_until')
      .or(`username.ilike.%${q}%,game_username.ilike.%${q}%`)
      .order('last_seen', { ascending: false })
      .limit(20);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ players: data || [] });
  }

  // ── default: maintenance status ──
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'maintenance_mode')
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ maintenance: data?.value === 'true', is_admin: isAdmin(req) });
});

// ── GET /stats ───────────────────────────────────────────────
adminRouter.get('/stats', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });

  const now = Date.now();
  const FIVE_MIN = 5 * 60 * 1000;
  const ONE_DAY = 24 * 60 * 60 * 1000;

  let online_now = 0, online_today = 0, total_players = 0, new_today = 0;
  let new_week = 0, with_hq = 0;
  const ONE_WEEK = 7 * ONE_DAY;
  const ONE_HOUR = 60 * 60 * 1000;
  // Retention buckets
  let ret_d1 = 0, ret_d1_base = 0, ret_d7 = 0, ret_d7_base = 0;
  // Level distribution
  const levelBuckets = { '1-5': 0, '6-20': 0, '21-50': 0, '51-100': 0, '100+': 0 };
  // Avg session (from online_history)
  const hist = global.onlineHistory || [];
  const peakOnline = hist.length > 0 ? Math.max(...hist.map(h => h.count)) : 0;
  const avgOnline = hist.length > 0 ? Math.round(hist.reduce((s, h) => s + h.count, 0) / hist.length) : 0;

  if (gameState.loaded) {
    total_players = gameState.players.size;
    for (const p of gameState.players.values()) {
      const lastSeen = p.last_seen ? new Date(p.last_seen).getTime() : 0;
      const created = p.created_at ? new Date(p.created_at).getTime() : 0;
      const age = now - created;

      if (now - lastSeen < FIVE_MIN) online_now++;
      if (now - lastSeen < ONE_DAY) online_today++;
      if (age < ONE_DAY) new_today++;
      if (age < ONE_WEEK) new_week++;

      // Has HQ
      if ([...gameState.headquarters.values()].some(h => String(h.player_id) === String(p.id))) with_hq++;

      // Level distribution
      const lv = p.level || 1;
      if (lv > 100) levelBuckets['100+']++;
      else if (lv > 50) levelBuckets['51-100']++;
      else if (lv > 20) levelBuckets['21-50']++;
      else if (lv > 5) levelBuckets['6-20']++;
      else levelBuckets['1-5']++;

      // D1 retention: registered 1-2 days ago, came back after first day
      if (age >= ONE_DAY && age < 2 * ONE_DAY) {
        ret_d1_base++;
        if (lastSeen > created + ONE_DAY) ret_d1++;
      }
      // D7 retention: registered 7-14 days ago, came back after 7th day
      if (age >= ONE_WEEK && age < 2 * ONE_WEEK) {
        ret_d7_base++;
        if (lastSeen > created + ONE_WEEK) ret_d7++;
      }
    }
  }

  const memUsed = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const memTotal = Math.round(os.totalmem() / 1024 / 1024);

  return res.json({
    online_now,
    online_today,
    total_players,
    new_today,
    new_week,
    with_hq,
    peak_online: peakOnline,
    avg_online: avgOnline,
    retention_d1: ret_d1_base > 0 ? Math.round(ret_d1 / ret_d1_base * 100) : null,
    retention_d1_sample: ret_d1_base,
    retention_d7: ret_d7_base > 0 ? Math.round(ret_d7 / ret_d7_base * 100) : null,
    retention_d7_sample: ret_d7_base,
    level_distribution: levelBuckets,
    uptime_seconds: Math.floor(process.uptime()),
    memory_used_mb: memUsed,
    memory_total_mb: memTotal,
    cpu_load: os.loadavg()[0],
    node_version: process.version,
    mines_loaded: gameState.loaded ? gameState.mines.size : 0,
    bots_loaded: gameState.loaded ? gameState.bots.size : 0,
    ore_nodes_loaded: gameState.loaded ? gameState.oreNodes.size : 0,
    players_loaded: gameState.loaded ? gameState.players.size : 0,
    connected_sockets: connectedPlayers.size,
    gamestate: {
      mines: gameState.mines.size,
      bots: gameState.bots.size,
      ore_nodes: gameState.oreNodes.size,
      players: gameState.players.size,
      monuments_total: gameState.monuments.size,
      monuments_active: [...gameState.monuments.values()].filter(m => m.phase === 'open').length,
      monuments_shield: [...gameState.monuments.values()].filter(m => m.phase === 'shield').length,
      monuments_defeated: [...gameState.monuments.values()].filter(m => m.phase === 'defeated').length,
      vases: gameState.vases.size,
      clans: gameState.clans.size,
      cores: gameState.cores.size,
    },
    online_players_list: [...connectedPlayers.values()]
      .filter(cp => cp.telegram_id)
      .map(cp => {
        const p = gameState.loaded ? gameState.getPlayerByTgId(cp.telegram_id) : null;
        if (!p) return null;
        return { id: p.id, telegram_id: p.telegram_id, username: p.game_username || p.username, avatar: p.avatar, level: p.level, lat: cp.lat, lng: cp.lng };
      }).filter(Boolean)
      .filter((p, i, arr) => arr.findIndex(x => x.id === p.id) === i),
    online_history: global.onlineHistory || [],
    recent_errors: (global.recentErrors || []).slice(0, 50),
    recent_activity: (global.recentActivity || []).slice(0, 30),
    recent_bans: getBannedPlayers(),
    suspicious_players: getSuspiciousPlayers(),
  });
});

// ── GET /player-search ───────────────────────────────────────
adminRouter.get('/player-search', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });

  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ players: [] });

  if (!gameState.loaded) return res.json({ players: [] });

  const results = [];
  for (const p of gameState.players.values()) {
    if (results.length >= 10) break;
    const name = (p.game_username || p.username || '').toLowerCase();
    const tg = String(p.telegram_id || '');
    if (name.includes(q) || tg.includes(q)) {
      let minesCount = 0;
      for (const m of gameState.mines.values()) {
        if (m.owner_id === p.id) minesCount++;
      }
      let isOnline = false;
      for (const [, info] of connectedPlayers) {
        if (String(info.telegram_id) === String(p.telegram_id)) { isOnline = true; break; }
      }
      const ci = playerCityCache.get(String(p.telegram_id));
      results.push({
        id: p.id,
        telegram_id: p.telegram_id,
        username: p.game_username || p.username,
        tg_username: p.username || null,
        avatar: p.avatar,
        level: p.level,
        coins: p.coins,
        diamonds: p.diamonds,
        crystals: p.crystals,
        ether: p.ether,
        is_banned: p.is_banned,
        ban_reason: p.ban_reason,
        mines_count: minesCount,
        online: isOnline,
        city: ci?.city || null,
      });
    }
  }
  return res.json({ players: results });
});

// ── GET /player-logs ─────────────────────────────────────────
adminRouter.get('/player-logs', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });

  const playerTgId = parseInt(req.query.player_telegram_id, 10);
  if (!playerTgId) return res.status(400).json({ error: 'player_telegram_id required' });

  const filter = req.query.filter || 'all';
  const logs = getPlayerLogs(playerTgId, filter);
  return res.json({ logs });
});

// ── GET /player-details ──────────────────────────────────────
adminRouter.get('/player-details', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });

  const playerId = req.query.player_id;
  if (!playerId) return res.status(400).json({ error: 'player_id required' });
  if (!gameState.loaded) return res.status(503).json({ error: 'GameState not loaded' });

  const player = gameState.getPlayerById(playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  // Items
  const items = gameState.getPlayerItems(playerId).map(it => {
    const stats = getUpgradedStats(it);
    return {
      id: it.id, type: it.type, rarity: it.rarity,
      attack: stats.attack, defense: stats.defense,
      crit_chance: stats.crit_chance, block_chance: stats.block_chance,
      upgrade_level: it.upgrade_level || 0, equipped: !!it.equipped,
    };
  });

  // Cores
  const cores = [];
  for (const c of gameState.cores.values()) {
    if (String(c.owner_id) === String(player.telegram_id)) {
      cores.push({ id: c.id, core_type: c.core_type, level: c.level, mine_cell_id: c.mine_cell_id });
    }
  }

  // City from geocity cache
  const cityInfo = playerCityCache.get(String(player.telegram_id));

  return res.json({
    player: {
      id: player.id, telegram_id: player.telegram_id,
      username: player.game_username || player.username,
      tg_username: player.username || null,
      avatar: player.avatar,
      level: player.level, coins: player.coins, diamonds: player.diamonds,
      crystals: player.crystals, ether: player.ether,
      is_banned: player.is_banned, ban_reason: player.ban_reason, ban_until: player.ban_until,
      city: cityInfo?.city || null,
      country: cityInfo?.country || null,
      has_hq: [...gameState.headquarters.values()].some(h => String(h.player_id) === String(player.id)),
    },
    items,
    cores,
  });
});

// ── Referral leaderboard ──────────────────────────────────────
adminRouter.get('/referral-stats', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });

  try {
    const { data: rows } = await supabase.from('referrals').select('referrer_id, referred_id, level50_rewarded, created_at');
    if (!rows || rows.length === 0) return res.json({ leaderboard: [], total_referrals: 0, total_gems: 0 });

    // Aggregate by referrer
    const map = new Map();
    for (const r of rows) {
      const entry = map.get(r.referrer_id) || { telegram_id: r.referrer_id, total: 0, lv50: 0, gems: 0, referrals: [] };
      entry.total++;
      entry.gems += 50; // registration reward
      if (r.level50_rewarded) { entry.lv50++; entry.gems += 100; }
      // Get referred player info
      const refPlayer = gameState.loaded ? gameState.getPlayerByTgId(r.referred_id) : null;
      entry.referrals.push({
        telegram_id: r.referred_id,
        username: refPlayer?.game_username || refPlayer?.username || String(r.referred_id),
        level: refPlayer?.level || 1,
        lv50_rewarded: r.level50_rewarded,
        created_at: r.created_at,
      });
      map.set(r.referrer_id, entry);
    }

    const leaderboard = [...map.values()]
      .sort((a, b) => b.total - a.total)
      .map(entry => {
        const p = gameState.loaded ? gameState.getPlayerByTgId(entry.telegram_id) : null;
        return {
          ...entry,
          username: p?.game_username || p?.username || String(entry.telegram_id),
          avatar: p?.avatar || null,
          level: p?.level || 0,
        };
      });

    const totalGems = leaderboard.reduce((s, e) => s + e.gems, 0);
    return res.json({ leaderboard, total_referrals: rows.length, total_gems: totalGems });
  } catch (err) {
    console.error('[admin/referral-stats]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Contest helpers ───────────────────────────────────────────
function _activeClanIds() { return getActiveContestClanIds(); }

// ── Contest: list all clans (for admin picker) ───────────────
adminRouter.get('/contest-clans', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const memberCounts = new Map();
  for (const m of gameState.clanMembers.values()) {
    if (m.left_at) continue;
    memberCounts.set(String(m.clan_id), (memberCounts.get(String(m.clan_id)) || 0) + 1);
  }
  const clans = [...gameState.clans.values()].map(c => ({
    id: c.id,
    name: c.name,
    symbol: c.symbol || '',
    color: c.color || '',
    level: c.level || 1,
    members: memberCounts.get(String(c.id)) || 0,
  })).sort((a, b) => b.members - a.members || a.name.localeCompare(b.name));
  const activeIds = [..._activeClanIds()];
  return res.json({ clans, active_clan_ids: activeIds });
});

// ── Contest: toggle a clan in/out of the active set ─────────
adminRouter.post('/contest-toggle-clan', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const { clan_id } = req.body || {};
  if (!clan_id) return res.status(400).json({ error: 'clan_id required' });
  try {
    const clan = gameState.clans.get(String(clan_id));
    if (!clan) return res.status(404).json({ error: 'Clan not found' });
    const set = _activeClanIds();
    let added;
    if (set.has(String(clan_id))) { set.delete(String(clan_id)); added = false; }
    else { set.add(String(clan_id)); added = true; }
    const arr = await setActiveContestClanIds(set);
    return res.json({ success: true, added, active_clan_ids: arr });
  } catch (err) {
    console.error('[admin/contest-toggle-clan]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Contest: clear all active clans ──────────────────────────
adminRouter.post('/contest-clear', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  try {
    await setActiveContestClanIds([]);
    return res.json({ success: true, active_clan_ids: [] });
  } catch (err) {
    console.error('[admin/contest-clear]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Contest overview: summary of all active contest clans ───
adminRouter.get('/contest-overview', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  try {
    const activeIds = [..._activeClanIds()];
    if (activeIds.length === 0) return res.json({ contests: [], rules: CONTEST_RULES });

    const memberCounts = new Map();
    for (const m of gameState.clanMembers.values()) {
      if (m.left_at) continue;
      memberCounts.set(String(m.clan_id), (memberCounts.get(String(m.clan_id)) || 0) + 1);
    }

    const contestIds = activeIds.map(getContestIdForClan);
    const { data: rows } = await supabase
      .from('contest_tickets')
      .select('contest_id, player_id, amount')
      .in('contest_id', contestIds);

    const totals = new Map(); // contest_id -> { tickets, players:Set }
    for (const r of rows || []) {
      const cur = totals.get(r.contest_id) || { tickets: 0, players: new Set() };
      cur.tickets += (r.amount || 0);
      cur.players.add(r.player_id);
      totals.set(r.contest_id, cur);
    }

    const contests = activeIds.map(clanId => {
      const clan = gameState.clans.get(clanId);
      const cId = getContestIdForClan(clanId);
      const t = totals.get(cId) || { tickets: 0, players: new Set() };
      return {
        clan_id: clanId,
        clan_name: clan?.name || '???',
        symbol: clan?.symbol || '',
        contest_id: cId,
        members: memberCounts.get(clanId) || 0,
        total_tickets: t.tickets,
        total_participants: t.players.size,
      };
    }).sort((a, b) => b.total_tickets - a.total_tickets);

    return res.json({ contests, rules: CONTEST_RULES });
  } catch (err) {
    console.error('[admin/contest-overview]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Contest stats for ONE clan ────────────────────────────────
adminRouter.get('/contest-stats', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  try {
    const clanId = String(req.query.clan_id || '');
    if (!clanId) return res.status(400).json({ error: 'clan_id required' });
    const clan = gameState.clans.get(clanId);
    if (!clan) return res.status(404).json({ error: 'Clan not found' });
    const isActive = _activeClanIds().has(clanId);
    const contestId = getContestIdForClan(clanId);

    const { data: rows } = await supabase
      .from('contest_tickets')
      .select('player_id, reason, amount')
      .eq('contest_id', contestId);

    const byPlayer = new Map();
    for (const r of rows || []) {
      const cur = byPlayer.get(r.player_id) || { tickets: 0, mine: 0, ore: 0, mon: 0, don: 0 };
      cur.tickets += (r.amount || 0);
      if (r.reason === 'mine_destroy') cur.mine += r.amount;
      else if (r.reason === 'ore_capture') cur.ore += r.amount;
      else if (r.reason === 'monument_kill') cur.mon += r.amount;
      else if (r.reason === 'clan_donate') cur.don += r.amount;
      byPlayer.set(r.player_id, cur);
    }

    const leaderboard = [];
    for (const [tgId, stats] of byPlayer) {
      const p = gameState.loaded ? gameState.getPlayerByTgId(Number(tgId)) : null;
      leaderboard.push({
        telegram_id: Number(tgId),
        username: p?.game_username || p?.username || String(tgId),
        avatar: p?.avatar || '🎮',
        level: p?.level || 0,
        tickets: stats.tickets,
        mine: stats.mine,
        ore: stats.ore,
        mon: stats.mon,
        don: stats.don,
      });
    }
    leaderboard.sort((a, b) => b.tickets - a.tickets);

    return res.json({
      contest_id: contestId, clan_id: clanId, clan_name: clan.name,
      enabled: isActive,
      total_participants: leaderboard.length,
      total_tickets: leaderboard.reduce((s, x) => s + x.tickets, 0),
      leaderboard,
      rules: CONTEST_RULES,
    });
  } catch (err) {
    console.error('[admin/contest-stats]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Contest draw — pick 3 weighted random winners for ONE clan ──
adminRouter.post('/contest-draw', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  try {
    const clanId = String((req.body && req.body.clan_id) || req.query.clan_id || '');
    if (!clanId) return res.status(400).json({ error: 'clan_id required' });
    const clan = gameState.clans.get(clanId);
    if (!clan) return res.status(404).json({ error: 'Clan not found' });
    const contestId = getContestIdForClan(clanId);

    const { data: rows } = await supabase
      .from('contest_tickets')
      .select('player_id, amount')
      .eq('contest_id', contestId);

    const byPlayer = new Map();
    for (const r of rows || []) {
      byPlayer.set(r.player_id, (byPlayer.get(r.player_id) || 0) + (r.amount || 0));
    }
    const pool = [...byPlayer.entries()]
      .map(([player_id, tickets]) => ({ player_id: Number(player_id), tickets }))
      .filter(p => p.tickets > 0);
    if (pool.length === 0) return res.json({ winners: [], clan_id: clanId, clan_name: clan.name });

    const winners = [];
    for (let i = 0; i < 3 && pool.length > 0; i++) {
      const total = pool.reduce((s, p) => s + p.tickets, 0);
      let r = Math.random() * total;
      let idx = 0;
      for (let j = 0; j < pool.length; j++) {
        r -= pool[j].tickets;
        if (r <= 0) { idx = j; break; }
      }
      const w = pool.splice(idx, 1)[0];
      const p = gameState.loaded ? gameState.getPlayerByTgId(w.player_id) : null;
      winners.push({
        position: i + 1,
        telegram_id: w.player_id,
        tickets: w.tickets,
        username: p?.game_username || p?.username || String(w.player_id),
        avatar: p?.avatar || '🎮',
        level: p?.level || 0,
      });
    }

    return res.json({ contest_id: contestId, clan_id: clanId, clan_name: clan.name, winners });
  } catch (err) {
    console.error('[admin/contest-draw]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /players-list-all ────────────────────────────────────
adminRouter.get('/players-list-all', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  if (!gameState.loaded) return res.json({ players: [] });

  const offset = parseInt(req.query.offset, 10) || 0;
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);

  const all = [...gameState.players.values()]
    .sort((a, b) => {
      const ca = a.created_at ? new Date(a.created_at).getTime() : 0;
      const cb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return cb - ca;
    });

  const slice = all.slice(offset, offset + limit);
  const now = Date.now();
  const FIVE_MIN = 5 * 60 * 1000;

  const players = slice.map(p => {
    const lastSeen = p.last_seen ? new Date(p.last_seen).getTime() : 0;
    const ci = playerCityCache.get(String(p.telegram_id));
    return {
      id: p.id,
      telegram_id: p.telegram_id,
      username: p.game_username || p.username,
      avatar: p.avatar,
      level: p.level,
      coins: p.coins,
      diamonds: p.diamonds,
      is_banned: p.is_banned,
      online: now - lastSeen < FIVE_MIN,
      created_at: p.created_at,
      city: ci?.city || null,
    };
  });

  return res.json({ players, total: all.length });
});

// ── GET /player-referrals ───────────────────────────────────
adminRouter.get('/player-referrals', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });

  const playerTgId = req.query.player_telegram_id;
  if (!playerTgId) return res.status(400).json({ error: 'player_telegram_id required' });

  try {
    // Who referred this player
    const { data: referredBy } = await supabase
      .from('referrals')
      .select('referrer_id, created_at')
      .eq('referred_id', playerTgId)
      .limit(1);

    let referrer = null;
    if (referredBy?.length) {
      const rp = gameState.getPlayerByTgId(referredBy[0].referrer_id);
      referrer = {
        telegram_id: referredBy[0].referrer_id,
        id: rp?.id || null,
        username: rp?.game_username || rp?.username || String(referredBy[0].referrer_id),
        avatar: rp?.avatar || null,
        level: rp?.level || 0,
        created_at: referredBy[0].created_at,
      };
    }

    // Who this player referred
    const { data: referrals } = await supabase
      .from('referrals')
      .select('referred_id, level50_rewarded, created_at')
      .eq('referrer_id', playerTgId);

    const referred = (referrals || []).map(r => {
      const rp = gameState.getPlayerByTgId(r.referred_id);
      return {
        telegram_id: r.referred_id,
        id: rp?.id || null,
        username: rp?.game_username || rp?.username || String(r.referred_id),
        avatar: rp?.avatar || null,
        level: rp?.level || 0,
        level50_rewarded: r.level50_rewarded,
        created_at: r.created_at,
      };
    });

    return res.json({ referrer, referred });
  } catch (err) {
    console.error('[admin/player-referrals]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST ─────────────────────────────────────────────────────
adminRouter.post('/', async (req, res) => {
  const { enabled, action } = req.body;
  if (!isAdmin(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // ── clear-errors: clear recent errors array ──
  if (action === 'clear-errors') {
    global.recentErrors = [];
    return res.json({ success: true, cleared: true });
  }

  // ── fix-positions: snap all HQs and mines to cell centers ──
  if (action === 'fix-positions') {
    const [{ data: hqs }, { data: mines }] = await Promise.all([
      supabase.from('headquarters').select('id, cell_id'),
      supabase.from('mines').select('id, cell_id'),
    ]);

    const hqUpdates  = (hqs  || []).map(({ id, cell_id }) => {
      const [lat, lng] = getCellCenter(cell_id);
      return supabase.from('headquarters').update({ lat, lng }).eq('id', id);
    });
    const mineUpdates = (mines || []).map(({ id, cell_id }) => {
      const [lat, lng] = getCellCenter(cell_id);
      return supabase.from('mines').update({ lat, lng }).eq('id', id);
    });

    await Promise.all([...hqUpdates, ...mineUpdates]);
    return res.status(200).json({ fixed_hq: hqs?.length ?? 0, fixed_mines: mines?.length ?? 0 });
  }

  // ── fix-usernames: backfill owner_username on all headquarters ──
  if (action === 'fix-usernames') {
    const { data: allHQ } = await supabase.from('headquarters').select('id, player_id').limit(5000);
    if (allHQ?.length) {
      const playerIds = [...new Set(allHQ.map(h => h.player_id).filter(Boolean))];
      const { data: players } = await supabase.from('players').select('id, username').in('id', playerIds);
      const playerMap = {};
      for (const p of (players || [])) playerMap[p.id] = p.username;
      await Promise.all(allHQ.map(hq =>
        supabase.from('headquarters').update({ owner_username: playerMap[hq.player_id] ?? null }).eq('id', hq.id)
      ));
    }
    return res.status(200).json({ fixed: allHQ?.length ?? 0 });
  }

  // ── setup-webhook: register Telegram webhook URL ──
  if (action === 'setup-webhook') {
    const BOT = process.env.BOT_TOKEN;
    if (!BOT) return res.status(500).json({ error: 'BOT_TOKEN not set' });
    const webhookUrl = 'https://overthrow.ru:8443/api/telegram-webhook';
    const tgRes = await fetch(
      `https://api.telegram.org/bot${BOT}/setWebhook`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message', 'callback_query', 'pre_checkout_query'], secret_token: process.env.WEBHOOK_SECRET || '' }),
      }
    );
    const tgData = await tgRes.json();
    return res.json({ success: tgData.ok, description: tgData.description, webhookUrl });
  }

  // ── give-item: create and give item to player ──
  if (action === 'give-item') {
    const { player_id, type, rarity, upgrade_level } = req.body;
    if (!player_id || !type || !rarity) return res.status(400).json({ error: 'player_id, type, rarity required' });

    const VALID_TYPES = ['sword', 'axe', 'shield'];
    const VALID_RARITIES = ['common', 'uncommon', 'rare', 'epic', 'mythic', 'legendary'];
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid type' });
    if (!VALID_RARITIES.includes(rarity)) return res.status(400).json({ error: 'Invalid rarity' });

    const player = gameState.getPlayerById(player_id);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const plus = Math.max(0, Math.min(parseInt(req.body.plus) || 0, 3));
    const item = generateItem(type, rarity, plus);
    item.owner_id = player.id;
    item.upgrade_level = Math.max(0, Math.min(parseInt(upgrade_level) || 0, getMaxUpgradeLevel(rarity, plus)));

    // Apply upgrade stats
    const stats = getUpgradedStats(item);
    item.attack = stats.attack;
    item.defense = stats.defense;
    item.crit_chance = stats.crit_chance;
    item.block_chance = stats.block_chance;

    const insertData = {
      type: item.type, rarity: item.rarity, plus: item.plus || 0,
      name: item.name, emoji: item.emoji, stat_value: item.stat_value,
      owner_id: item.owner_id, equipped: false,
      attack: item.attack || 0, crit_chance: item.crit_chance || 0,
      defense: item.defense || 0, block_chance: item.block_chance || 0,
      base_attack: item.base_attack || 0, base_crit_chance: item.base_crit_chance || 0,
      base_defense: item.base_defense || 0, upgrade_level: item.upgrade_level,
    };
    const { data: inserted, error: insErr } = await supabase.from('items').insert(insertData).select().single();
    if (insErr) return res.status(500).json({ error: insErr.message });

    gameState.items.set(inserted.id, inserted);
    return res.json({ success: true, item: inserted });
  }

  // ── give-core: create and give core to player ──
  if (action === 'give-core') {
    const { player_id, core_type, level } = req.body;
    if (!player_id || !core_type) return res.status(400).json({ error: 'player_id, core_type required' });
    if (!CORE_TYPES[core_type]) return res.status(400).json({ error: 'Invalid core_type' });

    const player = gameState.getPlayerById(player_id);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const coreLevel = Math.max(0, Math.min(parseInt(level) || 0, 100));
    const core = {
      owner_id: Number(player.telegram_id),
      core_type,
      level: coreLevel,
      on_market: false,
      mine_cell_id: null,
      slot_index: null,
    };

    const { data: inserted, error: insErr } = await supabase.from('cores').insert(core).select().single();
    if (insErr) return res.status(500).json({ error: insErr.message });

    gameState.cores.set(inserted.id, inserted);
    return res.json({ success: true, core: inserted });
  }

  // ── place-hq: place headquarters for another player ──
  if (action === 'place-hq') {
    const { player_id, lat, lng } = req.body;
    if (!player_id || lat == null || lng == null) return res.status(400).json({ error: 'player_id, lat, lng required' });

    const player = gameState.getPlayerById(player_id);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    // Check if player already has HQ
    const existingHq = [...gameState.headquarters.values()].find(h => String(h.player_id) === String(player.id));
    if (existingHq) return res.status(409).json({ error: 'У игрока уже есть штаб' });

    const hqLat = parseFloat(lat);
    const hqLng = parseFloat(lng);
    const targetCell = getCellId(hqLat, hqLng);

    // Check cell availability
    const isCellFree = (cell) => !gameState.isCellOccupied(cell);

    let finalCell = null;
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

    const { data: hq, error: insertError } = await supabase.from('headquarters').insert({
      player_id: player.id,
      owner_username: player.game_username || player.username,
      lat: hqLat,
      lng: hqLng,
      cell_id: finalCell,
    }).select('id,player_id,lat,lng,cell_id,level,created_at').single();
    if (insertError) return res.status(500).json({ error: 'Failed to place headquarters: ' + insertError.message });

    if (gameState.loaded) gameState.upsertHq(hq);
    try { await addXp(player.id, XP_REWARDS.BUILD_HQ); } catch (e) { console.error('[xp] addXp error:', e.message); }

    logPlayer(player.telegram_id, 'action', `Admin placed HQ at ${hqLat},${hqLng}`);
    return res.json({ success: true, hq });
  }

  // ── remove-item: delete item from player inventory ──
  if (action === 'remove-item') {
    const { item_id } = req.body;
    if (!item_id) return res.status(400).json({ error: 'item_id required' });

    const item = gameState.items.get(item_id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    gameState.items.delete(item_id);
    await supabase.from('items').delete().eq('id', item_id);
    return res.json({ success: true, deleted: item_id });
  }

  // ── remove-core: delete core from player ──
  if (action === 'remove-core') {
    const { core_id } = req.body;
    if (!core_id) return res.status(400).json({ error: 'core_id required' });

    const core = gameState.cores.get(core_id);
    if (!core) return res.status(404).json({ error: 'Core not found' });

    gameState.cores.delete(core_id);
    await supabase.from('cores').delete().eq('id', core_id);
    return res.json({ success: true, deleted: core_id });
  }

  // ── deduct: remove currency from player ──
  if (action === 'deduct') {
    const { player_id, currency, amount } = req.body;
    if (!player_id || !currency || !amount) return res.status(400).json({ error: 'player_id, currency, amount required' });
    const VALID = ['coins', 'diamonds', 'crystals', 'ether'];
    if (!VALID.includes(currency)) return res.status(400).json({ error: `currency must be one of: ${VALID.join(', ')}` });
    const num = parseInt(amount, 10);
    if (isNaN(num) || num <= 0) return res.status(400).json({ error: 'amount must be positive' });

    const player = gameState.getPlayerById(player_id);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const current = player[currency] ?? 0;
    const newBalance = Math.max(0, current - num);
    const { error: updateErr } = await supabase.from('players').update({ [currency]: newBalance }).eq('id', player_id);
    if (updateErr) return res.status(500).json({ error: updateErr.message });

    player[currency] = newBalance;
    gameState.markDirty('players', player.id);
    return res.json({ success: true, currency, newBalance });
  }

  // ── reward: give coins, diamonds, crystals, or ether to a player ──
  if (action === 'reward') {
    const { player_id, player_name, currency, amount } = req.body;
    if ((!player_id && !player_name) || !currency || !amount) {
      return res.status(400).json({ error: 'player_id (or player_name), currency, amount are required' });
    }
    const VALID_CURRENCIES = ['coins', 'diamonds', 'crystals', 'ether'];
    if (!VALID_CURRENCIES.includes(currency)) {
      return res.status(400).json({ error: `currency must be one of: ${VALID_CURRENCIES.join(', ')}` });
    }
    const numAmount = parseInt(amount, 10);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    // Find player by id or by game_username
    let player;
    if (player_id) {
      const { data, error: fetchErr } = await supabase
        .from('players').select('id, telegram_id, coins, diamonds, crystals, ether').eq('id', player_id).single();
      if (fetchErr || !data) return res.status(404).json({ error: 'Player not found' });
      player = data;
    } else {
      // Try game_username first, then username
      let data, fetchErr;
      ({ data, error: fetchErr } = await supabase
        .from('players').select('id, telegram_id, game_username, username, coins, diamonds, crystals, ether').ilike('game_username', player_name).maybeSingle());
      if (!data) {
        ({ data, error: fetchErr } = await supabase
          .from('players').select('id, telegram_id, game_username, username, coins, diamonds, crystals, ether').ilike('username', player_name).maybeSingle());
      }
      if (fetchErr || !data) return res.status(404).json({ error: `Player "${player_name}" not found` });
      player = data;
    }

    const newBalance = (player[currency] ?? 0) + numAmount;
    const { error: updateErr } = await supabase
      .from('players').update({ [currency]: newBalance }).eq('id', player.id);
    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // Update gameState
    if (gameState.loaded) {
      const gp = gameState.getPlayerById(player.id);
      if (gp) { gp[currency] = newBalance; gameState.markDirty('players', gp.id); }
    }

    // Send Telegram notification
    const CURRENCY_LABELS = { coins: 'монет', diamonds: 'алмазов', crystals: 'осколков', ether: 'эфира' };
    const BOT = process.env.BOT_TOKEN;
    if (BOT && player.telegram_id) {
      const label = CURRENCY_LABELS[currency] || currency;
      const text = `🎁 Вам начислено ${numAmount.toLocaleString('ru')} ${label}!`;
      fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: player.telegram_id, text }),
      }).catch(e => console.error('[admin] TG error:', e.message));
    }

    return res.status(200).json({ success: true, player_id: player.id, currency, newBalance });
  }

  // ── ban: ban a player ──
  if (action === 'ban') {
    const { player_id, reason, duration_days } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });
    if (!reason) return res.status(400).json({ error: 'reason is required' });

    const days = parseInt(duration_days, 10);
    if (isNaN(days) || days < 0) return res.status(400).json({ error: 'Invalid duration_days' });

    const banUntil = days === 0 ? null : new Date(Date.now() + days * 86400000).toISOString();

    const { error } = await supabase
      .from('players')
      .update({
        is_banned: true,
        ban_reason: reason,
        ban_until: banUntil,
        banned_at: new Date().toISOString(),
      })
      .eq('id', player_id);
    if (error) return res.status(500).json({ error: error.message });

    // Update gameState so tick immediately sees the ban
    if (gameState.loaded) {
      const gp = gameState.getPlayerById(player_id);
      if (gp) {
        gp.is_banned = true;
        gp.ban_reason = reason;
        gp.ban_until = banUntil;
        gameState.markDirty('players', gp.id);
      }
    }

    // Notify player via Telegram
    const gp = gameState.loaded ? gameState.getPlayerById(player_id) : null;
    if (gp?.telegram_id) {
      const banLang = getLang(gameState, gp.telegram_id);
      const untilStr = banUntil ? new Date(banUntil).toLocaleDateString('ru') : ts(banLang, 'admin.ban_forever');
      sendTelegramNotification(gp.telegram_id, ts(banLang, 'admin.banned', { reason, until: untilStr }));
    }

    if (gp?.telegram_id) {
      logPlayer(gp.telegram_id, 'ban', `Забанен: ${reason}`, { reason, ban_until: banUntil });
    }
    return res.status(200).json({ success: true, banned: true, until: banUntil });
  }

  // ── unban: unban a player ──
  if (action === 'unban') {
    const { player_id } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });

    const { error } = await supabase
      .from('players')
      .update({ is_banned: false, ban_reason: null, ban_until: null })
      .eq('id', player_id);
    if (error) return res.status(500).json({ error: error.message });

    // Update gameState
    if (gameState.loaded) {
      const gp = gameState.getPlayerById(player_id);
      if (gp) {
        gp.is_banned = false;
        gp.ban_reason = null;
        gp.ban_until = null;
        gameState.markDirty('players', gp.id);
      }
    }

    // Reset antispoof violation counter
    const unbannedPlayer = gameState.loaded ? gameState.getPlayerById(player_id) : null;
    if (unbannedPlayer?.telegram_id) {
      resetSpoofRecord(unbannedPlayer.telegram_id);
      const unbanLang = getLang(gameState, unbannedPlayer.telegram_id);
      sendTelegramNotification(unbannedPlayer.telegram_id, ts(unbanLang, 'admin.unbanned'));
    }

    return res.status(200).json({ success: true, unbanned: true });
  }

  // ── fix-hq: remove duplicate headquarters (keep oldest per player) ──
  if (action === 'fix-hq') {
    const { data: allHqs, error: allError } = await supabase
      .from('headquarters')
      .select('id, player_id, created_at')
      .order('created_at', { ascending: true });

    if (allError) return res.status(500).json({ error: allError.message });

    const byPlayer = {};
    for (const hq of allHqs) {
      if (!byPlayer[hq.player_id]) byPlayer[hq.player_id] = [];
      byPlayer[hq.player_id].push(hq);
    }

    const toDelete = [];
    for (const [, hqs] of Object.entries(byPlayer)) {
      if (hqs.length > 1) {
        for (let i = 1; i < hqs.length; i++) toDelete.push(hqs[i].id);
      }
    }

    if (toDelete.length === 0) {
      return res.status(200).json({ success: true, deleted: 0, message: 'Дублей не найдено' });
    }

    const { error: delError } = await supabase.from('headquarters').delete().in('id', toDelete);
    if (delError) return res.status(500).json({ error: delError.message });

    return res.status(200).json({
      success: true,
      deleted: toDelete.length,
      message: `Удалено ${toDelete.length} дублей штабов`,
    });
  }

  // ── generate-markets: delete all old markets, run daily market check ──
  if (action === 'generate-markets') {
    // Delete all existing markets
    await supabase.from('markets').delete().neq('id', '00000000-0000-0000-0000-000000000000');

    // Clear markets from gameState
    if (gameState.loaded) {
      gameState.markets.clear();
    }

    log('[generate-markets] Deleted all old markets, running daily check...');

    // Run daily market check — will spawn markets near active players using Overpass
    try {
      await dailyMarketCheck();
    } catch (e) {
      console.error('[generate-markets] dailyMarketCheck error:', e.message);
    }

    // Return new markets
    const { data: newMarkets } = await supabase.from('markets').select('id,lat,lng,name').limit(200);
    return res.json({ generated: (newMarkets || []).length, markets: newMarkets || [] });
  }

  // ── maintenance-start: enable maintenance + notify all players ──
  if (action === 'maintenance-start') {
    const { message } = req.body;
    const { error: setErr } = await supabase
      .from('app_settings')
      .upsert({ key: 'maintenance_mode', value: 'true' }, { onConflict: 'key' });
    if (setErr) return res.status(500).json({ error: setErr.message });

    // Update in-memory cache
    gameState.appSettings.set('maintenance_mode', 'true');

    // Notify all connected clients via socket and disconnect non-admins
    io.emit('maintenance:started');
    let disconnected = 0;
    for (const [socketId, info] of connectedPlayers) {
      if (Number(info.telegram_id) === ADMIN_TG_ID) continue;
      const s = io.sockets.sockets.get(socketId);
      if (s) { s.disconnect(true); disconnected++; }
    }

    const text = message
      || '🔧 Начались технические работы. Игра временно недоступна. Следите за обновлениями!';
    const sent = await _notifyAllPlayers(text);
    return res.status(200).json({ success: true, maintenance: true, notified: sent, disconnected });
  }

  // ── maintenance-end: disable maintenance + notify all players ──
  if (action === 'maintenance-end') {
    const { message } = req.body;
    const { error: setErr } = await supabase
      .from('app_settings')
      .upsert({ key: 'maintenance_mode', value: 'false' }, { onConflict: 'key' });
    if (setErr) return res.status(500).json({ error: setErr.message });

    // Update in-memory cache
    gameState.appSettings.set('maintenance_mode', 'false');

    io.emit('maintenance:ended');

    const text = message
      || '✅ Технические работы завершены! Игра снова доступна. Удачной охоты! ⚔️';
    const sent = await _notifyAllPlayers(text);
    return res.status(200).json({ success: true, maintenance: false, notified: sent });
  }

  // ── force-ore-spawn: clear caches and trigger full ore spawn cycle ──
  if (action === 'force-ore-spawn') {
    const clearPoints = !!req.body.clear_points_cache;
    const errorsCleared = clearSpawnErrorCache();
    const pointsCleared = clearPoints ? clearSpawnPointsCache() : 0;
    const boundsCleared = clearCityBoundsCache();

    if (typeof global._citySpawnCycle === 'function') {
      global._citySpawnCycle().catch(e => console.error('[ADMIN] force-ore-spawn error:', e.message));
    }

    return res.json({
      success: true,
      errors_cleared: errorsCleared,
      points_cleared: pointsCleared,
      message: 'Spawn cycle triggered in background',
    });
  }

  // ── force-vase-spawn: trigger vase spawn for all cities ──
  if (action === 'force-vase-spawn') {
    clearCityBoundsCache();
    (async () => {
      try {
        const { getAllCityKeys, getCityBounds, getCityPlayerCount } = await import('../../lib/geocity.js');
        const { spawnVasesForCity } = await import('../../lib/vases.js');
        for (const cityKey of getAllCityKeys()) {
          const pc = getCityPlayerCount(cityKey);
          if (pc <= 0) continue;
          const cb = await getCityBounds(cityKey);
          if (!cb?.boundingbox) continue;
          await spawnVasesForCity(cityKey, cb.boundingbox, pc);
          await new Promise(r => setTimeout(r, 3000));
        }
        console.log('[ADMIN] force-vase-spawn complete');
      } catch (e) { console.error('[ADMIN] force-vase-spawn error:', e.message); }
    })();
    return res.json({ success: true, message: 'Vase spawn triggered in background' });
  }

  // ── maintenance toggle (default) ──
  const value = enabled ? 'true' : 'false';
  const { error } = await supabase
    .from('app_settings')
    .upsert({ key: 'maintenance_mode', value }, { onConflict: 'key' });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ maintenance: enabled });
});

// ── GET /reports — list player reports for moderation ─────────
adminRouter.get('/reports', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const showAll = req.query.status === 'all';
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

  let q = supabase.from('reports').select('*').order('created_at', { ascending: false }).limit(limit);
  if (!showAll) q = q.eq('status', 'pending');
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const enriched = (data || []).map(r => {
    const reporter = gameState.getPlayerByTgId(Number(r.reporter_id));
    const reported = gameState.getPlayerByTgId(Number(r.reported_id));
    return {
      ...r,
      reporter_name: reporter?.game_username || reporter?.username || '?',
      reported_name: reported?.game_username || reported?.username || '?',
      reported_avatar: reported?.avatar || '🐺',
      reported_level: reported?.level || 1,
      reported_banned: !!reported?.is_banned,
    };
  });
  return res.json({ reports: enriched });
});

// ── POST /reports/resolve — change report status ───────────────
adminRouter.post('/reports/resolve', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const { report_id, status } = req.body || {};
  if (!report_id || !['resolved', 'dismissed'].includes(status))
    return res.status(400).json({ error: 'Invalid params' });
  const { error } = await supabase.from('reports').update({ status }).eq('id', report_id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});
