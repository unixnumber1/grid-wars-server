import { supabase, parseTgId } from '../../lib/supabase.js';
import { xpForLevel, getBuildRadius, getMaxHp, getPlayerAttack, calcHpRegen } from '../../lib/formulas.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Maintenance mode check
  const { data: setting } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'maintenance_mode')
    .single();
  if (setting?.value === 'true') {
    return res.status(503).json({ maintenance: true });
  }

  const { telegram_id, username } = req.body;

  if (!telegram_id) {
    return res.status(400).json({ error: 'telegram_id is required' });
  }

  let tgId;
  try { tgId = parseTgId(telegram_id); } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Upsert player
  const { data: player, error: playerError } = await supabase
    .from('players')
    .upsert(
      { telegram_id: tgId, username: username || null },
      { onConflict: 'telegram_id', ignoreDuplicates: false }
    )
    .select()
    .single();

  if (playerError) {
    console.error('[init] player upsert error:', playerError);
    return res.status(500).json({ error: 'Failed to init player' });
  }

  // Fetch headquarters and mines in parallel
  const [{ data: headquarters }, { data: mines }] = await Promise.all([
    supabase.from('headquarters').select('*').eq('player_id', player.id).maybeSingle(),
    supabase.from('mines').select('*').eq('owner_id', player.id),
  ]);

  const level     = player.level ?? 1;
  const xp        = player.xp    ?? 0;
  const maxHp     = getMaxHp(level);
  const attack    = getPlayerAttack(level);

  // Apply HP regen; initialise hp for new players
  let currentHp = player.hp ?? maxHp;
  let regenApplied = false;
  if (currentHp < maxHp) {
    const regenedHp = calcHpRegen(currentHp, maxHp, player.last_hp_regen);
    if (regenedHp !== currentHp) {
      currentHp    = regenedHp;
      regenApplied = true;
    }
  }
  // Persist hp / max_hp / last_hp_regen if changed or unset
  if (player.hp == null || player.max_hp !== maxHp || regenApplied) {
    await supabase.from('players').update({
      hp:            currentHp,
      max_hp:        maxHp,
      last_hp_regen: new Date().toISOString(),
    }).eq('id', player.id);
  }

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
      kills:          player.kills  ?? 0,
      deaths:         player.deaths ?? 0,
    },
    headquarters: headquarters || null,
    mines: mines || [],
  });
}
