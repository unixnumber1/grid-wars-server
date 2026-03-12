import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { getMaxHp } from '../../lib/formulas.js';
import { ITEM_SELL_PRICE, generateItem } from '../../lib/items.js';

// ── Shop box constants ────────────────────────────────────────
const BOX_PRICES = { rare: 5, epic: 30 };
const BOX_ODDS = {
  rare: { common: 40, uncommon: 35, rare: 20, epic: 4, mythic: 1 },
  epic: { uncommon: 35, rare: 35, epic: 20, mythic: 10 },
};
const ITEM_TYPES = ['sword', 'axe', 'shield'];

function rollWeighted(weights) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let rand = Math.random() * total;
  for (const [key, weight] of Object.entries(weights)) {
    rand -= weight;
    if (rand <= 0) return key;
  }
  return Object.keys(weights)[0];
}

async function recalcBonuses(playerId, level) {
  const { data: equipped } = await supabase
    .from('items')
    .select('*')
    .eq('owner_id', playerId)
    .eq('equipped', true);

  const weapon = (equipped || []).find(i => i.type === 'sword' || i.type === 'axe');
  const shield = (equipped || []).find(i => i.type === 'shield');

  const bonus_attack = weapon ? (weapon.attack || weapon.stat_value || 0) : 0;
  const bonus_crit   = weapon?.type === 'sword' ? (weapon.crit_chance || 0) : 0;
  const bonus_hp     = shield ? (shield.defense || shield.stat_value || 0) : 0;
  const max_hp       = getMaxHp(level) + bonus_hp;
  return { bonus_attack, bonus_crit, bonus_hp, max_hp };
}

async function handleEquip(player, body) {
  const { item_id } = body;
  if (!item_id) return { status: 400, error: 'item_id required' };

  const { data: item } = await supabase
    .from('items').select('id,type,on_market').eq('id', item_id).eq('owner_id', player.id).maybeSingle();
  if (!item) return { status: 404, error: 'Item not found or not yours' };
  if (item.on_market) return { status: 400, error: 'Item is on market' };

  // Weapon types share a slot (sword OR axe)
  const isWeapon = item.type === 'sword' || item.type === 'axe';
  if (isWeapon) {
    // Unequip any weapon (sword or axe)
    await supabase.from('items').update({ equipped: false })
      .eq('owner_id', player.id).in('type', ['sword', 'axe']);
  } else {
    // Unequip same type (shield)
    await supabase.from('items').update({ equipped: false })
      .eq('owner_id', player.id).eq('type', item.type);
  }
  await supabase.from('items').update({ equipped: true }).eq('id', item_id);

  const bonuses = await recalcBonuses(player.id, player.level ?? 1);
  const update  = { ...bonuses };
  if (isWeapon) {
    update.equipped_sword = item_id; // reuse column for any weapon
  } else {
    update.equipped_shield = item_id;
  }
  await supabase.from('players').update(update).eq('id', player.id);

  return { ...bonuses };
}

async function handleUnequip(player, body) {
  const { item_id } = body;
  if (!item_id) return { status: 400, error: 'item_id required' };

  const { data: item } = await supabase
    .from('items').select('id,type').eq('id', item_id).eq('owner_id', player.id).maybeSingle();
  if (!item) return { status: 404, error: 'Item not found or not yours' };

  await supabase.from('items').update({ equipped: false }).eq('id', item_id);

  const bonuses    = await recalcBonuses(player.id, player.level ?? 1);
  const isWeapon   = item.type === 'sword' || item.type === 'axe';
  const clearField = isWeapon ? 'equipped_sword' : 'equipped_shield';
  await supabase.from('players').update({ ...bonuses, [clearField]: null }).eq('id', player.id);

  return { ...bonuses };
}

async function handleSell(player, body) {
  const { item_id } = body;
  if (!item_id) return { status: 400, error: 'item_id required' };

  const { data: item } = await supabase
    .from('items').select('id, rarity, equipped, on_market')
    .eq('id', item_id).eq('owner_id', player.id).maybeSingle();

  if (!item) return { status: 404, error: 'Предмет не найден' };
  if (item.equipped) return { status: 400, error: 'Сначала снимите предмет' };
  if (item.on_market) return { status: 400, error: 'Предмет на маркете' };

  const soldFor = ITEM_SELL_PRICE[item.rarity] ?? 1;
  const newDiamonds = (player.diamonds ?? 0) + soldFor;

  await Promise.all([
    supabase.from('items').delete().eq('id', item_id),
    supabase.from('players').update({ diamonds: newDiamonds }).eq('id', player.id),
  ]);

  return { diamonds: newDiamonds, soldFor };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const { telegram_id, action } = body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  const selectFields = (action === 'sell' || action === 'open-box') ? 'id,level,diamonds' : 'id,level';
  const { player, error } = await getPlayerByTelegramId(telegram_id, selectFields);
  if (error)   return res.status(500).json({ error });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  // Open box action (merged from /api/shop/open-box)
  if (action === 'open-box') {
    const { box_type } = body;
    if (!box_type || !BOX_PRICES[box_type]) return res.status(400).json({ error: 'Invalid box_type' });
    const price = BOX_PRICES[box_type];
    const diamonds = player.diamonds ?? 0;
    if (diamonds < price) return res.status(400).json({ error: 'Недостаточно алмазов' });

    const rarity = rollWeighted(BOX_ODDS[box_type]);
    const type = ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)];
    const item = generateItem(type, rarity);
    const newDiamonds = diamonds - price;

    const { error: updateErr } = await supabase.from('players').update({ diamonds: newDiamonds }).eq('id', player.id);
    if (updateErr) return res.status(500).json({ error: 'Failed to update diamonds' });

    const insertData = {
      type, rarity: item.rarity, name: item.name, emoji: item.emoji,
      stat_value: item.stat_value, owner_id: player.id, equipped: false,
      attack: item.attack || 0, crit_chance: item.crit_chance || 0, defense: item.defense || 0,
    };
    let { data: newItem, error: insertErr } = await supabase.from('items').insert(insertData).select().single();
    if (insertErr) {
      await supabase.from('players').update({ diamonds }).eq('id', player.id);
      return res.status(500).json({ error: 'Failed to create item' });
    }
    return res.json({
      success: true,
      item: { id: newItem.id, type, rarity: item.rarity, name: item.name, emoji: item.emoji,
        stat_value: item.stat_value, attack: item.attack || 0, crit_chance: item.crit_chance || 0, defense: item.defense || 0 },
      diamondsLeft: newDiamonds,
    });
  }

  let result;
  if      (action === 'equip')   result = await handleEquip(player, body);
  else if (action === 'unequip') result = await handleUnequip(player, body);
  else if (action === 'sell')    result = await handleSell(player, body);
  else return res.status(400).json({ error: 'Unknown action' });

  if (result.status) return res.status(result.status).json({ error: result.error });
  return res.json({ success: true, ...result });
}
