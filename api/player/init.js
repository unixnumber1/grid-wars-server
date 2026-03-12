import { supabase, getPlayerByTelegramId, parseTgId } from '../../lib/supabase.js';
import { xpForLevel, SMALL_RADIUS, LARGE_RADIUS, getMaxHp, getPlayerAttack, calcHpRegen, getMineIncome, ALLOWED_AVATARS } from '../../lib/formulas.js';

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
        .select('id,telegram_id,username,game_username,username_changes,avatar,level,xp,hp,max_hp,bonus_attack,bonus_hp,kills,deaths,diamonds,coins,equipped_sword,equipped_shield,respawn_until,starting_bonus_claimed,last_hp_regen')
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
      supabase.from('mines').select('id,lat,lng,level,owner_id,cell_id,upgrade_finish_at,pending_level,last_collected').eq('owner_id', player.id),
      supabase.from('items').select('*').eq('owner_id', player.id).order('obtained_at', { ascending: false }),
      supabase.from('notifications').select('id,type,message,data,created_at').eq('player_id', player.id).eq('read', false).order('created_at', { ascending: false }).limit(20),
    ]));
    headquarters  = hqRes.data;
    mines         = minesRes.data;
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
  const maxHp  = getMaxHp(level);
  const attack = 10 + (level * 2);

  console.log('[init] step 4 - hp regen update');
  let currentHp    = player.hp ?? maxHp;
  let regenApplied = false;
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

  const totalIncome = (mines || []).reduce((sum, m) => sum + getMineIncome(m.level), 0);

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
