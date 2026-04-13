import dotenv from 'dotenv';
dotenv.config();

import crypto from 'crypto';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { playerRouter } from './routes/player.js';
import { buildingsRouter } from './routes/buildings.js';
import { botsRouter } from './routes/bots.js';
import { zombiesRouter } from './routes/zombies.js';
import { vasesRouter } from './routes/vases.js';
import { itemsRouter } from './routes/items.js';
import { shopRouter } from './routes/shop.js';
import { marketRouter } from './routes/market.js';
import { adminRouter } from './routes/admin.js';
import { clanRouter } from './routes/clan.js';
import { mapRouter } from './routes/map.js';
import { oreRouter } from './routes/ore.js';
import { monumentsRouter } from './routes/monuments.js';
import { collectorsRouter } from './routes/collectors.js';
import { fireTrucksRouter } from './routes/fireTrucks.js';
import { barracksRouter } from './routes/barracks.js';
import { coresRouter } from './routes/cores.js';
import { rewardsRouter } from './routes/rewards.js';
import { skillsRouter } from './routes/skills.js';
import { walkingRouter } from './routes/walking.js';
import { startGameLoop } from './socket/gameLoop.js';

import { log } from './lib/log.js';
import { haversine } from './lib/haversine.js';
import { supabase } from './lib/supabase.js';
import { gameState } from './lib/gameState.js';
import { startPersistLoop } from './lib/persist.js';
import { WEAPON_COOLDOWNS } from './config/constants.js';
import { getPlayerSkillEffects } from './config/skills.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Admin monitoring ──
global.recentErrors = [];
global.recentActivity = [];
global.onlineHistory = [];

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.message || err);
  global.recentErrors.unshift({
    id: Date.now(),
    time: new Date().toLocaleTimeString('ru'),
    date: new Date().toLocaleDateString('ru'),
    message: String(err?.message || err).slice(0, 200),
    stack: err?.stack || 'No stack trace',
    type: 'unhandledRejection',
  });
  if (global.recentErrors.length > 100) global.recentErrors.pop();
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.message || err);
  global.recentErrors.unshift({
    id: Date.now(),
    time: new Date().toLocaleTimeString('ru'),
    date: new Date().toLocaleDateString('ru'),
    message: String(err?.message || err).slice(0, 200),
    stack: err?.stack || 'No stack trace',
    type: 'uncaughtException',
  });
  if (global.recentErrors.length > 100) global.recentErrors.pop();
});

export function logActivity(playerName, action) {
  global.recentActivity.unshift({ time: new Date().toLocaleTimeString('ru'), player: playerName || '?', action });
  if (global.recentActivity.length > 100) global.recentActivity.pop();
}

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  perMessageDeflate: { threshold: 1024 },
  transports: ['websocket', 'polling'],
});

import { validateRequest, checkBan } from './lib/security.js';
import { rateLimitMw } from './lib/rateLimit.js';
import { verifyTelegramAuth, verifyInitData } from './security/telegramAuth.js';
import { validatePosition, seedPositionFromDB, setPlayerHq, sendHourlyDigest, isPinModeActive } from './security/antispoof.js';
import { isInShadow } from './config/skills.js';

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '100kb' }));
app.use(validateRequest);
app.use('/api', verifyTelegramAuth);
app.use('/api', checkBan);

// Position freshness gate — reject distance-dependent actions when the player's
// last validated position is stale (>60s). Prevents spoofers from parking their
// virtual position somewhere and then acting without sending ongoing location
// updates (which would expose them to antispoof detection).
const POSITION_ACTIONS = new Set([
  'build', 'collect', 'hit', 'break', 'claim', 'attack', 'extinguish', 'dispatch',
  'deliver', 'pickup-drop', 'attack-courier', 'lure', 'repel',
  'attack-shield', 'attack-monument', 'attack-defender', 'open-loot-box',
  'send-scout', 'attack-scout', 'hit-firefighter', 'spawn-scout',
]);
const POSITION_MAX_AGE_MS = 60000;
app.use('/api', (req, res, next) => {
  if (req.method !== 'POST') return next();
  const action = req.body?.action;
  if (!action || !POSITION_ACTIONS.has(action)) return next();
  const tgId = req.body?.telegram_id;
  if (!tgId) return next();
  if (!gameState.loaded) return next();
  const player = gameState.getPlayerByTgId(Number(tgId));
  if (!player?.last_seen) return next(); // first connection — let route handle null-position
  const age = Date.now() - new Date(player.last_seen).getTime();
  if (age > POSITION_MAX_AGE_MS) {
    return res.status(400).json({ error: 'Обновите позицию', stale: true });
  }
  next();
});

// Rate limiting per route type
app.use('/api/map', rateLimitMw('tick'));
app.use('/api/player', rateLimitMw('location'));
app.use('/api/buildings', rateLimitMw('build'));
app.use('/api/bots', rateLimitMw('attack'));
app.use('/api/zombies', rateLimitMw('attack'));
app.use('/api/market', rateLimitMw('market'));
app.use('/api/collectors', rateLimitMw('attack'));
app.use('/api/ore', rateLimitMw('attack'));
app.use('/api/monuments', rateLimitMw('attack'));
app.use('/api/barracks', rateLimitMw('attack'));
app.use('/api/fire-trucks', rateLimitMw('attack'));
app.use('/api/cores', rateLimitMw('default'));
app.use('/api/items', rateLimitMw('default'));
app.use('/api/clan', rateLimitMw('default'));
app.use('/api/walking', rateLimitMw('default'));

// Serve static frontend files (no cache for index.html to ensure updates)
app.use(express.static(join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Health check (public)
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    players: connectedPlayers.size,
    uptime: process.uptime(),
    gameState: gameState.loaded ? gameState.stats() : 'not loaded',
  });
});

// Detailed health (localhost only — for smoke tests)
app.get('/api/health', (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || '';
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'Local only' });
  }
  res.json({
    gameState: {
      loaded: gameState.loaded,
      mines: gameState.mines.size,
      players: gameState.players.size,
      monuments: gameState.monuments.size,
      collectors: gameState.collectors.size,
      oreNodes: gameState.oreNodes.size,
      bots: gameState.bots.size,
      couriers: gameState.couriers.size,
      items: gameState.items.size,
      vases: gameState.vases.size,
      markets: gameState.markets.size,
    },
    uptime: process.uptime(),
    memory: process.memoryUsage().rss,
  });
});

// ── Telegram Bot Webhook (callback_query, payments) ──
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
app.post('/api/telegram-webhook', async (req, res) => {
  // Verify Telegram webhook signature
  if (WEBHOOK_SECRET) {
    const token = req.headers['x-telegram-bot-api-secret-token'] || '';
    try {
      if (!token || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(WEBHOOK_SECRET)))
        return res.status(403).json({ error: 'Forbidden' });
    } catch { return res.status(403).json({ error: 'Forbidden' }); }
  }

  // Payment events: forward to items handler (must respond before res.json)
  if (req.body?.pre_checkout_query || req.body?.message?.successful_payment) {
    try {
      const { handleStarsWebhook } = await import('./api/routes/items.js');
      return handleStarsWebhook(req, res);
    } catch (e) {
      console.error('[webhook] payment handler error:', e.message);
      return res.json({ ok: true });
    }
  }

  // Handle /start command
  const msg = req.body?.message;
  if (msg?.text?.startsWith('/start') && msg.chat?.id) {
    res.json({ ok: true });
    const BOT = process.env.BOT_TOKEN;
    if (!BOT) return;
    try {
      const chatId = msg.chat.id;
      const fromId = msg.from?.id;
      const name = msg.from?.first_name || 'Игрок';

      // Parse referral deep link: /start ref_123456
      const startParam = msg.text.split(' ')[1];
      if (startParam && startParam.startsWith('ref_') && fromId) {
        const referrerId = parseInt(startParam.replace('ref_', ''), 10);
        if (referrerId && referrerId !== fromId) {
          // Validate: referrer must exist as a player, referred must NOT exist yet
          const referrerExists = gameState.loaded && gameState.getPlayerByTgId(referrerId);
          const referredExists = gameState.loaded && gameState.getPlayerByTgId(fromId);
          if (referrerExists && !referredExists) {
            pendingReferrals.set(fromId, referrerId);
            console.log(`[referral] Pending: ${fromId} referred by ${referrerId}`);
          } else {
            console.log(`[referral] Rejected: referrer=${referrerId} exists=${!!referrerExists}, referred=${fromId} exists=${!!referredExists}`);
          }
        }
      }

      const welcomeText = `⚔️ *Добро пожаловать в Overthrow, ${name}!*\n\n🌍 Геолокационная стратегия в реальном мире.\n\n🏗️ Строй шахты\n⛏️ Добывай ресурсы\n⚔️ Сражайся с игроками\n🏛️ Рейди монументы\n\nНажми кнопку ниже чтобы начать игру! 👇`;
      const resp = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: welcomeText,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [
              [{ text: '🎮 Играть', web_app: { url: 'https://overthrow.ru:8443' } }],
              [{ text: '💬 Чат игры', url: 'https://t.me/overthrowglobal' }, { text: '📢 Новости', url: 'https://t.me/OverthrowInsider' }],
              [{ text: '🔗 Реферальная ссылка', callback_data: 'get_referral_link' }],
            ] },
        }),
      });
      const sentMsg = await resp.json();
      // Pin the welcome message
      if (sentMsg.ok && sentMsg.result?.message_id) {
        await fetch(`https://api.telegram.org/bot${BOT}/pinChatMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, message_id: sentMsg.result.message_id, disable_notification: true }),
        }).catch(e => console.error('[server] error:', e.message));
      }
    } catch (e) { console.error('[webhook] /start error:', e.message); }
    return;
  }

  res.json({ ok: true }); // respond immediately for other updates
  try {
    const cb = req.body?.callback_query;
    if (!cb) return;
    const data = cb.data || '';
    const chatId = cb.message?.chat?.id;
    const msgId = cb.message?.message_id;
    const BOT = process.env.BOT_TOKEN;
    if (!BOT || !chatId) return;

    const answerCallback = (text) =>
      fetch(`https://api.telegram.org/bot${BOT}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cb.id, text }),
      }).catch(e => console.error('[server] error:', e.message));

    const editMessage = (text) =>
      fetch(`https://api.telegram.org/bot${BOT}/editMessageText`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: msgId, text }),
      }).catch(e => console.error('[server] error:', e.message));

    if (data === 'get_referral_link') {
      const tgId = cb.from?.id;
      if (!tgId) return;
      const link = `https://t.me/OverthrowGamebot?start=ref_${tgId}`;
      await answerCallback('Ссылка отправлена!');
      await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `🔗 *Твоя реферальная ссылка:*\n\n\`${link}\`\n\n📋 Друг получит *50 💎* сразу при регистрации\n🏆 Когда друг достигнет *5 уровня* — ты получишь *50 💎*\n🏆 Когда друг достигнет *50 уровня* — ты получишь ещё *100 💎*`,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [
            [{ text: '📤 Поделиться', url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Играй в Overthrow — геолокационную стратегию! Присоединяйся по моей ссылке и получи 50 💎')}` }],
          ] },
        }),
      });
      return;

    } else if (data.startsWith('confirm_ban_')) {
      const tgId = parseInt(data.replace('confirm_ban_', ''), 10);
      await answerCallback('Бан подтверждён');
      await editMessage(`✅ Бан игрока ${tgId} подтверждён администратором.`);
    } else if (data.startsWith('unban_')) {
      const tgId = parseInt(data.replace('unban_', ''), 10);
      const { supabase: sb } = await import('./lib/supabase.js');
      await sb.from('players').update({ is_banned: false, ban_reason: null, ban_until: null }).eq('telegram_id', tgId);
      if (gameState.loaded) {
        const p = gameState.getPlayerByTgId(tgId);
        if (p) { p.is_banned = false; p.ban_reason = null; p.ban_until = null; gameState.markDirty('players', p.id); }
      }
      const { resetSpoofRecord: reset } = await import('./lib/antispoof.js');
      reset(tgId);
      await answerCallback('Игрок разбанен');
      await editMessage(`✅ Игрок ${tgId} разбанен.`);
      const { sendTelegramNotification: notify } = await import('./lib/supabase.js');
      const { ts: _ts, getLang: _gl } = await import('./config/i18n.js');
      notify(tgId, _ts(_gl(gameState, tgId), 'admin.unbanned'));

    } else if (data.startsWith('approve_monument_')) {
      const reqId = parseInt(data.replace('approve_monument_', ''), 10);
      const { supabase: sb, sendTelegramNotification: notify } = await import('./lib/supabase.js');
      const { MONUMENT_HP: MHP, MONUMENT_SHIELD_HP: MSHP } = await import('./config/constants.js');
      const { getCellId } = await import('./lib/grid.js');
      const { data: mreq } = await sb.from('monument_requests').select('*').eq('id', reqId).single();
      if (!mreq) { await answerCallback('Заявка не найдена'); return; }
      if (mreq.status !== 'pending') { await answerCallback('Заявка уже обработана'); return; }

      const cell_id = getCellId(mreq.lat, mreq.lng);

      // Displace existing building on this cell
      if (gameState.loaded) {
        let displaced = null;
        for (const m of gameState.mines.values()) {
          if (m.cell_id === cell_id && m.status !== 'destroyed') { displaced = { type: 'mine', obj: m, table: 'mines' }; break; }
        }
        if (!displaced) for (const c of gameState.collectors.values()) {
          if (c.cell_id === cell_id) { displaced = { type: 'collector', obj: c, table: 'collectors' }; break; }
        }
        if (!displaced) for (const ft of gameState.fireTrucks.values()) {
          if (ft.cell_id === cell_id && ft.status !== 'destroyed') { displaced = { type: 'fire_truck', obj: ft, table: 'fire_trucks' }; break; }
        }
        if (!displaced) for (const h of gameState.headquarters.values()) {
          if (h.cell_id === cell_id) { displaced = { type: 'hq', obj: h, table: 'headquarters' }; break; }
        }
        if (!displaced) for (const ch of gameState.clanHqs.values()) {
          if (ch.cell_id === cell_id) { displaced = { type: 'clan_hq', obj: ch, table: 'clan_headquarters' }; break; }
        }
        if (!displaced) for (const b of gameState.barracks.values()) {
          if (b.cell_id === cell_id) { displaced = { type: 'barracks', obj: b, table: 'barracks' }; break; }
        }

        if (displaced) {
          const ownerId = displaced.obj.owner_id || displaced.obj.player_id;

          // Uninstall cores from mine
          if (displaced.type === 'mine') {
            const cores = gameState.getCoresForMine(cell_id);
            for (const c of cores) {
              c.mine_cell_id = null; c.slot_index = null;
              gameState.markDirty('cores', c.id);
            }
            if (cores.length > 0) {
              await sb.from('cores').update({ mine_cell_id: null, slot_index: null }).eq('mine_cell_id', cell_id);
            }
          }

          // Delete building from DB
          await sb.from(displaced.table).delete().eq('id', displaced.obj.id);

          // Remove from gameState
          if (displaced.type === 'mine') gameState.removeMine(displaced.obj.id);
          else if (displaced.type === 'collector') gameState.collectors.delete(displaced.obj.id);
          else if (displaced.type === 'fire_truck') gameState.fireTrucks.delete(displaced.obj.id);
          else if (displaced.type === 'hq') { gameState.hqByPlayerId.delete(displaced.obj.player_id); gameState.headquarters.delete(displaced.obj.id); }
          else if (displaced.type === 'clan_hq') gameState.clanHqs.delete(displaced.obj.id);
          else if (displaced.type === 'barracks') gameState.barracks.delete(displaced.obj.id);

          // Notify building owner
          const ownerPlayer = gameState.getPlayerById(ownerId);
          if (ownerPlayer) {
            notify(ownerPlayer.telegram_id, `⚠️ Ваша постройка снесена для размещения монумента ${mreq.emoji} ${mreq.name}. Ядра возвращены в инвентарь.`).catch(e => console.error('[server] error:', e.message));
          }
          console.log(`[MONUMENTS] Displaced ${displaced.type} (${displaced.obj.id}) on cell ${cell_id} for monument #${reqId}`);
        }
      }

      const monument = {
        id: crypto.randomUUID(),
        lat: mreq.lat, lng: mreq.lng, cell_id,
        name: mreq.name, emoji: mreq.emoji, level: mreq.level,
        hp: MHP[mreq.level], max_hp: MHP[mreq.level],
        shield_hp: MSHP[mreq.level], max_shield_hp: MSHP[mreq.level],
        phase: 'shield', waves_triggered: [],
        created_at: new Date().toISOString(),
      };
      await sb.from('monuments').insert(monument);
      if (gameState.loaded) gameState.monuments.set(monument.id, monument);

      await sb.from('monument_requests').update({ status: 'approved', reviewed_at: new Date().toISOString() }).eq('id', reqId);
      const { ts: _ts2, getLang: _gl2 } = await import('./config/i18n.js');
      const _pLang = _gl2(gameState, mreq.player_id);
      notify(mreq.player_id, _ts2(_pLang, 'monreq.approved', { id: reqId, emoji: mreq.emoji, name: mreq.name, level: mreq.level })).catch(e => console.error('[server] error:', e.message));
      await editMessage(`✅ ОДОБРЕНО — Заявка #${reqId}\n${mreq.emoji} ${mreq.name} lv${mreq.level}\nМонумент создан!`);
      await answerCallback('✅ Монумент создан!');
      console.log(`[MONUMENTS] Request #${reqId} approved, monument created`);

    } else if (data.startsWith('reject_monument_')) {
      const reqId = parseInt(data.replace('reject_monument_', ''), 10);
      const { supabase: sb, sendTelegramNotification: notify } = await import('./lib/supabase.js');
      const { data: mreq } = await sb.from('monument_requests').select('*').eq('id', reqId).single();
      if (!mreq || mreq.status !== 'pending') { await answerCallback('Заявка не найдена или уже обработана'); return; }

      await sb.from('monument_requests').update({ status: 'rejected', reviewed_at: new Date().toISOString() }).eq('id', reqId);
      await editMessage(`❌ ОТКЛОНЕНО — Заявка #${reqId}\n${mreq.emoji} ${mreq.name}`);
      await answerCallback('❌ Заявка отклонена');
    }
  } catch (e) {
    console.error('[webhook] callback error:', e.message);
  }
});

// API Routes
app.use('/api/player', playerRouter);
app.use('/api/buildings', buildingsRouter);
app.use('/api/map', mapRouter);
app.use('/api/bots', botsRouter);
app.use('/api/zombies', zombiesRouter);
app.use('/api/vases', vasesRouter);
app.use('/api/items', itemsRouter);
app.use('/api/shop', shopRouter);
app.use('/api/market', marketRouter);
app.use('/api/admin', adminRouter);
app.use('/api/clan', clanRouter);
app.use('/api/ore', oreRouter);
app.use('/api/monuments', monumentsRouter);
app.use('/api/collectors', collectorsRouter);
app.use('/api/fire-trucks', fireTrucksRouter);
app.use('/api/barracks', barracksRouter);
app.use('/api/cores', coresRouter);
app.use('/api/rewards', rewardsRouter);
app.use('/api/skills', skillsRouter);
app.use('/api/walking', walkingRouter);

// Catch unhandled route errors
app.use((err, req, res, next) => {
  const telegramId = req.body?.telegram_id || req.query?.telegram_id;
  const player = telegramId ? gameState.getPlayerByTgId(telegramId) : null;
  global.recentErrors.unshift({
    id: Date.now(),
    time: new Date().toLocaleTimeString('ru'),
    date: new Date().toLocaleDateString('ru'),
    message: String(err?.message || err).slice(0, 300),
    stack: err?.stack || 'No stack trace',
    type: 'route_error',
    player: player?.game_username || null,
    endpoint: req.path,
  });
  if (global.recentErrors.length > 100) global.recentErrors.pop();
  console.error(`[ROUTE ERROR] ${req.path}:`, err);
  res.status(500).json({ error: 'Internal server error' });
});

// Fallback: serve index.html for any non-API route (SPA)
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/') && !req.path.startsWith('/socket.io/')) {
    res.sendFile(join(__dirname, 'public', 'index.html'));
  }
});

// Connected players map
export const connectedPlayers = new Map();

// Single-session enforcement: telegram_id → socketId (only one active session per player)
const playerSessions = new Map();

// Pending referrals: telegram_id of new player -> telegram_id of referrer
export const pendingReferrals = new Map();

// Online history (5min snapshots, keep 288 = 24h)
setInterval(() => {
  const now = new Date();
  const time = now.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  global.onlineHistory.push({ time, count: connectedPlayers.size });
  if (global.onlineHistory.length > 288) global.onlineHistory.shift();
}, 5 * 60 * 1000);

// Rate-limit map for projectile attacks (telegram_id -> timestamp)
export const lastAttackTime = new Map();

// Record attack: update cooldown + break shield if active
export function recordAttack(telegramId, now) {
  const tgStr = String(telegramId);
  lastAttackTime.set(tgStr, now || Date.now());
  // Break shield on attack
  if (gameState.loaded) {
    const p = gameState.getPlayerByTgId(Number(telegramId));
    if (p?.shield_until && new Date(p.shield_until) > new Date()) {
      p.shield_until = null;
      gameState.markDirty('players', p.id);
      supabase.from('players').update({ shield_until: null }).eq('id', p.id).then(() => {}).catch(e => console.error('[server] DB error:', e.message));
    }
  }
}

// Centralized attack cooldown — single source of truth for all routes
export function getAttackCooldown(telegramId) {
  const player = gameState.getPlayerByTgId(Number(telegramId));
  if (!player) return WEAPON_COOLDOWNS.none;
  const items = gameState.getPlayerItems(player.id);
  const weapon = items.find(i => (i.type === 'sword' || i.type === 'axe' || i.type === 'bow') && i.equipped);
  const weaponType = weapon ? weapon.type : 'none';
  const baseCd = WEAPON_COOLDOWNS[weaponType] ?? 500;
  const fx = getPlayerSkillEffects(gameState.getPlayerSkills(telegramId));
  return Math.max(100, Math.floor(baseCd * (1 - (fx.attack_speed_bonus || 0))));
}

// Socket.io
io.on('connection', (socket) => {
  console.log('[socket] Connected:', socket.id, 'total:', connectedPlayers.size + 1);

  socket.on('player:init', (data) => {
    // Verify initData — only source of truth for telegram_id
    if (!data.initData) {
      console.warn('[socket] No initData, disconnecting');
      socket.disconnect(true);
      return;
    }
    const result = verifyInitData(data.initData);
    if (!result.valid) {
      console.warn('[socket] Invalid initData:', result.reason);
      socket.disconnect(true);
      return;
    }
    const verifiedTgId = result.user.id;

    // ── Single-session enforcement: kick previous session ──
    const existingSocketId = playerSessions.get(verifiedTgId);
    if (existingSocketId && existingSocketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(existingSocketId);
      if (oldSocket) {
        oldSocket.emit('session:kicked', { reason: 'new_session' });
        // Remove from connectedPlayers BEFORE disconnect to avoid marking offline
        connectedPlayers.delete(existingSocketId);
        playerSessions.delete(verifiedTgId);
        oldSocket.disconnect(true);
        console.log(`[session] Kicked old session ${existingSocketId} for player ${verifiedTgId}`);
      }
    }
    playerSessions.set(verifiedTgId, socket.id);

    let playerDbId = null;
    if (verifiedTgId && gameState.loaded) {
      const p = gameState.getPlayerByTgId(verifiedTgId);
      if (p) {
        playerDbId = p.id;
        // Seed antispoof history from last known DB position for cross-session teleport detection
        seedPositionFromDB(verifiedTgId, p.last_lat, p.last_lng, p.last_seen);
        // Cache HQ position for PIN jump detection
        const hq = gameState.getHqByPlayerId(p.id);
        if (hq) setPlayerHq(verifiedTgId, hq.lat, hq.lng);
        // Handle death state on reconnect
        if (p.is_dead) {
          const respawnAt = p._respawn_at ? new Date(p._respawn_at).getTime() : 0;
          const remaining = Math.max(0, respawnAt - Date.now());
          if (remaining <= 0) {
            // Timer expired — respawn immediately
            p.is_dead = false;
            p.hp = 1000 + (p.bonus_hp || 0);
            p._respawn_at = null;
            p.last_hp_regen = null;
            p.shield_until = new Date(Date.now() + 2 * 60 * 1000).toISOString();
            gameState.markDirty('players', p.id);
          } else {
            // Still dead — re-show death screen with remaining time
            setTimeout(() => {
              io.to(socket.id).emit('player:died', {
                respawn_in: Math.ceil(remaining / 1000),
                killer: 'Reconnect',
              });
            }, 500);
          }
        }
      }
    }
    connectedPlayers.set(socket.id, {
      telegram_id: verifiedTgId,
      player_db_id: playerDbId,
      lat: data.lat,
      lng: data.lng,
      lastState: null
    });
    console.log('[socket] Player init:', verifiedTgId, 'db_id:', playerDbId, 'total:', connectedPlayers.size);

    // Sync position to gameState immediately so distance checks work before first player:location
    if (verifiedTgId && data.lat && data.lng) {
      const p = gameState.getPlayerByTgId(verifiedTgId);
      if (p) {
        p.last_lat = data.lat;
        p.last_lng = data.lng;
        p.last_seen = new Date().toISOString();
        gameState.markDirty('players', p.id);
      }
    }

    // Update player city cache for city-based spawning
    if (verifiedTgId && data.lat && data.lng) {
      import('./lib/geocity.js').then(({ updatePlayerCity }) => {
        updatePlayerCity(verifiedTgId, data.lat, data.lng).catch(e => console.error('[server] error:', e.message));
      }).catch(e => console.error('[server] error:', e.message));
    }
  });

  socket.on('player:location', (data) => {
    if (!data?.lat || !data?.lng) return;
    const player = connectedPlayers.get(socket.id);
    if (!player) return;

    // Use verified telegram_id from connectedPlayers, not from client data
    const verifiedTgId = player.telegram_id;

    // Validate position through antispoof
    const validation = validatePosition(verifiedTgId, data.lat, data.lng, false, {
      accuracy: data.accuracy || null,
      altitude: data.altitude ?? null,
      altitudeAccuracy: data.altitudeAccuracy ?? null,
      gpsSpeed: data.gpsSpeed ?? null,
      heading: data.heading ?? null,
    });
    if (!validation.valid) return;

    // ── Walking distance tracking (skip PIN mode teleports) ──
    const pinActive = isPinModeActive(verifiedTgId);
    if (pinActive) {
      // Reset prev pos so PIN→real transition doesn't count as walked distance
      player._walkPrevPos = null;
    } else {
      const prev = player._walkPrevPos;
      if (prev) {
        const dt = Date.now() - prev.t;
        if (dt > 0) {
          const dist = haversine(prev.lat, prev.lng, data.lat, data.lng);
          const speedKmh = (dist / dt) * 3600; // m/ms → km/h
          if (speedKmh <= 25 && dist >= 2 && dist <= 2000) {
            const gsP = gameState.loaded ? gameState.getPlayerByTgId(verifiedTgId) : null;
            if (gsP) {
              gsP.walk_daily_m = (gsP.walk_daily_m || 0) + dist;
              gsP.walk_weekly_m = (gsP.walk_weekly_m || 0) + dist;
              gameState.markDirty('players', gsP.id);
            }
          }
        }
      }
      player._walkPrevPos = { lat: data.lat, lng: data.lng, t: Date.now() };
    }

    player.lat = data.lat;
    player.lng = data.lng;

    // Update city cache (rate-limited internally to 1h)
    if (verifiedTgId) {
      import('./lib/geocity.js').then(({ updatePlayerCity }) => {
        updatePlayerCity(verifiedTgId, data.lat, data.lng).catch(e => console.error('[server] error:', e.message));
      }).catch(e => console.error('[server] error:', e.message));
    }

    // Broadcast to nearby players (2km) with player info for instant marker creation.
    // SHADOW SKILL: a player using Shadow ability is invisible to others. We must
    // not leak their position or username, otherwise the core stealth mechanic
    // is broken. We still send the event (so the client can clean up the marker
    // if it had one), but with masked fields and a flag the client can read.
    const gsPlayer = gameState.loaded ? gameState.getPlayerByTgId(verifiedTgId) : null;
    const inShadow = isInShadow(gsPlayer);
    const movePayload = inShadow ? {
      telegram_id: 0,
      lat: null, lng: null,
      id: null, avatar: '🎮',
      level: gsPlayer?.level || 0, shield_until: null,
      username: '???',
      shadow: true,
    } : {
      telegram_id: verifiedTgId,
      lat: data.lat, lng: data.lng,
      id: gsPlayer?.id, avatar: gsPlayer?.avatar,
      level: gsPlayer?.level, shield_until: gsPlayer?.shield_until,
      username: gsPlayer?.game_username || gsPlayer?.username,
    };
    if (!inShadow) {
      for (const [sid, other] of connectedPlayers) {
        if (sid === socket.id || !other.lat) continue;
        if (haversine(data.lat, data.lng, other.lat, other.lng) <= 2000) {
          io.to(sid).emit('player:moved', movePayload);
        }
      }
    }

    // Update in-memory state
    if (verifiedTgId) {
      const p = gameState.getPlayerByTgId(verifiedTgId);
      if (p) {
        p.last_lat = data.lat;
        p.last_lng = data.lng;
        p.last_seen = new Date().toISOString();
        gameState.markDirty('players', p.id);
      }
    }
  });

  socket.on('disconnect', () => {
    const player = connectedPlayers.get(socket.id);
    if (player?.telegram_id) {
      // Clean up session map only if THIS socket is the current session
      if (playerSessions.get(player.telegram_id) === socket.id) {
        playerSessions.delete(player.telegram_id);
      }
      // Clean up attack cooldown to prevent memory leak
      lastAttackTime.delete(String(player.telegram_id));
      if (gameState.loaded) {
        const p = gameState.getPlayerByTgId(player.telegram_id);
        if (p) {
          // Mark as offline — no need to check for other sockets (single-session enforced)
          p.last_seen = new Date(Date.now() - 6 * 60 * 1000).toISOString();
          gameState.markDirty('players', p.id);
        }
      }
    }
    connectedPlayers.delete(socket.id);
    log('Disconnected:', socket.id);
  });
});

// Export io for push events
export { io, gameState };

// Lazy-loaded constants for monument loop
let _monumentConstants = null;

// ── Monument game loop ──
function startMonumentLoop() {
  setInterval(async () => {
    if (!require_monuments) return;
    if (!_monumentConstants) _monumentConstants = await import('./config/constants.js');
    const { MONUMENT_WAVE_REGEN_PERCENT, MONUMENT_DEFENDER_DAMAGE, MONUMENT_DEFENDER_ATTACK_CD, MONUMENT_DEFENDER_SPEED, PLAYER_RESPAWN_TIME } = _monumentConstants;
    const { MONUMENT_LEVELS, MONUMENT_ATTACK_RADIUS, getPlayersNearMonument, checkWaveComplete } = require_monuments;
    const now = Date.now();

    // ── Auto-respawn dead players ──
    for (const player of gameState.players.values()) {
      if (!player.is_dead || !player._respawn_at) continue;
      if (now < new Date(player._respawn_at).getTime()) continue;
      player.is_dead = false;
      player.hp = 1000 + (player.bonus_hp || 0);
      player._respawn_at = null;
      player.last_hp_regen = null;
      player.shield_until = new Date(now + 2 * 60 * 1000).toISOString(); // 2min shield after respawn
      gameState.markDirty('players', player.id);
      // Find socket and emit respawn
      for (const [sid, info] of connectedPlayers) {
        if (String(info.telegram_id) === String(player.telegram_id)) {
          io.to(sid).emit('player:respawned', { shield_until: player.shield_until });
          break;
        }
      }
    }

    for (const [id, monument] of gameState.monuments) {
      try {
        // Respawn with level progression
        if (monument.phase === 'defeated' && monument.respawn_at) {
          const respawnTime = new Date(monument.respawn_at).getTime();
          if (now >= respawnTime) {
            // Apply pending level (lv1→lv2, ..., lv10→lv1)
            const newLevel = monument._pending_level || (monument.level >= 10 ? 1 : monument.level + 1);
            monument.level = newLevel;
            delete monument._pending_level;
            const cfg = MONUMENT_LEVELS[monument.level];
            if (!cfg) { console.error(`[MONUMENTS] No config for level ${monument.level}, skipping respawn`); continue; }
            monument.phase = 'shield';
            monument.hp = cfg.hp;
            monument.max_hp = cfg.hp;
            monument.shield_hp = cfg.max_shield_hp;
            monument.max_shield_hp = cfg.max_shield_hp;
            monument.raid_started_at = null;
            monument.shield_broken_at = null;
            monument.respawn_at = null;
            monument.waves_triggered = [];
            monument.invulnerable = false;
            gameState.markDirty('monuments', id);
            gameState.monumentDamage.delete(id);
            // Persist immediately to prevent stale data on restart
            supabase.from('monuments').update({
              phase: 'shield', level: newLevel, hp: cfg.hp, max_hp: cfg.hp,
              shield_hp: cfg.max_shield_hp, max_shield_hp: cfg.max_shield_hp,
              respawn_at: null, raid_started_at: null, shield_broken_at: null,
              waves_triggered: [], invulnerable: false,
            }).eq('id', id).then(() => {}).catch(e => console.error('[MONUMENTS] respawn persist error:', e.message));
            io.emit('monument:shield_restored', { monument_id: id, level: monument.level });
            console.log(`[MONUMENTS] Respawned as lv${monument.level} "${monument.name}"`);
          }
          continue;
        }

        // Decay: 7 days in shield phase without being defeated → reset to lv1
        if (monument.phase === 'shield' && monument.level > 1) {
          const lastActivity = monument.last_defeated_at
            ? new Date(monument.last_defeated_at).getTime()
            : (monument.created_at ? new Date(monument.created_at).getTime() : 0);
          if (lastActivity && (now - lastActivity > 7 * 24 * 60 * 60 * 1000)) {
            const oldLevel = monument.level;
            monument.level = 1;
            const cfg = MONUMENT_LEVELS[1];
            monument.hp = cfg.hp;
            monument.max_hp = cfg.hp;
            monument.shield_hp = cfg.max_shield_hp;
            monument.max_shield_hp = cfg.max_shield_hp;
            gameState.markDirty('monuments', id);
            io.emit('monument:shield_restored', { monument_id: id, level: 1 });
            console.log(`[MONUMENTS] Decay: lv${oldLevel} → lv1 "${monument.name}" (7d idle)`);
          }
        }

        // Shield regen is now handled by processMonumentShieldRegen() in gameLoop.js

        // Open/wave phase — check 4h timeout (regen shield if not destroyed)
        if ((monument.phase === 'open' || monument.phase === 'wave') && monument.shield_broken_at) {
          const openMs = now - new Date(monument.shield_broken_at).getTime();
          if (openMs > 4 * 60 * 60 * 1000) { // 4 hours
            const cfg = MONUMENT_LEVELS[monument.level];
            monument.phase = 'shield';
            monument.shield_hp = cfg.max_shield_hp;
            monument.hp = cfg.hp;
            monument.raid_started_at = null;
            monument.shield_broken_at = null;
            monument.invulnerable = false;
            monument.waves_triggered = [];
            gameState.markDirty('monuments', id);
            gameState.monumentDamage.delete(id);
            gameState.activeWaves.delete(id);
            // Clean defenders
            for (const [did, d] of gameState.monumentDefenders) {
              if (d.monument_id === id) gameState.monumentDefenders.delete(did);
            }
            io.emit('monument:shield_restored', { monument_id: id });
            console.log(`[MONUMENTS] Open phase timeout — shield restored for lv${monument.level} "${monument.name}"`);
            continue;
          }
        }

        // Wave phase — regen monument HP while defenders alive + wave shield
        if (monument.phase === 'wave') {
          const aliveDefenders = [...gameState.monumentDefenders.values()]
            .filter(d => d.monument_id === id && d.alive);

          if (aliveDefenders.length > 0) {
            // Flat 1% HP regen per second for all waves (* 5s tick)
            const regenAmount = monument.max_hp * 0.01 * 5;
            monument.hp = Math.min(monument.max_hp, monument.hp + regenAmount);

            gameState.markDirty('monuments', id);
            emitToNearbyMonument(monument.lat, monument.lng, 1000, 'monument:hp_update', {
              monument_id: id, hp: monument.hp, max_hp: monument.max_hp, regen: true,
            });

            // Safety timeout: if wave phase > 30min with no nearby players, clear wave
            const nearbyPlayers = getPlayersNearMonument(monument, connectedPlayers);
            if (nearbyPlayers.length === 0 && monument._wave_started_at && (now - monument._wave_started_at > 30 * 60 * 1000)) {
              for (const def of aliveDefenders) {
                def.alive = false;
                def.hp = 0;
              }
              monument.phase = 'open';
              monument.invulnerable = false;
              gameState.markDirty('monuments', id);
              console.log(`[MONUMENTS] Wave safety timeout — cleared defenders for lv${monument.level} "${monument.name}"`);
            }
          } else {
            // All defenders dead — fallback check
            checkWaveComplete(monument, gameState, io, connectedPlayers);
          }
        }

        // Defender movement+attack handled by startDefenderLoop() (1s tick)
      } catch (e) {
        console.error('[MONUMENTS] loop error for', id, ':', e.message);
      }
    }
  }, 5000);
}

// Helper for monument loop (avoids importing from server.js cycle)
function emitToNearbyMonument(lat, lng, radiusM, event, data) {
  for (const [sid, info] of connectedPlayers) {
    if (!info.lat || !info.lng) continue;
    const d = haversine(lat, lng, info.lat, info.lng);
    if (d <= radiusM) io.to(sid).emit(event, data);
  }
}

// ── Defender movement + attack loop (1s tick for responsive AI) ──
function startDefenderLoop() {
  let _defConstants = null;
  setInterval(async () => {
    if (!require_monuments) return;
    if (!_defConstants) _defConstants = await import('./config/constants.js');
    const { MONUMENT_DEFENDER_DAMAGE, MONUMENT_DEFENDER_ATTACK_CD, MONUMENT_DEFENDER_SPEED, PLAYER_RESPAWN_TIME } = _defConstants;
    const { MONUMENT_LEVELS, getPlayersNearMonument } = require_monuments;
    const now = Date.now();

    for (const [id, monument] of gameState.monuments) {
      if (monument.phase !== 'open' && monument.phase !== 'wave') continue;
      try {
        const aliveDefenders = [...gameState.monumentDefenders.values()]
          .filter(d => d.monument_id === id && d.alive);
        if (aliveDefenders.length === 0) continue;

        const nearbyPlayers = getPlayersNearMonument(monument, connectedPlayers);
        const BASE_SPEED = MONUMENT_DEFENDER_SPEED || 14; // meters per second (1s tick)
        const cosLat = Math.cos(monument.lat * Math.PI / 180) || 1;

        // ── Spread targets across players ──
        const targetAssign = new Map();
        if (nearbyPlayers.length > 0) {
          const playerLoad = new Map();
          for (const p of nearbyPlayers) playerLoad.set(p.id, 0);
          for (const defender of aliveDefenders) {
            let best = null, bestScore = Infinity;
            for (const p of nearbyPlayers) {
              const d = haversine(defender.lat, defender.lng, p.last_lat, p.last_lng);
              if (d > 500) continue;
              const score = d + (playerLoad.get(p.id) || 0) * 80;
              if (score < bestScore) { best = p; bestScore = score; }
            }
            if (best) {
              targetAssign.set(defender.id, best);
              playerLoad.set(best.id, (playerLoad.get(best.id) || 0) + 1);
            }
          }
        }

        const levelCfg = MONUMENT_LEVELS[monument.level];
        const levelDamage = levelCfg?.defender_attack || MONUMENT_DEFENDER_DAMAGE;

        for (const defender of aliveDefenders) {
          if (!defender._speedMul) defender._speedMul = 0.7 + Math.random() * 0.6;
          const assignedTarget = targetAssign.get(defender.id);
          const distToTarget = assignedTarget
            ? haversine(defender.lat, defender.lng, assignedTarget.last_lat, assignedTarget.last_lng)
            : Infinity;

          // ── Movement (1s tick) ──
          let targetLat, targetLng;
          // Speed boost when far from target
          const speedMul = (assignedTarget && distToTarget > 100) ? 1.5 : 1.0;
          const defSpeed = BASE_SPEED * defender._speedMul * speedMul;

          if (assignedTarget) {
            if (distToTarget <= 40) {
              // Strafe: tight circles around target
              if (!defender._strafeAngle) defender._strafeAngle = Math.random() * Math.PI * 2;
              defender._strafeAngle += 0.08 + Math.random() * 0.06;
              const strafeDist = 15 + Math.random() * 15;
              targetLat = assignedTarget.last_lat + (strafeDist / 111320) * Math.cos(defender._strafeAngle);
              targetLng = assignedTarget.last_lng + (strafeDist / (111320 * cosLat)) * Math.sin(defender._strafeAngle);
            } else {
              targetLat = assignedTarget.last_lat;
              targetLng = assignedTarget.last_lng;
            }
          } else {
            if (!defender._roamAngle) defender._roamAngle = Math.random() * Math.PI * 2;
            if (Math.random() < 0.03) defender._roamAngle += (Math.random() - 0.5) * 1.2;
            const roamDist = 30 + Math.random() * 100;
            targetLat = monument.lat + (roamDist / 111320) * Math.cos(defender._roamAngle);
            targetLng = monument.lng + (roamDist / (111320 * cosLat)) * Math.sin(defender._roamAngle);
          }

          const dLat = targetLat - defender.lat;
          const dLng = targetLng - defender.lng;
          const dist = Math.sqrt(dLat * dLat + dLng * dLng);
          if (dist > 0.00001) {
            const stepDeg = defSpeed / 111320;
            const ratio = Math.min(1, stepDeg / dist);
            defender.lat += dLat * ratio;
            defender.lng += dLng * ratio;
          }

          // Clamp within 500m
          const fromMonument = haversine(monument.lat, monument.lng, defender.lat, defender.lng);
          if (fromMonument > 500) {
            const backAngle = Math.atan2(monument.lng - defender.lng, monument.lat - defender.lat);
            defender.lat = monument.lat + (450 / 111320) * Math.cos(backAngle);
            defender.lng = monument.lng + (450 / (111320 * cosLat)) * Math.sin(backAngle);
          }

          // ── Attack — 250m range ──
          const cdJitter = (Math.random() - 0.5) * 400;
          const effectiveCD = (defender.attack_cd || MONUMENT_DEFENDER_ATTACK_CD) + cdJitter;
          if (now - (defender.last_attack || 0) < effectiveCD) continue;
          if (nearbyPlayers.length === 0) continue;

          let target = null, bestDist = 250;
          if (assignedTarget && distToTarget <= 250) {
            target = assignedTarget; bestDist = distToTarget;
          } else {
            for (const p of nearbyPlayers) {
              const d = haversine(defender.lat, defender.lng, p.last_lat, p.last_lng);
              if (d < bestDist) { target = p; bestDist = d; }
            }
          }
          if (!target) continue;

          defender.last_attack = now;
          const damage = levelDamage;
          const maxHp = 1000 + (target.bonus_hp || 0);
          let hp = target.hp ?? maxHp;
          hp = Math.max(0, hp - damage);
          target.hp = hp;
          target.last_hp_regen = new Date(now).toISOString();
          gameState.markDirty('players', target.id);

          emitToNearbyMonument(monument.lat, monument.lng, 1000, 'projectile', {
            from_lat: defender.lat, from_lng: defender.lng,
            to_lat: target.last_lat, to_lng: target.last_lng,
            damage, crit: false,
            target_type: 'player', target_id: target.id,
            attacker_type: 'defender', weapon_type: 'defender',
            emoji: defender.emoji,
          });

          // Find socket for this player
          let targetSid = null;
          for (const [sid, info] of connectedPlayers) {
            if (String(info.telegram_id) === String(target.telegram_id)) { targetSid = sid; break; }
          }
          if (targetSid) {
            io.to(targetSid).emit('pvp:hit', {
              attacker_name: defender.emoji + ' Defender',
              damage, hp_left: hp, max_hp: maxHp,
            });
          }

          if (hp <= 0 && !target.is_dead) {
            target.hp = 0;
            target.is_dead = true;
            target._respawn_at = new Date(now + PLAYER_RESPAWN_TIME).toISOString();
            gameState.markDirty('players', target.id);
            if (targetSid) {
              io.to(targetSid).emit('player:died', { respawn_in: PLAYER_RESPAWN_TIME / 1000, killer: defender.emoji + ' Defender' });
            }
            const idx = nearbyPlayers.indexOf(target);
            if (idx !== -1) nearbyPlayers.splice(idx, 1);
            // Clear all defender targeting for this dead player
            for (const d of aliveDefenders) {
              if (String(d._target_player_id) === String(target.telegram_id)) {
                d._target_player_id = null;
                d._target_lat = null;
                d._target_lng = null;
              }
            }
          }
        }
      } catch (e) {
        console.error('[DEFENDERS] loop error for', id, ':', e.message);
      }
    }
  }, 1000);
}

// Lazy-loaded monument imports (avoid circular import)
let require_monuments = null;

// Load game state from DB before starting
async function start() {
  try {
    await gameState.loadFromDB();
    startPersistLoop();
  } catch (e) {
    console.error('[startup] Failed to load game state:', e.message);
    console.error('[startup] Server will start without in-memory state (DB fallback)');
  }

  startGameLoop(io, connectedPlayers);

  // Load monument module (lazy to avoid circular imports)
  require_monuments = await import('./lib/monuments.js');

  // Monument game loop (every 5 seconds). Defender AI is now in gameLoop.js (1s tick)
  startMonumentLoop();
  // startDefenderLoop(); — replaced by updateDefenders() in gameLoop.js 1s interval

  // ── City spawn cycle (tile-based, see game/mechanics/oreNodes.js) ──
  async function citySpawnCycle() {
    try {
      const { getAllCityKeys, getCityBounds, getCityPlayerCount, playerCityCache, cityPlayersCache } = await import('./lib/geocity.js');
      const { spawnOreNodesForCity, computeTileDeficits } = await import('./lib/oreNodes.js');
      const { ORE_SPAWN_BUDGET_PER_CYCLE } = await import('./config/constants.js');

      const cityKeys = getAllCityKeys();
      if (!cityKeys.length) { console.log('[SPAWN] No cities in cache yet'); return; }

      // Collect per-city player positions and total deficit, prioritise by deficit
      const cityInfos = [];
      for (const cityKey of cityKeys) {
        const playerCount = getCityPlayerCount(cityKey);
        if (playerCount <= 0) continue;

        const cb = await getCityBounds(cityKey);
        if (!cb?.boundingbox) continue;

        const playersInCity = cityPlayersCache.get(cityKey);
        const playerPositions = [];
        if (playersInCity) {
          for (const tgId of playersInCity) {
            const gsP = gameState.getPlayerByTgId(Number(tgId));
            const pLat = gsP?.last_lat || playerCityCache.get(tgId)?.lat;
            const pLng = gsP?.last_lng || playerCityCache.get(tgId)?.lng;
            if (pLat && pLng) playerPositions.push({ lat: pLat, lng: pLng });
          }
        }
        if (playerPositions.length === 0) continue;

        const tiles = computeTileDeficits(cb.boundingbox, playerPositions, gameState.oreNodes.values());
        const totalDeficit = tiles.reduce((s, t) => s + t.deficit, 0);
        if (totalDeficit <= 0) continue;

        cityInfos.push({ cityKey, bounds: cb.boundingbox, playerPositions, totalDeficit });
      }

      if (cityInfos.length === 0) { console.log('[SPAWN] All cities at target'); return; }

      // Biggest deficit first
      cityInfos.sort((a, b) => b.totalDeficit - a.totalDeficit);

      // Distribute global budget proportionally to deficit, with floor so small cities still get served
      const grandTotal = cityInfos.reduce((s, c) => s + c.totalDeficit, 0);
      let remaining = ORE_SPAWN_BUDGET_PER_CYCLE;
      let processed = 0, totalSpawned = 0;

      for (let i = 0; i < cityInfos.length && remaining > 0; i++) {
        const ci = cityInfos[i];
        const share = Math.max(1, Math.min(ci.totalDeficit, Math.ceil((ci.totalDeficit / grandTotal) * ORE_SPAWN_BUDGET_PER_CYCLE)));
        const budget = Math.min(share, remaining);

        try {
          const spawned = await spawnOreNodesForCity(ci.cityKey, ci.bounds, ci.playerPositions, budget);
          totalSpawned += spawned;
          remaining -= spawned;
          processed++;
        } catch (e) {
          console.error(`[SPAWN] Error spawning ores for ${ci.cityKey}: ${e.message}`);
        }

        // Pause between cities to spread Overpass load (persistent road cache means fewer hits)
        if (i < cityInfos.length - 1 && remaining > 0) {
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      console.log(`[SPAWN] Cycle done: processed ${processed}/${cityInfos.length} cities, spawned ${totalSpawned}/${ORE_SPAWN_BUDGET_PER_CYCLE}`);
    } catch (e) { console.error('[SPAWN] city cycle error:', e.message); }
  }
  global._citySpawnCycle = citySpawnCycle;
  // Populate city cache from all players with coordinates, then spawn
  setTimeout(async () => {
    try {
      const { updatePlayerCity, clearCityBoundsCache } = await import('./lib/geocity.js');
      const { clearSpawnErrorCache } = await import('./lib/oreNodes.js');
      clearCityBoundsCache(); // Rebuild with updated min-span logic
      // Road cache is now persisted to disk with 7d TTL — keep it across restarts
      clearSpawnErrorCache(); // Clear error cache to retry failed regions
      const players = [...gameState.players.values()].filter(p => p.last_lat && p.last_lng);
      console.log(`[GEOCITY] Populating city cache for ${players.length} players...`);
      for (const p of players) {
        await updatePlayerCity(p.telegram_id, p.last_lat, p.last_lng);
        await new Promise(r => setTimeout(r, 2000)); // Nominatim rate limit
      }
      console.log('[GEOCITY] City cache populated, starting spawn cycle');
      await citySpawnCycle();
      // Spawn vases on startup if none exist (e.g. after server restart)
      if (gameState.vases.size === 0) {
        console.log('[VASES] No vases found — spawning initial batch');
        const { getAllCityKeys, getCityBounds, getCityPlayerCount } = await import('./lib/geocity.js');
        const { spawnVasesForCity } = await import('./lib/vases.js');
        for (const cityKey of getAllCityKeys()) {
          const pc = getCityPlayerCount(cityKey);
          if (pc <= 0) continue;
          const cb = await getCityBounds(cityKey);
          if (!cb?.boundingbox) continue;
          await spawnVasesForCity(cityKey, cb.boundingbox, pc);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    } catch (e) { console.error('[GEOCITY] init error:', e.message); }
  }, 5000);
  // Every hour — check all cities for ore top-up
  setInterval(citySpawnCycle, 3600000);

  // Weekly monument reset (Sunday midnight MSK, checked every hour)
  setInterval(async () => {
    const now = new Date();
    const mskHour = (now.getUTCHours() + 3) % 24;
    const mskDay = new Date(now.getTime() + 3 * 60 * 60 * 1000).getDay();
    if (mskDay === 0 && mskHour === 0 && now.getMinutes() < 5) {
      const { resetMonuments } = await import('./lib/monuments.js');
      resetMonuments().catch(e => console.error('[MONUMENTS] Weekly reset error:', e.message));
    }
  }, 3600000);

  // Collector auto-collect: every 60s (each collector has own per-level interval gate).
  // Frequent ticks let online players see progress; the gate prevents over-collection.
  setInterval(() => {
    try {
      import('./lib/collectors.js').then(({ autoCollectAll }) => autoCollectAll()).catch(err => console.error('[COLLECTORS] autoCollectAll error:', err));
    } catch (err) { console.error('[COLLECTORS] import error:', err); }
  }, 60000); // 60s
  // Also run once at startup after 30s
  setTimeout(() => {
    import('./lib/collectors.js').then(({ autoCollectAll }) => autoCollectAll()).catch(err => console.error('[COLLECTORS] autoCollectAll startup error:', err));
  }, 30000);

  // Vase daily spawn at midnight MSK + cleanup expired (checked every 5 min)
  setInterval(async () => {
    try {
      const now = new Date();
      const mskNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);

      // Clean expired/broken vases every run
      const expiredCount = [...gameState.vases.values()].filter(v =>
        new Date(v.expires_at) < now || v.broken_by
      ).length;
      if (expiredCount > 0) {
        await supabase.from('vases').delete().lt('expires_at', now.toISOString());
        await supabase.from('vases').delete().not('broken_by', 'is', null);
        for (const [id, v] of gameState.vases) {
          if (new Date(v.expires_at) < now || v.broken_by) gameState.vases.delete(id);
        }
      }

      // Spawn new vases only at 00:00-00:05 MSK
      if (mskNow.getHours() !== 0 || mskNow.getMinutes() > 5) return;
      const vaseResetKey = `vase_${mskNow.getFullYear()}_${mskNow.getMonth()}_${mskNow.getDate()}`;
      if (global._lastVaseSpawn === vaseResetKey) return;
      global._lastVaseSpawn = vaseResetKey;

      console.log('[VASES] Daily midnight spawn starting...');
      const { getAllCityKeys, getCityBounds, getCityPlayerCount, playerCityCache, cityPlayersCache } = await import('./lib/geocity.js');
      const { spawnVasesForCity } = await import('./lib/vases.js');
      const { haversine: hav } = await import('./lib/haversine.js');

      for (const cityKey of getAllCityKeys()) {
        const pc = getCityPlayerCount(cityKey);
        if (pc <= 0) continue;
        const cb = await getCityBounds(cityKey);
        if (!cb?.boundingbox) continue;

        // Collect player positions for player-centered fallback
        const playersInCity = cityPlayersCache.get(cityKey);
        const playerPositions = [];
        if (playersInCity) {
          for (const tgId of playersInCity) {
            const gsPlayer = gameState.getPlayerByTgId(Number(tgId));
            const lat = gsPlayer?.last_lat || playerCityCache.get(tgId)?.lat;
            const lng = gsPlayer?.last_lng || playerCityCache.get(tgId)?.lng;
            if (lat && lng) playerPositions.push({ lat, lng });
          }
        }

        // Main city bounds spawn (with player-centered fallback)
        await spawnVasesForCity(cityKey, cb.boundingbox, pc, playerPositions);

        // Check for uncovered players (no vase within 3km) and spawn sub-zones
        if (playersInCity) {
          const PAD = 0.018; // ~2km
          for (const tgId of playersInCity) {
            const gsPlayer = gameState.getPlayerByTgId(Number(tgId));
            const lat = gsPlayer?.last_lat || playerCityCache.get(tgId)?.lat;
            const lng = gsPlayer?.last_lng || playerCityCache.get(tgId)?.lng;
            if (!lat || !lng) continue;
            let hasNearbyVase = false;
            for (const v of gameState.vases.values()) {
              if (!v.broken_by && new Date(v.expires_at) > new Date() && hav(lat, lng, v.lat, v.lng) < 3000) {
                hasNearbyVase = true; break;
              }
            }
            if (!hasNearbyVase) {
              const subBounds = [lat - PAD, lat + PAD, lng - PAD, lng + PAD];
              console.log(`[VASES] ${cityKey}: uncovered player ${tgId} at ${lat.toFixed(3)},${lng.toFixed(3)}, spawning sub-zone`);
              await spawnVasesForCity(`${cityKey}_sub`, subBounds, 1);
            }
          }
        }

        await new Promise(r => setTimeout(r, 2000));
      }
      console.log('[VASES] Daily midnight spawn complete');
    } catch (e) {
      console.error('[VASES] Daily spawn/cleanup error:', e.message);
    }
  }, 300000); // 5 min

  // Vase mid-day top-up: every 6 hours (06:00, 12:00, 18:00 MSK) replenish if below 50% target
  setInterval(async () => {
    try {
      const now = new Date();
      const mskNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
      const mskHour = mskNow.getHours();
      if (![12].includes(mskHour) || mskNow.getMinutes() > 5) return;
      const topUpKey = `vase_topup_${mskNow.getFullYear()}_${mskNow.getMonth()}_${mskNow.getDate()}_${mskHour}`;
      if (global._lastVaseTopUp === topUpKey) return;
      global._lastVaseTopUp = topUpKey;

      console.log('[VASES] Mid-day top-up starting...');
      const { getAllCityKeys, getCityBounds, getCityPlayerCount, playerCityCache, cityPlayersCache } = await import('./lib/geocity.js');
      const { spawnVasesForCity } = await import('./lib/vases.js');

      let totalSpawned = 0;
      for (const cityKey of getAllCityKeys()) {
        const pc = getCityPlayerCount(cityKey);
        if (pc <= 0) continue;
        const cb = await getCityBounds(cityKey);
        if (!cb?.boundingbox) continue;

        const playersInCity = cityPlayersCache.get(cityKey);
        const playerPositions = [];
        if (playersInCity) {
          for (const tgId of playersInCity) {
            const gsPlayer = gameState.getPlayerByTgId(Number(tgId));
            const lat = gsPlayer?.last_lat || playerCityCache.get(tgId)?.lat;
            const lng = gsPlayer?.last_lng || playerCityCache.get(tgId)?.lng;
            if (lat && lng) playerPositions.push({ lat, lng });
          }
        }

        totalSpawned += await spawnVasesForCity(cityKey, cb.boundingbox, pc, playerPositions);
        await new Promise(r => setTimeout(r, 1000));
      }
      console.log(`[VASES] Mid-day top-up complete: spawned ${totalSpawned}`);
    } catch (e) {
      console.error('[VASES] Mid-day top-up error:', e.message);
    }
  }, 300000); // 5 min check

  // Monthly ore reset check (every 5 min)
  setInterval(async () => {
    try {
      const now = new Date();
      const mskNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
      if (mskNow.getDate() !== 1 || mskNow.getHours() !== 0 || mskNow.getMinutes() > 5) return;
      const resetKey = `reset_${mskNow.getFullYear()}_${mskNow.getMonth()}`;
      if (global._lastOreReset === resetKey) return;
      global._lastOreReset = resetKey;

      console.log('[ORE] Monthly reset starting...');
      await supabase.from('ore_nodes').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      gameState.oreNodes.clear();
      await new Promise(r => setTimeout(r, 1000));
      // Immediately spawn fresh ores for all cities
      console.log('[ORE] Monthly reset complete — spawning fresh ores...');
      await citySpawnCycle();

      // Reset clan monthly donation counters
      await supabase.from('clan_members').update({ donated_month: 0 }).is('left_at', null).gt('donated_month', 0);
      console.log('[CLAN] Monthly donation counters reset');
    } catch (e) {
      console.error('[ORE] Monthly reset error:', e.message);
    }
  }, 300000); // 5 min

  const PORT = process.env.PORT || 3000;

  // Antispoof 8h digest — only on production (PORT=3000); staging uses
  // a different bot so admin chat notifications would fail silently anyway.
  if (Number(PORT) === 3000) {
    setTimeout(() => sendHourlyDigest().catch(e => console.error('[ANTISPOOF] digest error:', e.message)), 5 * 60 * 1000);
    setInterval(() => sendHourlyDigest().catch(e => console.error('[ANTISPOOF] digest error:', e.message)), 8 * 60 * 60 * 1000);
    console.log('[ANTISPOOF] 8h digest enabled');
  }

  httpServer.listen(PORT, () => {
    console.log(`Grid Wars Server running on port ${PORT}`);
  });
}

start();

// ── Graceful shutdown: notify all clients to reload ──
function gracefulShutdown(signal) {
  console.log(`[server] ${signal} received — notifying clients to reload`);
  io.emit('server:restart');
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// SIGUSR2: dump in-memory per-player logs to /tmp for offline inspection.
// Operator-only maintenance tool (requires shell access on the host).
process.on('SIGUSR2', async () => {
  try {
    const { playerLogs } = await import('./lib/logger.js');
    const fs = await import('node:fs/promises');
    const dump = {};
    for (const [tgId, entries] of playerLogs) dump[String(tgId)] = entries;
    const path = `/tmp/player-logs-dump-${Date.now()}.json`;
    await fs.writeFile(path, JSON.stringify(dump));
    console.log(`[SIGUSR2] Dumped ${playerLogs.size} player log maps to ${path}`);
  } catch (e) {
    console.error('[SIGUSR2] dump error:', e.message);
  }
});
