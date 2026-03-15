import { supabase, getPlayerByTelegramId, parseTgId } from '../../lib/supabase.js';
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
    .select('id,type,attack,crit_chance,defense,stat_value')
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

  const [{ error: delErr }, { data: diamOk, error: diamErr }] = await Promise.all([
    supabase.from('items').delete().eq('id', item_id),
    supabase.from('players').update({ diamonds: newDiamonds }).eq('id', player.id).eq('diamonds', player.diamonds ?? 0).select('id').maybeSingle(),
  ]);
  if (delErr || diamErr) return { status: 500, error: 'Transaction failed' };

  return { diamonds: newDiamonds, soldFor };
}

// ── MSK time helpers ────────────────────────────────────────
function toMsk(date) {
  const d = new Date(date);
  d.setHours(d.getHours() + 3);
  return d;
}

function _checkDailyAvailable(player) {
  const now = new Date();
  const lastClaim = player.daily_diamonds_claimed_at;
  const lastMsk = lastClaim ? toMsk(lastClaim) : null;
  const nowMsk = toMsk(now);
  const todayMidnight = new Date(nowMsk);
  todayMidnight.setHours(0, 0, 0, 0);

  if (lastMsk && lastMsk >= todayMidnight) {
    const tomorrow = new Date(todayMidnight);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return { canClaim: false, nextClaimIn: tomorrow - nowMsk };
  }
  return { canClaim: true };
}

async function handleDailyCheck(req, res) {
  const { telegram_id } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  const { player, error } = await getPlayerByTelegramId(
    telegram_id, 'id,daily_diamonds_claimed_at'
  );
  if (error)   return res.status(500).json({ error });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  return res.json(_checkDailyAvailable(player));
}

async function handleDailyDiamonds(req, res) {
  const { telegram_id } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  const { player, error } = await getPlayerByTelegramId(
    telegram_id, 'id,diamonds,daily_diamonds_claimed_at'
  );
  if (error)   return res.status(500).json({ error });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const check = _checkDailyAvailable(player);
  if (!check.canClaim) {
    return res.status(400).json({ error: 'Уже получено', nextClaimIn: check.nextClaimIn });
  }

  const oldDiamonds = player.diamonds ?? 0;
  const newDiamonds = oldDiamonds + 5;

  const { data: ok, error: upErr } = await supabase.from('players')
    .update({ diamonds: newDiamonds, daily_diamonds_claimed_at: new Date().toISOString() })
    .eq('id', player.id).eq('diamonds', oldDiamonds)
    .select('id').maybeSingle();

  if (upErr) return res.status(500).json({ error: 'DB error' });
  if (!ok)   return res.status(409).json({ error: 'Конфликт — попробуйте снова' });

  return res.json({ success: true, diamonds: newDiamonds, gained: 5 });
}

async function handleStarsInvoice(req, res) {
  const { telegram_id, diamonds = 100, stars = 15 } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) return res.status(500).json({ error: 'Bot not configured' });

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `💎 ${diamonds} алмазов`,
        description: `Grid Wars — ${diamonds} алмазов для игры`,
        payload: JSON.stringify({ telegram_id, product: 'diamonds_purchase', diamonds }),
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: `${diamonds} алмазов`, amount: stars }],
      }),
    }
  );
  const data = await response.json();
  if (!data.ok) return res.status(500).json({ error: 'Failed to create invoice', details: data.description });
  return res.json({ invoiceLink: data.result });
}

async function handleStarsWebhook(req, res) {
  const update = req.body;

  if (update.pre_checkout_query) {
    const BOT_TOKEN = process.env.BOT_TOKEN;
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pre_checkout_query_id: update.pre_checkout_query.id, ok: true }),
    });
    return res.json({ ok: true });
  }

  if (update.message?.successful_payment) {
    const payment = update.message.successful_payment;
    let payload;
    try { payload = JSON.parse(payment.invoice_payload); } catch (_) {
      return res.json({ ok: true });
    }

    if (payload.product === 'diamonds_100' || payload.product === 'diamonds_purchase') {
      const diamondsAmount = payload.diamonds || 100;
      const { data: player } = await supabase
        .from('players').select('id, diamonds')
        .eq('telegram_id', String(payload.telegram_id)).single();

      if (player) {
        await supabase.from('players')
          .update({ diamonds: (player.diamonds ?? 0) + diamondsAmount })
          .eq('id', player.id);

        const BOT_TOKEN = process.env.BOT_TOKEN;
        // Notify buyer
        const buyerRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: payload.telegram_id,
            text: `💎 ${diamondsAmount} алмазов зачислено!\nСпасибо за поддержку Grid Wars ⚔️`,
          }),
        }).catch(e => console.error('[stars] buyer notify error:', e.message));
        if (buyerRes && !buyerRes.ok) console.error('[stars] buyer notify fail:', await buyerRes.text().catch(() => ''));

        // Notify admin about purchase
        const ADMIN_TG_ID = 560013667;
        const buyerName = update.message.from?.username || update.message.from?.first_name || payload.telegram_id;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: ADMIN_TG_ID,
            text: `💰 Покупка!\n👤 ${buyerName} (${payload.telegram_id})\n⭐ ${payment.total_amount} Stars\n💎 ${diamondsAmount} алмазов`,
          }),
        }).catch(e => console.error('[stars] admin notify error:', e.message));
      }
    }
    return res.json({ ok: true });
  }

  return res.json({ ok: true });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};

  // Detect Telegram webhook calls (no action/telegram_id, has update structure)
  if (body.pre_checkout_query || body.message?.successful_payment) {
    return handleStarsWebhook(req, res);
  }

  const { telegram_id, action } = body;

  // Daily actions don't need player select with diamonds
  if (action === 'daily-check')    return handleDailyCheck(req, res);
  if (action === 'daily-diamonds') return handleDailyDiamonds(req, res);
  if (action === 'stars-invoice')  return handleStarsInvoice(req, res);

  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  const selectFields = (action === 'sell' || action === 'open-box' || action === 'craft') ? 'id,level,diamonds' : 'id,level';
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

    const { data: diamOk, error: updateErr } = await supabase.from('players').update({ diamonds: newDiamonds }).eq('id', player.id).eq('diamonds', diamonds).select('id').maybeSingle();
    if (updateErr) return res.status(500).json({ error: 'Failed to update diamonds' });
    if (!diamOk && !updateErr) return res.status(409).json({ error: 'Конфликт — попробуйте снова' });

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

  // Craft action
  if (action === 'craft') {
    const { item_ids } = body;
    if (!Array.isArray(item_ids) || item_ids.length !== 10) {
      return res.status(400).json({ error: 'Нужно ровно 10 предметов' });
    }

    const NEXT_RARITY = {
      common: 'uncommon', uncommon: 'rare', rare: 'epic',
      epic: 'mythic', mythic: 'legendary',
    };

    // Fetch all 10 items
    const { data: items, error: fetchErr } = await supabase
      .from('items').select('id,type,rarity,equipped,on_market,owner_id')
      .in('id', item_ids).eq('owner_id', player.id);
    if (fetchErr) return res.status(500).json({ error: 'DB error' });
    if (!items || items.length !== 10) {
      return res.status(400).json({ error: 'Некоторые предметы не найдены или не ваши' });
    }

    // Check all same rarity, none equipped, none on market
    const rarity = items[0].rarity;
    for (const it of items) {
      if (it.rarity !== rarity) return res.status(400).json({ error: 'Все предметы должны быть одной редкости' });
      if (it.equipped) return res.status(400).json({ error: 'Снимите экипированные предметы' });
      if (it.on_market) return res.status(400).json({ error: 'Предмет на маркете' });
    }
    if (rarity === 'legendary') {
      return res.status(400).json({ error: 'Легендарные предметы нельзя крафтить' });
    }

    const nextRarity = NEXT_RARITY[rarity];

    // Weighted random type based on input items
    const typeCounts = {};
    for (const it of items) typeCounts[it.type] = (typeCounts[it.type] || 0) + 1;
    const roll = Math.random() * 10;
    let cumulative = 0, resultType = null;
    for (const [type, count] of Object.entries(typeCounts)) {
      cumulative += count;
      if (roll < cumulative) { resultType = type; break; }
    }
    if (!resultType) resultType = items[0].type;

    const newItemData = generateItem(resultType, nextRarity);

    // Delete 10 items
    const { error: delErr } = await supabase.from('items').delete().in('id', item_ids);
    if (delErr) return res.status(500).json({ error: 'Failed to delete items' });

    // Insert new item
    const insertData = {
      type: resultType, rarity: nextRarity, name: newItemData.name, emoji: newItemData.emoji,
      stat_value: newItemData.stat_value, owner_id: player.id, equipped: false,
      attack: newItemData.attack || 0, crit_chance: newItemData.crit_chance || 0, defense: newItemData.defense || 0,
    };
    const { data: createdItem, error: insErr } = await supabase.from('items').insert(insertData).select().single();
    if (insErr) return res.status(500).json({ error: 'Failed to create item' });

    const typeChances = {};
    for (const [t, c] of Object.entries(typeCounts)) typeChances[t] = c * 10;

    return res.json({
      success: true,
      item: { id: createdItem.id, type: resultType, rarity: nextRarity, name: newItemData.name,
        emoji: newItemData.emoji, stat_value: newItemData.stat_value,
        attack: newItemData.attack || 0, crit_chance: newItemData.crit_chance || 0, defense: newItemData.defense || 0 },
      consumed: 10, resultType, typeChances,
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
