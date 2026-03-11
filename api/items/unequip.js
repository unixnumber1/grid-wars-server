import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { getMaxHp } from '../../lib/formulas.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telegram_id, item_id } = req.body || {};
  if (!telegram_id || !item_id)
    return res.status(400).json({ error: 'telegram_id and item_id required' });

  const { player, error } = await getPlayerByTelegramId(telegram_id);
  if (error)   return res.status(500).json({ error });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  // Verify item belongs to player
  const { data: item } = await supabase
    .from('items').select('*').eq('id', item_id).eq('owner_id', player.id).maybeSingle();
  if (!item) return res.status(404).json({ error: 'Item not found or not yours' });

  await supabase.from('items').update({ equipped: false }).eq('id', item_id);

  // Clear reference on player
  const clearField = item.type === 'sword' ? 'equipped_sword' : 'equipped_shield';

  // Recalculate bonuses after unequip
  const { data: equipped } = await supabase
    .from('items')
    .select('type, stat_value')
    .eq('owner_id', player.id)
    .eq('equipped', true);

  const bonus_attack = (equipped || []).filter(i => i.type === 'sword').reduce((s, i) => s + i.stat_value, 0);
  const bonus_hp     = (equipped || []).filter(i => i.type === 'shield').reduce((s, i) => s + i.stat_value, 0);
  const max_hp       = getMaxHp(player.level ?? 1) + bonus_hp;

  await supabase.from('players').update({
    bonus_attack,
    bonus_hp,
    max_hp,
    [clearField]: null,
  }).eq('id', player.id);

  return res.json({ success: true, bonus_attack, bonus_hp, max_hp });
}
