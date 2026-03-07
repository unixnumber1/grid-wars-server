import { supabase, getPlayerByTelegramId, parseTgId } from '../../lib/supabase.js';
import { xpForLevel, getBuildRadius, getMaxHp, getPlayerAttack, calcHpRegen, getMineIncome, ALLOWED_AVATARS } from '../../lib/formulas.js';

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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body || {};
  if (action === 'avatar')   return handleAvatar(req, res);
  if (action === 'location') return handleLocation(req, res);

  // Default: full player init
  const { telegram_id, username } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });

  const ADMIN_TG_ID = 560013667;
  let tgId;
  try { tgId = parseTgId(telegram_id); } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Maintenance mode check — admin always bypasses
  if (tgId !== ADMIN_TG_ID) {
    const { data: setting } = await supabase
      .from('app_settings').select('value').eq('key', 'maintenance_mode').single();
    if (setting?.value === 'true') return res.status(503).json({ maintenance: true });
  }

  // Upsert player
  const { data: player, error: playerError } = await supabase
    .from('players')
    .upsert(
      { telegram_id: tgId, username: username || null },
      { onConflict: 'telegram_id', ignoreDuplicates: false }
    )
    .select().single();

  if (playerError) {
    console.error('[init] player upsert error:', playerError);
    return res.status(500).json({ error: 'Failed to init player' });
  }

  // Fetch headquarters and mines in parallel
  const [{ data: headquarters }, { data: mines }] = await Promise.all([
    supabase.from('headquarters').select('*').eq('player_id', player.id).maybeSingle(),
    supabase.from('mines').select('*').eq('owner_id', player.id),
  ]);

  const level  = player.level ?? 1;
  const xp     = player.xp    ?? 0;
  const maxHp  = getMaxHp(level);
  const attack = getPlayerAttack(level);

  // Apply HP regen; initialise hp for new players
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

  const totalIncome = (mines || []).reduce((sum, m) => sum + getMineIncome(m.level), 0);

  return res.status(200).json({
    player: {
      ...player,
      level,
      xp,
      xpForNextLevel: xpForLevel(level),
      buildRadius:    getBuildRadius(level),
      hp:             currentHp,
      max_hp:         maxHp,
      attack,
      kills:          player.kills    ?? 0,
      deaths:         player.deaths   ?? 0,
      diamonds:       player.diamonds ?? 0,
    },
    headquarters: headquarters || null,
    mines: mines || [],
    totalIncome,
  });
}
