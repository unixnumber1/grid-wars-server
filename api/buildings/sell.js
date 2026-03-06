import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { calcAccumulatedCoins, getHQLimit } from '../../lib/formulas.js';

function calcSellRefund(level) {
  let sum = 0;
  for (let i = 2; i <= level; i++) {
    sum += Math.floor(50 * Math.pow(2.1, i - 1));
  }
  return Math.floor(sum * 0.3);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { telegram_id, mine_id } = req.body;
  if (!telegram_id || !mine_id) {
    return res.status(400).json({ error: 'telegram_id and mine_id are required' });
  }

  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id);
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player)     return res.status(404).json({ error: 'Player not found' });

  const [
    { data: mine,  error: mineError },
    { data: hq,    error: hqError },
  ] = await Promise.all([
    supabase.from('mines').select('*').eq('id', mine_id).maybeSingle(),
    supabase.from('headquarters').select('id, coins, level').eq('player_id', player.id).maybeSingle(),
  ]);

  if (mineError) {
    console.error('[sell] mine error:', mineError);
    return res.status(500).json({ error: mineError.message });
  }
  if (hqError) {
    console.error('[sell] hq error:', hqError);
    return res.status(500).json({ error: hqError.message });
  }
  if (!mine) return res.status(404).json({ error: 'Mine not found' });
  if (!hq)   return res.status(404).json({ error: 'Headquarters not found' });

  if (mine.owner_id !== player.id) {
    return res.status(403).json({ error: 'You do not own this mine' });
  }

  const collected = calcAccumulatedCoins(mine.level, mine.last_collected);
  const refund    = calcSellRefund(mine.level);
  const total     = collected + refund;

  const hqLimit    = getHQLimit(hq.level ?? 1);
  const newBalance = Math.min(hq.coins + total, hqLimit);

  const [{ error: hqUpdateError }, { error: deleteError }] = await Promise.all([
    supabase.from('headquarters').update({ coins: newBalance }).eq('id', hq.id),
    supabase.from('mines').delete().eq('id', mine_id),
  ]);

  if (hqUpdateError || deleteError) {
    console.error('[sell] error:', hqUpdateError, deleteError);
    return res.status(500).json({ error: 'Failed to sell mine' });
  }

  return res.status(200).json({ collected, refund, total, hq_coins: newBalance });
}
