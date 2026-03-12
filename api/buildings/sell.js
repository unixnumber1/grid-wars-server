import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { calcAccumulatedCoins, getMineUpgradeCost } from '../../lib/formulas.js';

function calcSellRefund(level) {
  let sum = 0;
  for (let i = 0; i < level; i++) sum += getMineUpgradeCost(i);
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

  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id, 'id, coins');
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player)     return res.status(404).json({ error: 'Player not found' });

  const { data: mine, error: mineError } = await supabase
    .from('mines').select('id,owner_id,level,last_collected,lat,lng').eq('id', mine_id).maybeSingle();

  if (mineError) {
    console.error('[sell] mine error:', mineError);
    return res.status(500).json({ error: mineError.message });
  }
  if (!mine) return res.status(404).json({ error: 'Mine not found' });

  if (mine.owner_id !== player.id) {
    return res.status(403).json({ error: 'You do not own this mine' });
  }

  const collected   = calcAccumulatedCoins(mine.level, mine.last_collected);
  const refund      = calcSellRefund(mine.level);
  const total       = collected + refund;
  const newCoins    = (player.coins ?? 0) + Math.round(total);

  const [{ error: playerUpdateError }, { error: deleteError }] = await Promise.all([
    supabase.from('players').update({ coins: newCoins }).eq('id', player.id),
    supabase.from('mines').delete().eq('id', mine_id),
  ]);

  if (playerUpdateError || deleteError) {
    console.error('[sell] error:', playerUpdateError, deleteError);
    return res.status(500).json({ error: 'Failed to sell mine' });
  }

  return res.status(200).json({
    collected:    Math.round(collected),
    refund:       Math.round(refund),
    total:        Math.round(total),
    player_coins: newCoins,
  });
}
