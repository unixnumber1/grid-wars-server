import { Router } from 'express';
import { supabase, getPlayerByTelegramId, parseTgId } from '../lib/supabase.js';
import { rateLimitMw } from '../lib/rateLimit.js';
import { getMaxHp } from '../lib/formulas.js';
import { ITEM_SELL_PRICE, generateItem, getMaxUpgradeLevel, getUpgradeCost, getUpgradedStats } from '../lib/items.js';
import { gameState } from '../lib/gameState.js';

export const itemsRouter = Router();

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

  // Update gameState
  if (gameState.loaded) {
    const p = gameState.getPlayerById(player.id);
    if (p) { Object.assign(p, update); gameState.markDirty('players', p.id); }
    // Update item equipped status in gameState
    for (const gi of gameState.items.values()) {
      if (gi.owner_id === player.id && (isWeapon ? (gi.type === 'sword' || gi.type === 'axe') : gi.type === item.type)) {
        gi.equipped = gi.id === item_id;
        gameState.markDirty('items', gi.id);
      }
    }
  }

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

  // Update gameState
  if (gameState.loaded) {
    const p = gameState.getPlayerById(player.id);
    if (p) { Object.assign(p, bonuses); p[clearField] = null; gameState.markDirty('players', p.id); }
    const gi = gameState.getItemById(item_id);
    if (gi) { gi.equipped = false; gameState.markDirty('items', gi.id); }
  }

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

  // Update gameState
  if (gameState.loaded) {
    gameState.removeItem(item_id);
    const p = gameState.getPlayerById(player.id);
    if (p) { p.diamonds = newDiamonds; gameState.markDirty('players', p.id); }
  }

  return { diamonds: newDiamonds, soldFor };
}

// ── MSK time helpers ────────────────────────────────────────
// Returns YYYY-MM-DD string in MSK (UTC+3)
function getMskDate(date) {
  const d = new Date(date);
  const mskMs = d.getTime() + 3 * 60 * 60 * 1000;
  const msk = new Date(mskMs);
  return msk.toISOString().slice(0, 10); // "2026-03-16"
}

function _checkDailyAvailable(player) {
  const nowMskDate = getMskDate(new Date());
  const lastClaim = player.daily_diamonds_claimed_at;

  if (lastClaim) {
    const lastMskDate = getMskDate(lastClaim);
    if (lastMskDate === nowMskDate) {
      // Already claimed today (MSK) — calculate time until MSK midnight
      const nowMs = Date.now();
      const mskNow = new Date(nowMs + 3 * 60 * 60 * 1000);
      const mskMidnight = new Date(mskNow);
      mskMidnight.setUTCHours(0, 0, 0, 0);
      mskMidnight.setUTCDate(mskMidnight.getUTCDate() + 1);
      const nextClaimIn = mskMidnight.getTime() - mskNow.getTime();
      return { canClaim: false, nextClaimIn };
    }
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

  // Update gameState so tick returns correct diamonds and daily_diamonds_claimed_at
  if (gameState.loaded) {
    const p = gameState.getPlayerById(player.id);
    if (p) {
      p.diamonds = newDiamonds;
      p.daily_diamonds_claimed_at = new Date().toISOString();
      gameState.markDirty('players', p.id);
    }
  }

  return res.json({ success: true, diamonds: newDiamonds, gained: 5 });
}

const STAR_PACKS = [
  { diamonds: 100, stars: 15 },
  { diamonds: 550, stars: 75 },
  { diamonds: 1200, stars: 150 },
  { diamonds: 2500, stars: 300 },
  { diamonds: 6500, stars: 750 },
  { diamonds: 15000, stars: 1500 },
];

async function handleStarsInvoice(req, res) {
  const { telegram_id, diamonds, stars } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) return res.status(500).json({ error: 'Bot not configured' });

  // Find matching pack or default to 100/15
  const reqDiamonds = parseInt(diamonds) || 100;
  const reqStars = parseInt(stars) || 15;
  const pack = STAR_PACKS.find(p => p.diamonds === reqDiamonds && p.stars === reqStars) || STAR_PACKS[0];

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `💎 ${pack.diamonds} алмазов`,
        description: `Overthrow — ${pack.diamonds} алмазов для игры`,
        payload: JSON.stringify({ telegram_id, product: `diamonds_${pack.diamonds}`, diamonds: pack.diamonds }),
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: `${pack.diamonds} алмазов`, amount: pack.stars }],
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

    if (payload.product && payload.product.startsWith('diamonds_')) {
      const diamondAmount = parseInt(payload.diamonds) || parseInt(payload.product.replace('diamonds_', '')) || 100;
      const { data: player } = await supabase
        .from('players').select('id, diamonds')
        .eq('telegram_id', String(payload.telegram_id)).single();

      if (player) {
        await supabase.from('players')
          .update({ diamonds: (player.diamonds ?? 0) + diamondAmount })
          .eq('id', player.id);

        // Update gameState
        if (gameState.loaded) {
          const gp = gameState.getPlayerById(player.id);
          if (gp) { gp.diamonds = (player.diamonds ?? 0) + diamondAmount; gameState.markDirty('players', gp.id); }
        }

        const BOT_TOKEN = process.env.BOT_TOKEN;
        // Notify buyer
        const buyerRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: payload.telegram_id,
            text: `💎 ${diamondAmount} алмазов зачислено!\nСпасибо за поддержку Overthrow ⚔️`,
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
            text: `💰 Покупка!\n👤 ${buyerName} (${payload.telegram_id})\n⭐ ${payment.total_amount} Stars\n💎 ${diamondAmount} алмазов`,
          }),
        }).catch(e => console.error('[stars] admin notify error:', e.message));
      }
    }
    return res.json({ ok: true });
  }

  return res.json({ ok: true });
}

// ── ROUTE ───────────────────────────────────────────────────────────────────
itemsRouter.post('/', rateLimitMw('default'), async (req, res) => {
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

  if (action === 'upgrade-item') {
    if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });
    const { player: p, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id,crystals');
    if (pErr || !p) return res.status(404).json({ error: 'Player not found' });
    const { item_id } = body;
    if (!item_id) return res.status(400).json({ error: 'item_id required' });

    // Get item from gameState or DB
    let item = gameState.loaded ? gameState.getItemById(item_id) : null;
    if (!item) {
      const { data } = await supabase.from('items').select('*').eq('id', item_id).maybeSingle();
      item = data;
    }
    if (!item || item.owner_id !== p.id) return res.status(404).json({ error: '\u041F\u0440\u0435\u0434\u043C\u0435\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D' });

    const maxLvl = getMaxUpgradeLevel(item.rarity);
    const currentLvl = item.upgrade_level || 0;
    if (currentLvl >= maxLvl) return res.status(400).json({ error: '\u041C\u0430\u043A\u0441\u0438\u043C\u0430\u043B\u044C\u043D\u044B\u0439 \u0443\u0440\u043E\u0432\u0435\u043D\u044C' });

    const cost = getUpgradeCost(currentLvl + 1);
    const crystals = p.crystals ?? 0;
    if (crystals < cost) return res.status(400).json({ error: `\u041D\u0443\u0436\u043D\u043E ${cost} \u2728`, cost, have: crystals });

    const newCrystals = crystals - cost;
    const newLevel = currentLvl + 1;

    // Update item
    item.upgrade_level = newLevel;
    const upgraded = getUpgradedStats(item);
    const itemUpdate = {
      upgrade_level: newLevel,
      attack: upgraded.attack || item.attack,
      crit_chance: upgraded.crit_chance || item.crit_chance,
      defense: upgraded.defense || item.defense,
    };

    await Promise.all([
      supabase.from('items').update(itemUpdate).eq('id', item_id),
      supabase.from('players').update({ crystals: newCrystals }).eq('id', p.id),
    ]);

    if (gameState.loaded) {
      Object.assign(item, itemUpdate);
      gameState.markDirty('items', item_id);
      const gp = gameState.getPlayerById(p.id);
      if (gp) { gp.crystals = newCrystals; gameState.markDirty('players', gp.id); }
    }

    // Recalc bonuses if equipped
    if (item.equipped) {
      const bonuses = await recalcBonuses(p.id, p.level ?? 1);
      await supabase.from('players').update(bonuses).eq('id', p.id);
      if (gameState.loaded) {
        const gp = gameState.getPlayerById(p.id);
        if (gp) Object.assign(gp, bonuses);
      }
    }

    return res.json({
      success: true, upgrade_level: newLevel, max_level: maxLvl,
      stats: upgraded, crystals_left: newCrystals, cost,
    });
  }

  if (action === 'buy-mythic') {
    if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });
    const { player: p, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id,diamonds');
    if (pErr || !p) return res.status(404).json({ error: 'Player not found' });

    const { weapon_type } = body;
    if (!['sword', 'axe', 'shield'].includes(weapon_type)) return res.status(400).json({ error: 'Invalid weapon_type' });

    const MYTHIC_PRICE = 500;
    const diamonds = p.diamonds ?? 0;
    if (diamonds < MYTHIC_PRICE) return res.status(400).json({ error: `\u041D\u0443\u0436\u043D\u043E ${MYTHIC_PRICE} \u{1F48E}` });

    // Fixed mid-range stats for mythic
    const mythicStats = {
      sword: { attack: 90, crit_chance: 13, defense: 0, block_chance: 0 },
      axe: { attack: 125, crit_chance: 0, defense: 0, block_chance: 0 },
      shield: { attack: 0, crit_chance: 0, defense: 790, block_chance: 15 },
    };
    const stats = mythicStats[weapon_type];
    const names = { sword: '\u0410\u0434\u0441\u043A\u0438\u0439 \u043A\u043B\u0438\u043D\u043E\u043A', axe: '\u0422\u043E\u043F\u043E\u0440 \u0445\u0430\u043E\u0441\u0430', shield: '\u0429\u0438\u0442 \u0442\u0438\u0442\u0430\u043D\u0430' };
    const emojis = { sword: '\u{1F5E1}\uFE0F', axe: '\u{1FA93}', shield: '\u{1F6E1}\uFE0F' };

    const newDiamonds = diamonds - MYTHIC_PRICE;
    const { data: diamOk } = await supabase.from('players').update({ diamonds: newDiamonds }).eq('id', p.id).eq('diamonds', diamonds).select('id').maybeSingle();
    if (!diamOk) return res.status(409).json({ error: '\u041A\u043E\u043D\u0444\u043B\u0438\u043A\u0442' });

    const insertData = {
      type: weapon_type, rarity: 'mythic', name: names[weapon_type], emoji: emojis[weapon_type],
      stat_value: stats.attack || stats.defense,
      attack: stats.attack, crit_chance: stats.crit_chance, defense: stats.defense,
      block_chance: stats.block_chance,
      base_attack: stats.attack, base_crit_chance: stats.crit_chance, base_defense: stats.defense,
      upgrade_level: 0, owner_id: p.id, equipped: false,
    };
    const { data: newItem, error: insErr } = await supabase.from('items').insert(insertData).select().single();
    if (insErr) {
      await supabase.from('players').update({ diamonds }).eq('id', p.id);
      return res.status(500).json({ error: 'Failed to create item' });
    }

    if (gameState.loaded) {
      if (newItem) gameState.upsertItem(newItem);
      const gp = gameState.getPlayerById(p.id);
      if (gp) { gp.diamonds = newDiamonds; gameState.markDirty('players', gp.id); }
    }

    return res.json({ success: true, item: newItem, diamondsLeft: newDiamonds });
  }

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
      base_attack: item.base_attack || 0, base_crit_chance: item.base_crit_chance || 0,
      base_defense: item.base_defense || 0, block_chance: item.block_chance || 0, upgrade_level: 0,
    };
    let { data: newItem, error: insertErr } = await supabase.from('items').insert(insertData).select().single();
    if (insertErr) {
      await supabase.from('players').update({ diamonds }).eq('id', player.id);
      return res.status(500).json({ error: 'Failed to create item' });
    }
    // Update gameState
    if (gameState.loaded) {
      if (newItem) gameState.upsertItem(newItem);
      const p = gameState.getPlayerById(player.id);
      if (p) { p.diamonds = newDiamonds; gameState.markDirty('players', p.id); }
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
      base_attack: newItemData.base_attack || 0, base_crit_chance: newItemData.base_crit_chance || 0,
      base_defense: newItemData.base_defense || 0, block_chance: newItemData.block_chance || 0, upgrade_level: 0,
    };
    const { data: createdItem, error: insErr } = await supabase.from('items').insert(insertData).select().single();
    if (insErr) return res.status(500).json({ error: 'Failed to create item' });

    // Update gameState
    if (gameState.loaded) {
      for (const id of item_ids) gameState.removeItem(id);
      if (createdItem) gameState.upsertItem(createdItem);
    }

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
});
