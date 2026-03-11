import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { getMaxHp } from '../../lib/formulas.js';

async function recalcBonuses(playerId, level) {
  const { data: equipped } = await supabase
    .from('items')
    .select('type, stat_value')
    .eq('owner_id', playerId)
    .eq('equipped', true);

  const bonus_attack = (equipped || []).filter(i => i.type === 'sword').reduce((s, i) => s + i.stat_value, 0);
  const bonus_hp     = (equipped || []).filter(i => i.type === 'shield').reduce((s, i) => s + i.stat_value, 0);
  const max_hp       = getMaxHp(level) + bonus_hp;
  return { bonus_attack, bonus_hp, max_hp };
}

async function handleEquip(player, body) {
  const { item_id } = body;
  if (!item_id) return { status: 400, error: 'item_id required' };

  const { data: item } = await supabase
    .from('items').select('*').eq('id', item_id).eq('owner_id', player.id).maybeSingle();
  if (!item) return { status: 404, error: 'Item not found or not yours' };

  // Unequip same type, then equip selected
  await supabase.from('items').update({ equipped: false }).eq('owner_id', player.id).eq('type', item.type);
  await supabase.from('items').update({ equipped: true }).eq('id', item_id);

  const bonuses = await recalcBonuses(player.id, player.level ?? 1);
  const update  = { ...bonuses };
  if (item.type === 'sword')  update.equipped_sword  = item_id;
  if (item.type === 'shield') update.equipped_shield = item_id;
  await supabase.from('players').update(update).eq('id', player.id);

  return { ...bonuses };
}

async function handleUnequip(player, body) {
  const { item_id } = body;
  if (!item_id) return { status: 400, error: 'item_id required' };

  const { data: item } = await supabase
    .from('items').select('*').eq('id', item_id).eq('owner_id', player.id).maybeSingle();
  if (!item) return { status: 404, error: 'Item not found or not yours' };

  await supabase.from('items').update({ equipped: false }).eq('id', item_id);

  const bonuses    = await recalcBonuses(player.id, player.level ?? 1);
  const clearField = item.type === 'sword' ? 'equipped_sword' : 'equipped_shield';
  await supabase.from('players').update({ ...bonuses, [clearField]: null }).eq('id', player.id);

  return { ...bonuses };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const { telegram_id, action } = body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  const { player, error } = await getPlayerByTelegramId(telegram_id);
  if (error)   return res.status(500).json({ error });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  let result;
  if      (action === 'equip')   result = await handleEquip(player, body);
  else if (action === 'unequip') result = await handleUnequip(player, body);
  else return res.status(400).json({ error: 'Unknown action' });

  if (result.status) return res.status(result.status).json({ error: result.error });
  return res.json({ success: true, ...result });
}
