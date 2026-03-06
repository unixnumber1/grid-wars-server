import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { getCellId, getCellCenter } from '../../lib/grid.js';
import { hqUpgradeCost, HQ_MAX_LEVEL } from '../../lib/formulas.js';
import { addXp, XP_REWARDS } from '../../lib/xp.js';

// ── PLACE HQ ───────────────────────────────────────────────────────────────
async function handlePlace(player, body, res) {
  const { lat, lng } = body;
  if (lat == null || lng == null) {
    return res.status(400).json({ error: 'lat, lng are required' });
  }

  const { data: existingHq } = await supabase
    .from('headquarters').select('id').eq('player_id', player.id).maybeSingle();
  if (existingHq) return res.status(409).json({ error: 'Headquarters already placed' });

  const cell_id = getCellId(parseFloat(lat), parseFloat(lng));
  const { data: cellConflict } = await supabase
    .from('headquarters').select('id').eq('cell_id', cell_id).maybeSingle();
  if (cellConflict) return res.status(409).json({ error: 'Cell already occupied by another headquarters' });

  const [centerLat, centerLng] = getCellCenter(cell_id);

  const { data: hq, error: insertError } = await supabase
    .from('headquarters')
    .insert({ player_id: player.id, lat: centerLat, lng: centerLng, cell_id, coins: 0 })
    .select().single();
  if (insertError) {
    console.error('[headquarters] insert error:', insertError);
    return res.status(500).json({ error: 'Failed to place headquarters' });
  }

  let xpResult = null;
  try { xpResult = await addXp(player.id, XP_REWARDS.BUILD_HQ); } catch (e) {}

  return res.status(201).json({ headquarters: hq, xp: xpResult });
}

// ── UPGRADE HQ ─────────────────────────────────────────────────────────────
async function handleUpgrade(player, res) {
  const { data: hq, error: hqError } = await supabase
    .from('headquarters').select('*').eq('player_id', player.id).maybeSingle();
  if (hqError) return res.status(500).json({ error: hqError.message });
  if (!hq)     return res.status(404).json({ error: 'Headquarters not found' });

  const currentLevel = hq.level ?? 1;
  if (currentLevel >= HQ_MAX_LEVEL) return res.status(400).json({ error: 'Headquarters is already at max level' });

  const cost = hqUpgradeCost(currentLevel);
  if (hq.coins < cost) return res.status(400).json({ error: `Не хватает монет (нужно ${cost})` });

  const { data: updatedHq, error: updateError } = await supabase
    .from('headquarters')
    .update({ level: currentLevel + 1, coins: hq.coins - cost })
    .eq('id', hq.id).select().single();
  if (updateError) return res.status(500).json({ error: 'Failed to upgrade headquarters' });

  let xpResult = null;
  try { xpResult = await addXp(player.id, XP_REWARDS.UPGRADE_HQ); } catch (e) {}

  return res.status(200).json({ headquarters: updatedHq, xp: xpResult });
}

// ── SELL HQ ────────────────────────────────────────────────────────────────
async function handleSell(player, res) {
  const { data: hq, error: hqError } = await supabase
    .from('headquarters').select('id').eq('player_id', player.id).maybeSingle();
  if (hqError) return res.status(500).json({ error: hqError.message });
  if (!hq)     return res.status(404).json({ error: 'Headquarters not found' });

  const { error: delError } = await supabase.from('headquarters').delete().eq('id', hq.id);
  if (delError) return res.status(500).json({ error: delError.message });
  return res.status(200).json({ success: true });
}

// ── ROUTER ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telegram_id, action } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });

  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id);
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player)     return res.status(404).json({ error: 'Player not found' });

  if (action === 'upgrade') return handleUpgrade(player, res);
  if (action === 'sell')    return handleSell(player, res);
  return handlePlace(player, req.body, res);
}
