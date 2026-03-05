import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { hqUpgradeCost, HQ_MAX_LEVEL } from '../../lib/formulas.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { telegram_id } = req.body;
  if (!telegram_id) {
    return res.status(400).json({ error: 'telegram_id is required' });
  }

  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id);
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player)     return res.status(404).json({ error: 'Player not found' });

  const { data: hq, error: hqError } = await supabase
    .from('headquarters')
    .select('*')
    .eq('player_id', player.id)
    .maybeSingle();

  if (hqError) {
    console.error('[hq-upgrade] hq fetch error:', hqError);
    return res.status(500).json({ error: hqError.message });
  }
  if (!hq) return res.status(404).json({ error: 'Headquarters not found' });

  const currentLevel = hq.level ?? 1;

  if (currentLevel >= HQ_MAX_LEVEL) {
    return res.status(400).json({ error: 'Headquarters is already at max level' });
  }

  const cost = hqUpgradeCost(currentLevel);

  if (hq.coins < cost) {
    return res.status(400).json({ error: `Not enough coins (need ${cost}, have ${hq.coins})` });
  }

  const { data: updatedHq, error: updateError } = await supabase
    .from('headquarters')
    .update({ level: currentLevel + 1, coins: hq.coins - cost })
    .eq('id', hq.id)
    .select()
    .single();

  if (updateError) {
    console.error('[hq-upgrade] update error:', updateError);
    return res.status(500).json({ error: 'Failed to upgrade headquarters' });
  }

  return res.status(200).json({ headquarters: updatedHq });
}
