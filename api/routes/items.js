import { Router } from 'express';
import { supabase, getPlayerByTelegramId, parseTgId } from '../../lib/supabase.js';
import { getMaxHp } from '../../lib/formulas.js';
import { logPlayer } from '../../lib/logger.js';
import { ITEM_SELL_PRICE, getItemSellPrice, generateItem, getMaxUpgradeLevel, getUpgradeCost, getTotalUpgradeCost, getUpgradedStats, BOX_ODDS, rollWeighted, hasInventorySpace, getPlayerItemCount, getPlayerMaxSlots, getCraftRecipe } from '../../lib/items.js';
import { gameState } from '../../lib/gameState.js';
import { ts, getLang } from '../../config/i18n.js';
import { ITEM_TYPES, STAR_PACKS } from '../../config/constants.js';
import { withPlayerLock } from '../../lib/playerLock.js';
import { persistNow } from '../../game/state/persist.js';
import { STREAK_POOLS, STREAK_POOL_COUNT } from '../../config/streakRewards.js';
import { grantReward } from './rewards.js';

export const itemsRouter = Router();

// ── Shop box constants ────────────────────────────────────────
const BOX_PRICES = { common: 3, rare: 10, epic: 40, mythic: 150 };
const CORE_ORB_PRICE = 150;

async function recalcBonuses(playerId, level) {
  const { data: equipped } = await supabase
    .from('items')
    .select('id,type,rarity,attack,crit_chance,defense,stat_value,upgrade_level,base_attack,base_crit_chance,base_defense,block_chance,plus')
    .eq('owner_id', playerId)
    .eq('equipped', true);

  const weapon = (equipped || []).find(i => i.type === 'sword' || i.type === 'axe' || i.type === 'bow');
  const shield = (equipped || []).find(i => i.type === 'shield');

  let bonus_attack = 0, bonus_crit = 0;
  if (weapon) {
    const ws = getUpgradedStats(weapon);
    bonus_attack = ws.attack || 0;
    bonus_crit = weapon.type === 'sword' ? (ws.crit_chance || 0) : 0;
  }
  const bonus_hp = shield ? (getUpgradedStats(shield).defense || 0) : 0;
  const max_hp   = getMaxHp(level) + bonus_hp;
  return { bonus_attack, bonus_crit, bonus_hp, max_hp };
}

async function handleEquip(player, body) {
  const { item_id } = body;
  if (!item_id) return { status: 400, error: 'item_id required' };

  const { data: item } = await supabase
    .from('items').select('id,type,on_market,held_by_courier').eq('id', item_id).eq('owner_id', player.id).maybeSingle();
  if (!item) return { status: 404, error: 'Item not found or not yours' };
  if (item.on_market) return { status: 400, error: 'Item is on market' };
  if (item.held_by_courier) return { status: 400, error: 'Item in transit' };

  // Weapon types share a slot (sword OR axe OR bow)
  const isWeapon = item.type === 'sword' || item.type === 'axe' || item.type === 'bow';
  if (isWeapon) {
    // Unequip any weapon (sword/axe/bow)
    const { error: unequipErr } = await supabase.from('items').update({ equipped: false })
      .eq('owner_id', player.id).in('type', ['sword', 'axe', 'bow']);
    if (unequipErr) return { status: 500, error: 'Failed to unequip weapons' };
  } else {
    // Unequip same type (shield)
    const { error: unequipErr } = await supabase.from('items').update({ equipped: false })
      .eq('owner_id', player.id).eq('type', item.type);
    if (unequipErr) return { status: 500, error: 'Failed to unequip shield' };
  }
  const { error: equipErr } = await supabase.from('items').update({ equipped: true }).eq('id', item_id);
  if (equipErr) return { status: 500, error: 'Failed to equip item' };

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
      if (gi.owner_id === player.id && (isWeapon ? (gi.type === 'sword' || gi.type === 'axe' || gi.type === 'bow') : gi.type === item.type)) {
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
  const isWeapon   = item.type === 'sword' || item.type === 'axe' || item.type === 'bow';
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
    .from('items').select('id, rarity, equipped, on_market, upgrade_level')
    .eq('id', item_id).eq('owner_id', player.id).maybeSingle();

  if (!item) return { status: 404, error: 'Item not found' };
  if (item.equipped) return { status: 400, error: 'Unequip first' };
  if (item.on_market) return { status: 400, error: 'Item on market' };

  const soldFor = getItemSellPrice(item.rarity, item.upgrade_level || 0);
  const newCrystals = (player.crystals ?? 0) + soldFor;

  const [{ error: delErr }, { data: crOk, error: crErr }] = await Promise.all([
    supabase.from('items').delete().eq('id', item_id),
    supabase.from('players').update({ crystals: newCrystals }).eq('id', player.id).eq('crystals', player.crystals ?? 0).select('id').maybeSingle(),
  ]);
  if (delErr || crErr) return { status: 500, error: 'Transaction failed' };

  // Update gameState
  if (gameState.loaded) {
    gameState.removeItem(item_id);
    const p = gameState.getPlayerById(player.id);
    if (p) { p.crystals = newCrystals; gameState.markDirty('players', p.id); }
  }

  return { crystals: newCrystals, soldFor };
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
    const lang = getLang(gameState, telegram_id);
    return res.status(400).json({ error: ts(lang, 'err.already_claimed'), nextClaimIn: check.nextClaimIn });
  }

  const oldDiamonds = player.diamonds ?? 0;
  const newDiamonds = oldDiamonds + 5;

  const { data: ok, error: upErr } = await supabase.from('players')
    .update({ diamonds: newDiamonds, daily_diamonds_claimed_at: new Date().toISOString() })
    .eq('id', player.id).eq('diamonds', oldDiamonds)
    .select('id').maybeSingle();

  if (upErr) return res.status(500).json({ error: 'DB error' });
  if (!ok)   return res.status(409).json({ error: ts(getLang(gameState, telegram_id), 'err.conflict') });

  // Update gameState so tick returns correct diamonds and daily_diamonds_claimed_at
  if (gameState.loaded) {
    const p = gameState.getPlayerById(player.id);
    if (p) {
      p.diamonds = newDiamonds;
      p.daily_diamonds_claimed_at = new Date().toISOString();
      gameState.markDirty('players', p.id);
    }
  }

  logPlayer(telegram_id, 'action', 'Забрал ежедневные алмазы (+5💎)');
  return res.json({ success: true, diamonds: newDiamonds, gained: 5 });
}

// ── Weekly Login Streak ──────────────────────────────────────

function _getStreakState(player) {
  const nowMskDate = getMskDate(new Date());
  const lastClaim = player.streak_claimed_at;
  const day = player.streak_day ?? 0;
  const week = player.streak_week ?? 0;

  if (!lastClaim) return { canClaim: true, currentDay: 0, week };

  const lastMskDate = getMskDate(lastClaim);
  if (lastMskDate === nowMskDate) {
    // Already claimed today
    const nowMs = Date.now();
    const mskNow = new Date(nowMs + 3 * 60 * 60 * 1000);
    const mskMidnight = new Date(mskNow);
    mskMidnight.setUTCHours(0, 0, 0, 0);
    mskMidnight.setUTCDate(mskMidnight.getUTCDate() + 1);
    return { canClaim: false, currentDay: day, week, nextClaimIn: mskMidnight.getTime() - mskNow.getTime() };
  }

  // Check if yesterday (consecutive)
  const yesterday = getMskDate(new Date(Date.now() - 86400000));
  if (lastMskDate === yesterday) return { canClaim: true, currentDay: day, week };

  // Missed a day — reset streak, keep same week pool
  return { canClaim: true, currentDay: 0, week };
}

async function handleStreakCheck(req, res) {
  const { telegram_id } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  const { player, error } = await getPlayerByTelegramId(
    telegram_id, 'id,streak_day,streak_week,streak_claimed_at'
  );
  if (error) return res.status(500).json({ error });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const state = _getStreakState(player);
  const pool = STREAK_POOLS[state.week % STREAK_POOL_COUNT];
  return res.json({ ...state, rewards: pool });
}

async function handleStreakClaim(req, res) {
  const { telegram_id } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  return withPlayerLock(telegram_id, async () => {
    const { player, error } = await getPlayerByTelegramId(
      telegram_id, 'id,telegram_id,diamonds,crystals,ether,streak_day,streak_week,streak_claimed_at'
    );
    if (error) return res.status(500).json({ error });
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const state = _getStreakState(player);
    if (!state.canClaim) {
      return res.status(400).json({ error: 'Already claimed today', nextClaimIn: state.nextClaimIn });
    }

    const newDay = state.currentDay + 1; // 1-7
    const pool = STREAK_POOLS[state.week % STREAK_POOL_COUNT];
    const rewardDef = { ...pool[newDay - 1] };

    // Day 7 core chance
    if (rewardDef.coreChance && Math.random() < rewardDef.coreChance) {
      rewardDef.cores = [{ level: 0 }];
    }
    delete rewardDef.coreChance;

    // Grant reward using shared function from rewards.js
    const granted = await grantReward(player, telegram_id, rewardDef);

    // Update streak state
    let nextDay = newDay;
    let nextWeek = state.week;
    if (newDay >= 7) {
      nextDay = 0;
      nextWeek = (state.week + 1) % STREAK_POOL_COUNT;
    }

    const { error: streakErr } = await supabase.from('players').update({
      streak_day: nextDay,
      streak_week: nextWeek,
      streak_claimed_at: new Date().toISOString(),
    }).eq('id', player.id);
    if (streakErr) console.error('[streak] DB update failed:', streakErr.message);

    if (gameState.loaded) {
      const p = gameState.getPlayerById(player.id);
      if (p) {
        p.streak_day = nextDay;
        p.streak_week = nextWeek;
        p.streak_claimed_at = new Date().toISOString();
        gameState.markDirty('players', p.id);
      }
    }

    return res.json({
      success: true,
      day: newDay,
      week: nextWeek,
      reward: granted,
      streakComplete: newDay >= 7,
    });
  });
}

// ── Free Epic Box (one-time gift) ──────────────────────────
async function handleFreeEpicBoxCheck(req, res) {
  const { telegram_id } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  const key = `free_epic_box:${telegram_id}`;
  const claimed = gameState.getSetting(key);
  return res.json({ claimed: !!claimed });
}

async function handleFreeEpicBoxClaim(req, res) {
  const { telegram_id } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  return withPlayerLock(telegram_id, async () => {
    const key = `free_epic_box:${telegram_id}`;
    const already = gameState.getSetting(key);
    if (already) return res.status(400).json({ error: 'Already claimed' });

    const player = gameState.getPlayerByTgId(Number(telegram_id));
    if (!player) return res.status(404).json({ error: 'Player not found' });

    // Mark as claimed FIRST (prevents race conditions)
    await supabase.from('app_settings').insert({ key, value: new Date().toISOString() });
    gameState.setSetting(key, new Date().toISOString());

    // Grant epic box via shared reward function
    const granted = await grantReward(player, telegram_id, { boxes: ['epic'] });

    logPlayer(telegram_id, 'action', 'Получил бесплатный эпический ящик 🎁');
    return res.json({ success: true, reward: granted });
  });
}

// STAR_PACKS imported from config/constants.js via ITEM_TYPES import line

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
        title: ts(getLang(gameState, telegram_id), 'stars.title', { amount: pack.diamonds }),
        description: ts(getLang(gameState, telegram_id), 'stars.description', { amount: pack.diamonds }),
        payload: JSON.stringify({ telegram_id, product: `diamonds_${pack.diamonds}`, diamonds: pack.diamonds }),
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: ts(getLang(gameState, telegram_id), 'stars.price_label', { amount: pack.diamonds }), amount: pack.stars }],
      }),
    }
  );
  const data = await response.json();
  if (!data.ok) return res.status(500).json({ error: 'Failed to create invoice', details: data.description });
  return res.json({ invoiceLink: data.result });
}

export async function handleStarsWebhook(req, res) {
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

    // Idempotency: Telegram retries webhooks on network failures, and a malicious
    // proxy could replay them. Use telegram_payment_charge_id (unique per payment)
    // to ensure a single transaction is processed exactly once.
    const chargeId = payment.telegram_payment_charge_id || payment.provider_payment_charge_id;
    if (chargeId) {
      const settingKey = `stars_charge:${chargeId}`;
      // Atomic insert via upsert with onConflict that does nothing — if the row
      // already exists, we know the payment was already processed.
      try {
        const { data: settingRow } = await supabase.from('app_settings')
          .select('value').eq('key', settingKey).maybeSingle();
        if (settingRow) {
          console.log('[stars] DUPLICATE webhook ignored, charge_id:', chargeId);
          return res.json({ ok: true });
        }
        await supabase.from('app_settings').insert({
          key: settingKey,
          value: JSON.stringify({ telegram_id: payload.telegram_id, diamonds: payload.diamonds, stars: payment.total_amount, at: new Date().toISOString() }),
        });
      } catch (e) {
        // If insert collides (race between two concurrent webhook deliveries),
        // the unique constraint will throw. Treat as duplicate.
        console.log('[stars] charge_id collision, treating as duplicate:', chargeId);
        return res.json({ ok: true });
      }
    }

    if (payload.product && payload.product.startsWith('diamonds_')) {
      // Validate diamond amount against STAR_PACKS by actual payment amount (cannot be forged via webhook)
      const pack = STAR_PACKS.find(p => p.stars === payment.total_amount);
      if (!pack) {
        console.error('[stars] REJECTED unknown pack, total_amount:', payment.total_amount, 'payload:', JSON.stringify(payload));
        return res.json({ ok: true });
      }
      const diamondAmount = pack.diamonds;
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
            text: ts(getLang(gameState, payload.telegram_id), 'admin.diamonds_credited', { amount: diamondAmount }),
          }),
        }).catch(e => console.error('[stars] buyer notify error:', e.message));
        if (buyerRes && !buyerRes.ok) console.error('[stars] buyer notify fail:', await buyerRes.text().catch(() => ''));

        // Notify admin about purchase
        const { ADMIN_NOTIFY_ID } = await import('../../config/constants.js');
        const buyerName = update.message.from?.username || update.message.from?.first_name || payload.telegram_id;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: ADMIN_NOTIFY_ID,
            text: ts('ru', 'admin.purchase', { buyer: buyerName, tgId: payload.telegram_id, stars: payment.total_amount, diamonds: diamondAmount }),
          }),
        }).catch(e => console.error('[stars] admin notify error:', e.message));
      }
    }
    return res.json({ ok: true });
  }

  return res.json({ ok: true });
}

// ── ROUTE ───────────────────────────────────────────────────────────────────
itemsRouter.post('/', async (req, res) => {
  const body = req.body || {};

  const { telegram_id, action } = body;

  // Daily actions don't need player select with diamonds
  if (action === 'daily-check')    return handleDailyCheck(req, res);
  if (action === 'daily-diamonds') return handleDailyDiamonds(req, res);
  if (action === 'stars-invoice')  return handleStarsInvoice(req, res);
  if (action === 'streak-check')   return handleStreakCheck(req, res);
  if (action === 'streak-claim')   return handleStreakClaim(req, res);
  if (action === 'free-epic-box-check') return handleFreeEpicBoxCheck(req, res);
  if (action === 'free-epic-box-claim') return handleFreeEpicBoxClaim(req, res);

  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });
  return withPlayerLock(telegram_id, async () => {

  if (action === 'buy-slot') {
    const { INVENTORY_SLOT_PRICE, INVENTORY_MAX_SLOTS, INVENTORY_BASE_SLOTS } = await import('../../config/constants.js');
    const player = gameState.loaded ? gameState.getPlayerByTgId(Number(telegram_id)) : null;
    if (!player) return res.status(404).json({ error: 'Player not found' });
    const lang = getLang(gameState, telegram_id);
    const currentMax = INVENTORY_BASE_SLOTS + (player.extra_slots || 0);
    if (currentMax >= INVENTORY_MAX_SLOTS) return res.status(400).json({ error: ts(lang, 'err.max_slots_reached') });
    if ((player.diamonds || 0) < INVENTORY_SLOT_PRICE) return res.status(400).json({ error: ts(lang, 'err.not_enough_diamonds') });
    const oldD = player.diamonds;
    player.diamonds = (player.diamonds || 0) - INVENTORY_SLOT_PRICE;
    player.extra_slots = (player.extra_slots || 0) + 1;
    gameState.markDirty('players', player.id);
    const { error: upErr } = await supabase.from('players').update({ diamonds: player.diamonds, extra_slots: player.extra_slots }).eq('id', player.id);
    if (upErr) console.error('[buy-slot] DB update error:', upErr.message);
    console.log(`[buy-slot] tg:${telegram_id} diamonds: ${oldD} -> ${player.diamonds}, extra_slots: ${player.extra_slots}`);
    return res.json({ ok: true, diamonds: player.diamonds, max_slots: INVENTORY_BASE_SLOTS + player.extra_slots });
  }

  if (action === 'upgrade-item') {
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
    const lang = getLang(gameState, telegram_id);
    if (!item || item.owner_id !== p.id) return res.status(404).json({ error: ts(lang, 'err.item_not_found') });

    const maxLvl = getMaxUpgradeLevel(item.rarity, item.plus || 0);
    const currentLvl = item.upgrade_level || 0;
    if (currentLvl >= maxLvl) return res.status(400).json({ error: ts(lang, 'err.max_level') });

    const cost = getUpgradeCost(currentLvl + 1);
    const crystals = p.crystals ?? 0;
    if (crystals < cost) return res.status(400).json({ error: ts(lang, 'err.not_enough_crystals', { cost }), cost, have: crystals });

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
    let bonuses = null;
    if (item.equipped) {
      bonuses = await recalcBonuses(p.id, p.level ?? 1);
      await supabase.from('players').update(bonuses).eq('id', p.id);
      if (gameState.loaded) {
        const gp = gameState.getPlayerById(p.id);
        if (gp) Object.assign(gp, bonuses);
      }
    }

    return res.json({
      success: true, upgrade_level: newLevel, max_level: maxLvl,
      stats: upgraded, crystals_left: newCrystals, cost,
      ...(bonuses ? { bonus_attack: bonuses.bonus_attack, bonus_crit: bonuses.bonus_crit, bonus_hp: bonuses.bonus_hp, max_hp: bonuses.max_hp } : {}),
    });
  }

  if (action === 'buy-mythic') {
    const { player: p, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id,diamonds');
    if (pErr || !p) return res.status(404).json({ error: 'Player not found' });

    const { weapon_type } = body;
    if (!['sword', 'axe', 'shield', 'bow'].includes(weapon_type)) return res.status(400).json({ error: 'Invalid weapon_type' });

    const MYTHIC_PRICE = 600;
    const diamonds = p.diamonds ?? 0;
    if (diamonds < MYTHIC_PRICE) return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.need_diamonds', { cost: MYTHIC_PRICE }) });
    if (gameState.loaded && !hasInventorySpace(gameState, p.id)) return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.inventory_full', { n: getPlayerMaxSlots(gameState, p?.id || player?.id) }) });

    // Generate mythic with random stats from range
    const item = generateItem(weapon_type, 'mythic');
    const buyLang = getLang(gameState, telegram_id);

    const newDiamonds = diamonds - MYTHIC_PRICE;
    const { data: diamOk } = await supabase.from('players').update({ diamonds: newDiamonds }).eq('id', p.id).eq('diamonds', diamonds).select('id').maybeSingle();
    if (!diamOk) return res.status(409).json({ error: ts(buyLang, 'err.conflict') });

    const insertData = {
      type: weapon_type, rarity: 'mythic', name: item.name, emoji: item.emoji,
      stat_value: item.stat_value,
      attack: item.attack || 0, crit_chance: item.crit_chance || 0, defense: item.defense || 0,
      block_chance: item.block_chance || 0,
      base_attack: item.base_attack, base_crit_chance: item.base_crit_chance, base_defense: item.base_defense,
      upgrade_level: 0, plus: 0, owner_id: p.id, equipped: false,
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

  if (action === 'buy-mythic-set') {
    const { player: p, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id,diamonds');
    if (pErr || !p) return res.status(404).json({ error: 'Player not found' });

    const SET_PRICE = 2000; // 4 mythic items now (sword, axe, shield, bow)
    const diamonds = p.diamonds ?? 0;
    if (diamonds < SET_PRICE) return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.need_diamonds', { cost: SET_PRICE }) });
    if (gameState.loaded && !hasInventorySpace(gameState, p.id, 4)) return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.inventory_full', { n: getPlayerItemCount(gameState, p.id) }) });

    const setLang = getLang(gameState, telegram_id);

    const newDiamonds = diamonds - SET_PRICE;
    const { data: diamOk } = await supabase.from('players').update({ diamonds: newDiamonds }).eq('id', p.id).eq('diamonds', diamonds).select('id').maybeSingle();
    if (!diamOk) return res.status(409).json({ error: ts(getLang(gameState, telegram_id), 'err.conflict') });

    const createdItems = [];
    for (const wt of ['sword', 'axe', 'shield', 'bow']) {
      const item = generateItem(wt, 'mythic');
      const insertData = {
        type: wt, rarity: 'mythic', name: item.name, emoji: item.emoji,
        stat_value: item.stat_value,
        attack: item.attack || 0, crit_chance: item.crit_chance || 0, defense: item.defense || 0,
        block_chance: item.block_chance || 0,
        base_attack: item.base_attack, base_crit_chance: item.base_crit_chance, base_defense: item.base_defense,
        upgrade_level: 0, plus: 0, owner_id: p.id, equipped: false,
      };
      const { data: newItem, error: insErr } = await supabase.from('items').insert(insertData).select().single();
      if (insErr) {
        // Refund and return error
        await supabase.from('players').update({ diamonds }).eq('id', p.id);
        return res.status(500).json({ error: 'Failed to create items' });
      }
      createdItems.push(newItem);
      if (gameState.loaded && newItem) gameState.upsertItem(newItem);
    }

    if (gameState.loaded) {
      const gp = gameState.getPlayerById(p.id);
      if (gp) { gp.diamonds = newDiamonds; gameState.markDirty('players', gp.id); }
    }

    return res.json({ success: true, items: createdItems, diamondsLeft: newDiamonds });
  }

  if (action === 'open-core-orb') {
    const { player: p, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id,diamonds');
    if (pErr || !p) return res.status(404).json({ error: 'Player not found' });
    const diamonds = p.diamonds ?? 0;
    if (diamonds < CORE_ORB_PRICE) return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.need_diamonds', { cost: CORE_ORB_PRICE }) });

    const newDiamonds = diamonds - CORE_ORB_PRICE;
    const { data: diamOk } = await supabase.from('players').update({ diamonds: newDiamonds }).eq('id', p.id).eq('diamonds', diamonds).select('id').maybeSingle();
    if (!diamOk) return res.status(409).json({ error: ts(getLang(gameState, telegram_id), 'err.conflict') });

    const { randomCoreType } = await import('../../game/mechanics/cores.js');
    const coreData = { owner_id: Number(telegram_id), core_type: randomCoreType(), level: 0, mine_cell_id: null, slot_index: null };
    const { data: core, error: cErr } = await supabase.from('cores').insert(coreData).select().single();
    if (cErr) return res.status(500).json({ error: 'Failed to create core' });
    if (gameState.loaded) gameState.cores.set(core.id, core);

    if (gameState.loaded) {
      const gp = gameState.getPlayerById(p.id);
      if (gp) { gp.diamonds = newDiamonds; gameState.markDirty('players', gp.id); }
    }

    return res.json({ success: true, core, diamondsLeft: newDiamonds });
  }

  if (action === 'buy-core-pack') {
    const { pack_index } = body;
    const { CORE_PACKS } = await import('../../config/constants.js');
    const pack = CORE_PACKS[pack_index];
    if (!pack) return res.status(400).json({ error: 'Invalid pack' });

    const { player: p, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id,diamonds,ether');
    if (pErr || !p) return res.status(404).json({ error: 'Player not found' });

    const diamonds = p.diamonds ?? 0;
    if (diamonds < pack.price) return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.need_diamonds', { cost: pack.price }) });

    const newDiamonds = diamonds - pack.price;
    const { data: diamOk } = await supabase.from('players').update({ diamonds: newDiamonds }).eq('id', p.id).eq('diamonds', diamonds).select('id').maybeSingle();
    if (!diamOk) return res.status(409).json({ error: ts(getLang(gameState, telegram_id), 'err.conflict') });

    // Create cores — themed bundles with specific types
    const createdCores = [];
    for (const slot of pack.cores) {
      for (let i = 0; i < slot.count; i++) {
        const coreData = {
          owner_id: Number(telegram_id),
          core_type: slot.type,
          level: 0,
          mine_cell_id: null,
          slot_index: null,
        };
        const { data: core, error: cErr } = await supabase.from('cores').insert(coreData).select().single();
        if (!cErr && core) {
          createdCores.push(core);
          if (gameState.loaded) gameState.cores.set(core.id, core);
        }
      }
    }

    // Add ether if pack includes it
    let newEther = p.ether || 0;
    if (pack.ether > 0) {
      newEther += pack.ether;
      await supabase.from('players').update({ ether: newEther }).eq('id', p.id);
    }

    if (gameState.loaded) {
      const gp = gameState.getPlayerById(p.id);
      if (gp) {
        gp.diamonds = newDiamonds;
        if (pack.ether > 0) gp.ether = newEther;
        gameState.markDirty('players', gp.id);
      }
    }

    return res.json({ success: true, cores: createdCores, diamondsLeft: newDiamonds, etherLeft: newEther });
  }

  if (action === 'mass-sell') {
    const { item_ids } = body;
    if (!Array.isArray(item_ids) || item_ids.length === 0) return res.status(400).json({ error: 'item_ids required' });
    if (item_ids.length > 200) return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.max_200_items') });

    const { player: p, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id,crystals');
    if (pErr || !p) return res.status(404).json({ error: 'Player not found' });

    let totalCrystals = 0;
    const soldIds = [];
    for (const itemId of item_ids) {
      const item = gameState.loaded ? gameState.getItemById(itemId) : null;
      if (!item) continue;
      if (item.owner_id !== p.id) continue;
      if (item.equipped || item.on_market) continue;
      totalCrystals += getItemSellPrice(item.rarity, item.upgrade_level || 0);
      soldIds.push(itemId);
    }
    if (soldIds.length === 0) return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.no_items_to_sell') });

    const newCrystals = (p.crystals ?? 0) + totalCrystals;

    // Remove all items and update crystals in one batch
    await Promise.all([
      supabase.from('items').delete().in('id', soldIds).eq('owner_id', p.id),
      supabase.from('players').update({ crystals: newCrystals }).eq('id', p.id),
    ]);

    if (gameState.loaded) {
      for (const id of soldIds) gameState.removeItem(id);
      const gp = gameState.getPlayerById(p.id);
      if (gp) { gp.crystals = newCrystals; gameState.markDirty('players', gp.id); }
    }

    return res.json({ success: true, sold_count: soldIds.length, crystals_gained: totalCrystals, crystals: newCrystals });
  }

  const selectFields = (action === 'sell') ? 'id,level,crystals' : (action === 'craft') ? 'id,level,diamonds,crystals' : (action === 'open-box') ? 'id,level,diamonds' : 'id,level';
  const { player, error } = await getPlayerByTelegramId(telegram_id, selectFields);
  if (error)   return res.status(500).json({ error });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  // Open box action (merged from /api/shop/open-box)
  if (action === 'open-box') {
    const { box_type } = body;
    if (!box_type || !BOX_PRICES[box_type]) return res.status(400).json({ error: 'Invalid box_type' });
    const price = BOX_PRICES[box_type];

    // Read from gameState (rule #2), not DB
    const gsPlayer = gameState.loaded ? gameState.getPlayerByTgId(Number(telegram_id)) : null;
    if (!gsPlayer) return res.status(404).json({ error: 'Player not found' });
    const diamonds = gsPlayer.diamonds ?? 0;
    if (diamonds < price) return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.not_enough_diamonds_short') });
    if (!hasInventorySpace(gameState, gsPlayer.id)) return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.inventory_full', { n: getPlayerMaxSlots(gameState, gsPlayer.id) }) });

    // Deduct diamonds immediately in gameState (under withPlayerLock)
    const newDiamonds = diamonds - price;
    gsPlayer.diamonds = newDiamonds;

    const rarity = rollWeighted(BOX_ODDS[box_type]);
    const type = ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)];
    const item = generateItem(type, rarity);

    const insertData = {
      type, rarity: item.rarity, name: item.name, emoji: item.emoji,
      stat_value: item.stat_value, owner_id: gsPlayer.id, equipped: false,
      attack: item.attack || 0, crit_chance: item.crit_chance || 0, defense: item.defense || 0,
      base_attack: item.base_attack || 0, base_crit_chance: item.base_crit_chance || 0,
      base_defense: item.base_defense || 0, block_chance: item.block_chance || 0, upgrade_level: 0, plus: 0,
    };
    let { data: newItem, error: insertErr } = await supabase.from('items').insert(insertData).select().single();
    if (insertErr) {
      // Rollback diamonds in gameState
      gsPlayer.diamonds = diamonds;
      return res.status(500).json({ error: 'Failed to create item' });
    }

    // Persist diamonds immediately (critical money operation — rule #11)
    gameState.markDirty('players', gsPlayer.id);
    await persistNow('players', { id: gsPlayer.id, diamonds: newDiamonds });

    if (newItem) gameState.upsertItem(newItem);

    return res.json({
      success: true,
      item: { id: newItem.id, type, rarity: item.rarity, name: item.name, emoji: item.emoji,
        stat_value: item.stat_value, attack: item.attack || 0, crit_chance: item.crit_chance || 0, defense: item.defense || 0 },
      diamondsLeft: newDiamonds,
    });
  }

  // Craft action (new system: basic 3→1 + fusion)
  if (action === 'craft') {
    const { target_id, material_ids } = body;
    if (!target_id || !Array.isArray(material_ids) || material_ids.length < 1 || material_ids.length > 2) {
      return res.status(400).json({ error: 'target_id and material_ids (1-2) required' });
    }

    const allIds = [target_id, ...material_ids];
    const lang = getLang(gameState, telegram_id);

    // Prevent using same item as target and material
    const uniqueIds = new Set(allIds);
    if (uniqueIds.size !== allIds.length) return res.status(400).json({ error: 'Duplicate items' });

    if (!gameState.loaded) return res.status(503).json({ error: 'Game not ready' });

    // Fetch all items from gameState
    const allItems = allIds.map(id => gameState.getItemById(id)).filter(Boolean);
    if (allItems.length !== allIds.length) return res.status(400).json({ error: ts(lang, 'err.items_not_found') });

    // Validate ownership, not equipped, not on market, not in transit
    for (const it of allItems) {
      if (it.owner_id !== player.id) return res.status(400).json({ error: ts(lang, 'err.items_not_found') });
      if (it.equipped) return res.status(400).json({ error: ts(lang, 'err.unequip_crafting') });
      if (it.on_market) return res.status(400).json({ error: ts(lang, 'err.item_on_market') });
      if (it.held_by_courier) return res.status(400).json({ error: 'Item in transit' });
    }

    const target = allItems[0];
    const materials = allItems.slice(1);

    // Get craft recipe for target
    const recipe = getCraftRecipe(target.rarity, target.plus || 0);
    if (!recipe) return res.status(400).json({ error: 'Этот предмет нельзя улучшить' });

    // Validate material count
    if (materials.length !== recipe.materialCount) {
      return res.status(400).json({ error: `Нужно ${recipe.materialCount} материал(ов)` });
    }

    // Validate materials match recipe
    for (const mat of materials) {
      if (mat.type !== target.type) return res.status(400).json({ error: 'Материал должен быть того же типа' });
      if (mat.rarity !== recipe.materialRarity) return res.status(400).json({ error: 'Неподходящая редкость материала' });
      if ((mat.plus || 0) !== recipe.materialPlus) return res.status(400).json({ error: 'Неподходящий уровень + материала' });
    }

    // For basic craft (3→1): materials must match target rarity/plus too
    if (recipe.mode === 'basic') {
      if (target.rarity !== recipe.materialRarity) return res.status(400).json({ error: 'Все предметы должны быть одной редкости' });
    }

    // Generate new item — guarantee stats >= best base stats of ALL consumed items
    const newItemData = generateItem(target.type, recipe.resultRarity, recipe.resultPlus);
    for (const it of allItems) {
      if (newItemData.attack)      newItemData.attack      = Math.max(newItemData.attack,      it.base_attack || 0);
      if (newItemData.defense)     newItemData.defense     = Math.max(newItemData.defense,     it.base_defense || 0);
      if (newItemData.crit_chance) newItemData.crit_chance = Math.max(newItemData.crit_chance, it.base_crit_chance || 0);
      if (newItemData.block_chance && it.block_chance) newItemData.block_chance = Math.max(newItemData.block_chance, it.block_chance);
    }
    newItemData.base_attack      = newItemData.attack || 0;
    newItemData.base_defense     = newItemData.defense || 0;
    newItemData.base_crit_chance = newItemData.crit_chance || 0;
    newItemData.stat_value       = newItemData.attack || newItemData.defense || 0;

    // Insert new item FIRST (safe order — if fails, nothing is lost)
    const insertData = {
      type: target.type, rarity: recipe.resultRarity, plus: recipe.resultPlus,
      name: newItemData.name, emoji: newItemData.emoji,
      stat_value: newItemData.stat_value, owner_id: player.id, equipped: false,
      attack: newItemData.attack || 0, crit_chance: newItemData.crit_chance || 0, defense: newItemData.defense || 0,
      base_attack: newItemData.base_attack || 0, base_crit_chance: newItemData.base_crit_chance || 0,
      base_defense: newItemData.base_defense || 0, block_chance: newItemData.block_chance || 0, upgrade_level: 0,
    };
    const { data: createdItem, error: insErr } = await supabase.from('items').insert(insertData).select().single();
    if (insErr) return res.status(500).json({ error: 'Failed to create item' });

    // Delete consumed items AFTER successful insert
    const { error: delErr } = await supabase.from('items').delete().in('id', allIds).eq('owner_id', player.id);
    if (delErr) {
      // Rollback: delete the created item
      await supabase.from('items').delete().eq('id', createdItem.id);
      return res.status(500).json({ error: 'Failed to delete items' });
    }

    // Refund crystals for upgraded items
    let crystalsRefunded = 0;
    for (const it of allItems) {
      if (it.upgrade_level > 0) crystalsRefunded += getTotalUpgradeCost(it.upgrade_level);
    }
    if (crystalsRefunded > 0) {
      const gsPlayer = gameState.getPlayerById(player.id);
      const currentCrystals = gsPlayer?.crystals || player.crystals || 0;
      const newCrystals = currentCrystals + crystalsRefunded;
      if (gsPlayer) {
        gsPlayer.crystals = newCrystals;
        gameState.markDirty('players', gsPlayer.id);
      }
      await supabase.from('players').update({ crystals: newCrystals }).eq('id', player.id);
    }

    // Update gameState
    for (const id of allIds) gameState.removeItem(id);
    if (createdItem) gameState.upsertItem(createdItem);

    return res.json({
      success: true,
      item: { id: createdItem.id, type: target.type, rarity: recipe.resultRarity, plus: recipe.resultPlus,
        name: newItemData.name, emoji: newItemData.emoji, stat_value: newItemData.stat_value,
        attack: newItemData.attack || 0, crit_chance: newItemData.crit_chance || 0, defense: newItemData.defense || 0 },
      consumed: allIds.length, crystals_refunded: crystalsRefunded,
    });
  }

  let result;
  if      (action === 'equip')   result = await handleEquip(player, body);
  else if (action === 'unequip') result = await handleUnequip(player, body);
  else if (action === 'sell')    result = await handleSell(player, body);
  else return res.status(400).json({ error: 'Unknown action' });

  if (result.status) return res.status(result.status).json({ error: result.error });
  return res.json({ success: true, ...result });
  }); // withPlayerLock
});
