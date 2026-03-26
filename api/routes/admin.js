import { Router } from 'express';
import os from 'os';
import { supabase, sendTelegramNotification } from '../../lib/supabase.js';
import { gameState } from '../../lib/gameState.js';
import { connectedPlayers } from '../../server.js';
import { log } from '../../lib/log.js';
import { getCellCenter } from '../../lib/grid.js';
import { haversine } from '../../lib/haversine.js';
import { dailyMarketCheck } from '../../lib/markets.js';
import { resetSpoofRecord } from '../../lib/antispoof.js';
import { getPlayerLogs, logPlayer } from '../../lib/logger.js';
import { playerCityCache } from '../../lib/geocity.js';
import { suspiciousActivity } from '../../security/rateLimit.js';
import { ts, getLang } from '../../config/i18n.js';
import { generateItem, getUpgradedStats } from '../../game/mechanics/items.js';

export const adminRouter = Router();
const ADMIN_TG_ID = 560013667;

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
  const { action, admin_id, search } = req.query || {};

  // ── players-list: search players by username ──
  if (action === 'players-list') {
    const adminId = parseInt(admin_id, 10);
    if (adminId !== ADMIN_TG_ID) return res.status(403).json({ error: 'Forbidden' });

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
  return res.status(200).json({ maintenance: data?.value === 'true' });
});

// ── GET /stats ───────────────────────────────────────────────
adminRouter.get('/stats', async (req, res) => {
  const tgId = req.query.telegram_id || req.headers['x-telegram-id'];
  if (String(tgId) !== '560013667') return res.status(403).json({ error: 'Admin only' });

  const now = Date.now();
  const FIVE_MIN = 5 * 60 * 1000;
  const ONE_DAY = 24 * 60 * 60 * 1000;

  let online_now = 0, online_today = 0, total_players = 0, new_today = 0;

  if (gameState.loaded) {
    total_players = gameState.players.size;
    for (const p of gameState.players.values()) {
      const lastSeen = p.last_seen ? new Date(p.last_seen).getTime() : 0;
      if (now - lastSeen < FIVE_MIN) online_now++;
      if (now - lastSeen < ONE_DAY) online_today++;
      const created = p.created_at ? new Date(p.created_at).getTime() : 0;
      if (now - created < ONE_DAY) new_today++;
    }
  }

  const memUsed = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const memTotal = Math.round(os.totalmem() / 1024 / 1024);

  return res.json({
    online_now,
    online_today,
    total_players,
    new_today,
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
    online_history: global.onlineHistory || [],
    recent_errors: (global.recentErrors || []).slice(0, 50),
    recent_activity: (global.recentActivity || []).slice(0, 30),
    recent_bans: getBannedPlayers(),
    suspicious_players: getSuspiciousPlayers(),
  });
});

// ── GET /player-search ───────────────────────────────────────
adminRouter.get('/player-search', (req, res) => {
  const tgId = req.query.admin_id || req.query.telegram_id;
  if (String(tgId) !== '560013667') return res.status(403).json({ error: 'Admin only' });

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
  const tgId = req.query.admin_id || req.query.telegram_id;
  if (String(tgId) !== '560013667') return res.status(403).json({ error: 'Admin only' });

  const playerTgId = parseInt(req.query.player_telegram_id, 10);
  if (!playerTgId) return res.status(400).json({ error: 'player_telegram_id required' });

  const filter = req.query.filter || 'all';
  const logs = getPlayerLogs(playerTgId, filter);
  return res.json({ logs });
});

// ── GET /player-details ──────────────────────────────────────
adminRouter.get('/player-details', (req, res) => {
  const tgId = req.query.admin_id || req.query.telegram_id;
  if (String(tgId) !== String(ADMIN_TG_ID)) return res.status(403).json({ error: 'Admin only' });

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
    },
    items,
    cores,
  });
});

// ── Referral leaderboard ──────────────────────────────────────
adminRouter.get('/referral-stats', async (req, res) => {
  const tgId = req.query.admin_id || req.query.telegram_id;
  if (String(tgId) !== String(ADMIN_TG_ID)) return res.status(403).json({ error: 'Admin only' });

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

// ── POST ─────────────────────────────────────────────────────
adminRouter.post('/', async (req, res) => {
  const { telegram_id, admin_id, enabled, action } = req.body;
  const tgId = parseInt(telegram_id || admin_id, 10);
  if (tgId !== ADMIN_TG_ID) {
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

    const item = generateItem(type, rarity);
    item.owner_id = player.id;
    item.upgrade_level = Math.max(0, Math.min(parseInt(upgrade_level) || 0, 100));

    // Apply upgrade stats
    const stats = getUpgradedStats(item);
    item.attack = stats.attack;
    item.defense = stats.defense;
    item.crit_chance = stats.crit_chance;
    item.block_chance = stats.block_chance;

    const { data: inserted, error: insErr } = await supabase.from('items').insert(item).select().single();
    if (insErr) return res.status(500).json({ error: insErr.message });

    gameState.items.set(inserted.id, inserted);
    return res.json({ success: true, item: inserted });
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
      }).catch(() => {});
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

    const text = message
      || '🔧 Начались технические работы. Игра временно недоступна. Следите за обновлениями!';
    const sent = await _notifyAllPlayers(text);
    return res.status(200).json({ success: true, maintenance: true, notified: sent });
  }

  // ── maintenance-end: disable maintenance + notify all players ──
  if (action === 'maintenance-end') {
    const { message } = req.body;
    const { error: setErr } = await supabase
      .from('app_settings')
      .upsert({ key: 'maintenance_mode', value: 'false' }, { onConflict: 'key' });
    if (setErr) return res.status(500).json({ error: setErr.message });

    const text = message
      || '✅ Технические работы завершены! Игра снова доступна. Удачной охоты! ⚔️';
    const sent = await _notifyAllPlayers(text);
    return res.status(200).json({ success: true, maintenance: false, notified: sent });
  }

  // ── maintenance toggle (default) ──
  const value = enabled ? 'true' : 'false';
  const { error } = await supabase
    .from('app_settings')
    .upsert({ key: 'maintenance_mode', value }, { onConflict: 'key' });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ maintenance: enabled });
});
