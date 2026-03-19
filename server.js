import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { playerRouter } from './routes/player.js';
import { buildingsRouter } from './routes/buildings.js';
import { economyRouter } from './routes/economy.js';
import { botsRouter } from './routes/bots.js';
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
import { coresRouter } from './routes/cores.js';
import { startGameLoop } from './socket/gameLoop.js';

import { log } from './lib/log.js';
import { haversine } from './lib/haversine.js';
import { supabase } from './lib/supabase.js';
import { gameState } from './lib/gameState.js';
import { startPersistLoop } from './lib/persist.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Admin monitoring ──
global.recentErrors = [];
global.recentActivity = [];

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
});

import { validateRequest, checkBan } from './lib/security.js';
import { rateLimitMw } from './lib/rateLimit.js';

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '100kb' }));
app.use(validateRequest);
app.use('/api', checkBan);

// Serve static frontend files (no cache for index.html to ensure updates)
app.use(express.static(join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
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

// ── Telegram Bot Webhook (callback_query for ban/unban buttons) ──
app.post('/api/telegram-webhook', async (req, res) => {
  res.json({ ok: true }); // respond immediately
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
      }).catch(() => {});

    const editMessage = (text) =>
      fetch(`https://api.telegram.org/bot${BOT}/editMessageText`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: msgId, text }),
      }).catch(() => {});

    if (data.startsWith('confirm_ban_')) {
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
      notify(tgId, '✅ Вы разбанены! Добро пожаловать обратно.');
    }
  } catch (e) {
    console.error('[webhook] callback error:', e.message);
  }
});

// API Routes
app.use('/api/player', playerRouter);
app.use('/api/buildings', buildingsRouter);
app.use('/api/economy', economyRouter);
app.use('/api/map', mapRouter);
app.use('/api/bots', botsRouter);
app.use('/api/vases', vasesRouter);
app.use('/api/items', itemsRouter);
app.use('/api/shop', shopRouter);
app.use('/api/market', marketRouter);
app.use('/api/admin', adminRouter);
app.use('/api/clan', clanRouter);
app.use('/api/ore', oreRouter);
app.use('/api/monuments', monumentsRouter);
app.use('/api/collectors', collectorsRouter);
app.use('/api/cores', coresRouter);

// Fallback: serve index.html for any non-API route (SPA)
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/') && !req.path.startsWith('/socket.io/')) {
    res.sendFile(join(__dirname, 'public', 'index.html'));
  }
});

// Connected players map
export const connectedPlayers = new Map();

// Rate-limit map for projectile attacks (telegram_id -> timestamp)
export const lastAttackTime = new Map();

// Socket.io
io.on('connection', (socket) => {
  console.log('[socket] Connected:', socket.id, 'total:', connectedPlayers.size + 1);

  socket.on('player:init', (data) => {
    let playerDbId = null;
    if (data.telegram_id && gameState.loaded) {
      const p = gameState.getPlayerByTgId(data.telegram_id);
      if (p) playerDbId = p.id;
    }
    connectedPlayers.set(socket.id, {
      telegram_id: data.telegram_id,
      player_db_id: playerDbId,
      lat: data.lat,
      lng: data.lng,
      lastState: null
    });
    console.log('[socket] Player init:', data.telegram_id, 'db_id:', playerDbId, 'total:', connectedPlayers.size);

    // Update player city cache for city-based spawning
    if (data.telegram_id && data.lat && data.lng) {
      import('./lib/geocity.js').then(({ updatePlayerCity }) => {
        updatePlayerCity(data.telegram_id, data.lat, data.lng).catch(() => {});
      }).catch(() => {});
    }
  });

  socket.on('player:location', (data) => {
    if (!data?.lat || !data?.lng) return;
    const player = connectedPlayers.get(socket.id);
    if (player) {
      player.lat = data.lat;
      player.lng = data.lng;
      // Update city cache (rate-limited internally to 1h)
      if (player.telegram_id) {
        import('./lib/geocity.js').then(({ updatePlayerCity }) => {
          updatePlayerCity(player.telegram_id, data.lat, data.lng).catch(() => {});
        }).catch(() => {});
      }
    }

    // Broadcast to nearby players (2km)
    for (const [sid, other] of connectedPlayers) {
      if (sid === socket.id || !other.lat) continue;
      const dist = haversine(data.lat, data.lng, other.lat, other.lng);
      if (dist <= 2000) {
        io.to(sid).emit('player:moved', {
          telegram_id: data.telegram_id,
          lat: data.lat,
          lng: data.lng,
        });
      }
    }

    // Update in-memory state
    if (data.telegram_id) {
      const p = gameState.getPlayerByTgId(data.telegram_id);
      if (p) {
        p.last_lat = data.lat;
        p.last_lng = data.lng;
        p.last_seen = new Date().toISOString();
        gameState.markDirty('players', p.id);
      }
    }
  });

  socket.on('disconnect', () => {
    connectedPlayers.delete(socket.id);
    log('Disconnected:', socket.id);
  });
});

// Export io for push events
export { io, gameState };

// ── Monument game loop ──
function startMonumentLoop() {
  setInterval(async () => {
    if (!require_monuments) return;
    const { MONUMENT_LEVELS, MONUMENT_ATTACK_RADIUS, WAVE_INTERVAL_SECONDS, spawnDefenderWave, getPlayersNearMonument } = require_monuments;
    for (const [id, monument] of gameState.monuments) {
      try {
        // Respawn shield after 8h
        if (monument.phase === 'defeated' && monument.respawn_at) {
          if (new Date() > new Date(monument.respawn_at)) {
            const cfg = MONUMENT_LEVELS[monument.level];
            monument.phase = 'shield';
            monument.shield_hp = cfg.max_shield_hp;
            monument.hp = cfg.hp;
            monument.raid_started_at = null;
            monument.shield_broken_at = null;
            monument.respawn_at = null;
            gameState.markDirty('monuments', id);
            gameState.monumentDamage.delete(id);
            io.emit('monument:shield_restored', { monument_id: id });
            console.log(`[MONUMENTS] Shield restored for lv${monument.level} "${monument.name}"`);
          }
          continue;
        }

        // Shield regen is now handled by processMonumentShieldRegen() in gameLoop.js

        // Open phase — check 4h timeout (regen shield if not destroyed)
        if (monument.phase === 'open' && monument.shield_broken_at) {
          const openMs = Date.now() - new Date(monument.shield_broken_at).getTime();
          if (openMs > 4 * 60 * 60 * 1000) { // 4 hours
            const cfg = MONUMENT_LEVELS[monument.level];
            monument.phase = 'shield';
            monument.shield_hp = cfg.max_shield_hp;
            monument.hp = cfg.hp;
            monument.raid_started_at = null;
            monument.shield_broken_at = null;
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

        // Open phase — defender attacks
        if (monument.phase === 'open') {
          const wave = gameState.activeWaves.get(id);
          if (!wave) continue;

          const now = Date.now();

          const aliveDefenders = [...gameState.monumentDefenders.values()]
            .filter(d => d.monument_id === id && d.alive);

          // ── Move defenders ──
          const nearbyPlayers = getPlayersNearMonument(monument, connectedPlayers);
          const DEFENDER_SPEED = 20; // meters per tick (5s)
          const cosLat = Math.cos(monument.lat * Math.PI / 180) || 1;

          for (const defender of aliveDefenders) {
            let targetLat, targetLng;

            if (nearbyPlayers.length > 0) {
              // Chase closest player
              let closest = nearbyPlayers[0], closestDist = Infinity;
              for (const p of nearbyPlayers) {
                const d = haversine(defender.lat, defender.lng, p.last_lat, p.last_lng);
                if (d < closestDist) { closest = p; closestDist = d; }
              }
              targetLat = closest.last_lat;
              targetLng = closest.last_lng;
            } else {
              // Roam within 200m of monument
              if (!defender._roamAngle) defender._roamAngle = Math.random() * Math.PI * 2;
              if (Math.random() < 0.15) defender._roamAngle += (Math.random() - 0.5) * 1.2;
              const roamDist = 30 + Math.random() * 100;
              targetLat = monument.lat + (roamDist / 111320) * Math.cos(defender._roamAngle);
              targetLng = monument.lng + (roamDist / (111320 * cosLat)) * Math.sin(defender._roamAngle);
            }

            // Move toward target
            const dLat = targetLat - defender.lat;
            const dLng = targetLng - defender.lng;
            const dist = Math.sqrt(dLat * dLat + dLng * dLng);
            if (dist > 0.00001) {
              const stepDeg = DEFENDER_SPEED / 111320;
              const ratio = Math.min(1, stepDeg / dist);
              defender.lat += dLat * ratio;
              defender.lng += dLng * ratio;
            }

            // Clamp within 500m of monument
            const fromMonument = haversine(monument.lat, monument.lng, defender.lat, defender.lng);
            if (fromMonument > 500) {
              const backAngle = Math.atan2(monument.lng - defender.lng, monument.lat - defender.lat);
              defender.lat = monument.lat + (450 / 111320) * Math.cos(backAngle);
              defender.lng = monument.lng + (450 / (111320 * cosLat)) * Math.sin(backAngle);
            }
          }

          // ── Defenders attack nearby players every ~4 seconds (2 ticks) ──
          if (now - (wave.last_attack_at || 0) >= 4000) {
            if (nearbyPlayers.length > 0 && aliveDefenders.length > 0) {
              const defAtk = MONUMENT_LEVELS[monument.level].defender_attack;
              for (const defender of aliveDefenders) {
                // Attack closest player within 50m of this defender
                let target = null, bestDist = 50;
                for (const p of nearbyPlayers) {
                  const d = haversine(defender.lat, defender.lng, p.last_lat, p.last_lng);
                  if (d < bestDist) { target = p; bestDist = d; }
                }
                if (!target) continue;

                const damage = defAtk;
                const maxHp = 1000 + (target.bonus_hp || 0);
                let hp = target.hp ?? maxHp;
                hp = Math.max(0, hp - damage);
                target.hp = hp;
                gameState.markDirty('players', target.id);

                emitToNearbyMonument(monument.lat, monument.lng, 1000, 'projectile', {
                  from_lat: defender.lat, from_lng: defender.lng,
                  to_lat: target.last_lat, to_lng: target.last_lng,
                  damage, crit: false,
                  target_type: 'player', target_id: target.id,
                  attacker_type: 'defender',
                  weapon_type: 'defender',
                  emoji: defender.emoji,
                });

                if (target._socketId) {
                  io.to(target._socketId).emit('pvp:hit', {
                    attacker_name: defender.emoji + ' Защитник',
                    damage,
                    hp_left: hp,
                    max_hp: maxHp,
                  });
                }

                if (hp <= 0) {
                  target.hp = maxHp;
                  target.shield_until = new Date(Date.now() + 5 * 60 * 1000).toISOString();
                  gameState.markDirty('players', target.id);
                  if (target._socketId) {
                    io.to(target._socketId).emit('monument:knocked_out', {
                      monument_id: id,
                      respawn_in: 300,
                    });
                  }
                }
              }
              wave.last_attack_at = now;
            }
          }
        }
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

  // Monument game loop (every 5 seconds)
  startMonumentLoop();

  // Ore nodes — auto-spawn if too few
  if (gameState.loaded && gameState.players.size > 0) {
    const expectedOres = gameState.players.size * 2.5;
    if (gameState.oreNodes.size < expectedOres * 0.1) {
      console.log(`[ORE] Low ore count (${gameState.oreNodes.size}/${Math.round(expectedOres)}), spawning...`);
      const { spawnOreNodesGlobally } = await import('./lib/oreNodes.js');
      spawnOreNodesGlobally().catch(e => console.error('[ORE] Initial spawn error:', e.message));
    }
  }

  // ── City-based spawn cycle (monuments + ore + vases) ──
  async function citySpawnCycle() {
    try {
      const { getAllCityKeys, getCityBounds, getCityPlayerCount } = await import('./lib/geocity.js');
      const { spawnMonumentsForCity } = await import('./lib/monuments.js');
      const { spawnOreNodesForCity } = await import('./lib/oreNodes.js');
      const { spawnVasesForCity } = await import('./lib/vases.js');
      const { sendTelegramNotification } = await import('./lib/supabase.js');
      const { haversine: hav } = await import('./lib/haversine.js');

      const cityKeys = getAllCityKeys();
      if (!cityKeys.length) { console.log('[SPAWN] No cities in cache yet'); return; }

      for (const cityKey of cityKeys) {
        const playerCount = getCityPlayerCount(cityKey);
        if (playerCount <= 0) continue;

        const cityBounds = await getCityBounds(cityKey);
        if (!cityBounds?.boundingbox) continue;

        const bounds = cityBounds.boundingbox; // [minLat, maxLat, minLng, maxLng]

        // Monuments
        const spawned = await spawnMonumentsForCity(cityKey, bounds, playerCount);
        if (spawned?.length) {
          const allPlayers = [...gameState.players.values()];
          for (const m of spawned) {
            const nearby = allPlayers.filter(p => p.last_lat && p.last_lng && hav(p.last_lat, p.last_lng, m.lat, m.lng) <= 10000);
            for (const p of nearby) {
              sendTelegramNotification(p.telegram_id, `🏛️ Монумент "${m.name}" (ур.${m.level}) появился в вашем городе! Собирайте рейд!`).catch(() => {});
            }
          }
        }

        // Ore nodes
        await spawnOreNodesForCity(cityKey, bounds, playerCount);

        // Vases
        await spawnVasesForCity(cityKey, bounds, playerCount);

        // Pause between cities to avoid Nominatim rate limit
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (e) { console.error('[SPAWN] city cycle error:', e.message); }
  }
  // Populate city cache from all players with coordinates, then spawn
  setTimeout(async () => {
    try {
      const { updatePlayerCity } = await import('./lib/geocity.js');
      const players = [...gameState.players.values()].filter(p => p.last_lat && p.last_lng);
      console.log(`[GEOCITY] Populating city cache for ${players.length} players...`);
      for (const p of players) {
        await updatePlayerCity(p.telegram_id, p.last_lat, p.last_lng);
        await new Promise(r => setTimeout(r, 1100)); // Nominatim: 1 req/sec
      }
      console.log('[GEOCITY] City cache populated, starting spawn cycle');
      await citySpawnCycle();
    } catch (e) { console.error('[GEOCITY] init error:', e.message); }
  }, 5000);
  // Every hour — check all cities
  setInterval(citySpawnCycle, 3600000);
  // Every 5 min — top up vases only
  setInterval(async () => {
    try {
      const { getAllCityKeys, getCityBounds, getCityPlayerCount } = await import('./lib/geocity.js');
      const { spawnVasesForCity } = await import('./lib/vases.js');
      for (const cityKey of getAllCityKeys()) {
        const pc = getCityPlayerCount(cityKey);
        if (pc <= 0) continue;
        const cb = await getCityBounds(cityKey);
        if (!cb?.boundingbox) continue;
        await spawnVasesForCity(cityKey, cb.boundingbox, pc);
      }
    } catch (e) { console.error('[VASES] top-up error:', e.message); }
  }, 5 * 60 * 1000);

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

  // Collector auto-collect: every hour
  setInterval(() => {
    try {
      import('./lib/collectors.js').then(({ autoCollectAll }) => autoCollectAll()).catch(() => {});
    } catch (_) {}
  }, 3600000); // 1 hour
  // Also run once at startup after 30s
  setTimeout(() => {
    import('./lib/collectors.js').then(({ autoCollectAll }) => autoCollectAll()).catch(() => {});
  }, 30000);

  // Vase daily cleanup: midnight MSK remove expired (checked every 30 min)
  setInterval(async () => {
    try {
      const now = new Date();
      const mskHour = (now.getUTCHours() + 3) % 24;
      if (mskHour !== 0 || now.getMinutes() > 30) return;
      // Clean expired vases from DB
      await supabase.from('vases').delete().lt('expires_at', new Date().toISOString());
      // Clean from gameState
      for (const [id, v] of gameState.vases) {
        if (new Date(v.expires_at) < new Date() || v.broken_by) gameState.vases.delete(id);
      }
      console.log('[VASES] Cleaned expired vases');
    } catch (e) {
      console.error('[VASES] Cleanup error:', e.message);
    }
  }, 1800000); // 30 min

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
      // Ore will respawn via citySpawnCycle when players connect
      console.log('[ORE] Monthly reset complete — ores will respawn via city cycle');
    } catch (e) {
      console.error('[ORE] Monthly reset error:', e.message);
    }
  }, 300000); // 5 min

  const PORT = process.env.PORT || 3000;
  httpServer.listen(PORT, () => {
    console.log(`Grid Wars Server running on port ${PORT}`);
  });
}

start();
