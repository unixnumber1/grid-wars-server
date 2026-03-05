import { supabase } from '../../lib/supabase.js';
import { UPGRADE_COST, MAX_LEVEL } from '../../lib/income.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { telegram_id, mine_id } = req.body;

  if (!telegram_id || !mine_id) {
    return res.status(400).json({ error: 'telegram_id and mine_id are required' });
  }

  // Resolve player
  const { data: player, error: playerError } = await supabase
    .from('players')
    .select('id')
    .eq('telegram_id', Number(telegram_id))
    .maybeSingle();

  if (playerError || !player) {
    return res.status(404).json({ error: 'Player not found' });
  }

  // Fetch mine
  const { data: mine, error: mineError } = await supabase
    .from('mines')
    .select('*')
    .eq('id', mine_id)
    .maybeSingle();

  if (mineError || !mine) {
    return res.status(404).json({ error: 'Mine not found' });
  }

  // Ownership check
  if (mine.owner_id !== player.id) {
    return res.status(403).json({ error: 'You do not own this mine' });
  }

  // Level cap
  if (mine.level >= MAX_LEVEL) {
    return res.status(400).json({ error: 'Mine is already at max level' });
  }

  const cost = UPGRADE_COST[mine.level]; // cost to go from current level to current+1

  // Fetch HQ balance
  const { data: hq, error: hqError } = await supabase
    .from('headquarters')
    .select('id, coins')
    .eq('player_id', player.id)
    .maybeSingle();

  if (hqError || !hq) {
    return res.status(404).json({ error: 'Headquarters not found' });
  }

  if (hq.coins < cost) {
    return res.status(400).json({ error: `Not enough coins (need ${cost}, have ${hq.coins})` });
  }

  // Deduct coins and upgrade level atomically using two updates
  const [{ error: hqUpdateError }, { data: updatedMine, error: mineUpdateError }] =
    await Promise.all([
      supabase
        .from('headquarters')
        .update({ coins: hq.coins - cost })
        .eq('id', hq.id),
      supabase
        .from('mines')
        .update({ level: mine.level + 1 })
        .eq('id', mine_id)
        .select()
        .single(),
    ]);

  if (hqUpdateError || mineUpdateError) {
    console.error('Upgrade error:', hqUpdateError, mineUpdateError);
    return res.status(500).json({ error: 'Failed to upgrade mine' });
  }

  return res.status(200).json({
    mine: updatedMine,
    hq_coins: hq.coins - cost,
  });
}
