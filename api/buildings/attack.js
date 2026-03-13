import { supabase, getPlayerByTelegramId, rateLimit, sendTelegramNotification } from '../../lib/supabase.js';
import { LARGE_RADIUS, getMineHp, getMineHpRegen, calcMineHpRegen, getMineUpgradeCost, calcAccumulatedCoins } from '../../lib/formulas.js';
import { haversine } from '../../lib/haversine.js';
import { addXp } from '../../lib/xp.js';

// ── Start attack ──────────────────────────────────────────────────────────────
async function handleStart(req, res) {
  const { telegram_id, mine_id, lat, lng } = req.body || {};

  if (!telegram_id || !mine_id || lat == null || lng == null) {
    return res.status(400).json({ error: 'Missing required fields: telegram_id, mine_id, lat, lng' });
  }

  if (!rateLimit(telegram_id, 30)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id, 'id,game_username,bonus_attack,bonus_crit');
  if (playerError || !player) return res.status(404).json({ error: 'Player not found' });

  const { data: mine, error: mineError } = await supabase
    .from('mines')
    .select('id,owner_id,level,hp,max_hp,last_hp_update,status,lat,lng')
    .eq('id', mine_id).maybeSingle();

  if (mineError || !mine) return res.status(404).json({ error: 'Mine not found' });
  if (mine.owner_id === player.id) return res.status(400).json({ error: 'Нельзя атаковать свою шахту' });
  if (mine.status !== 'normal') return res.status(400).json({ error: 'Шахта уже атакована' });
  if (mine.level <= 0) return res.status(400).json({ error: 'Шахта неактивна' });

  const dist = haversine(lat, lng, mine.lat, mine.lng);
  if (dist > LARGE_RADIUS) return res.status(400).json({ error: 'Слишком далеко', distance: Math.round(dist) });

  const { data: existingAttack } = await supabase
    .from('mines').select('id').eq('attacker_id', player.id).eq('status', 'under_attack').maybeSingle();
  if (existingAttack) return res.status(400).json({ error: 'Вы уже атакуете другую шахту' });

  const { data: weapon } = await supabase
    .from('items').select('type,attack,crit_chance,emoji,rarity')
    .eq('owner_id', player.id).eq('equipped', true).in('type', ['sword', 'axe']).maybeSingle();

  const baseAttack = 10;
  const weaponAttack = weapon?.attack || 0;
  const critChance = weapon?.type === 'sword' ? (weapon.crit_chance || 0) : 0;
  const avgDamage = (baseAttack + weaponAttack) * (1 + critChance / 100);

  const computedMaxHp = getMineHp(mine.level);
  const regenPerHour = getMineHpRegen(mine.level);
  const rawHp = Math.min(mine.hp ?? computedMaxHp, computedMaxHp);
  const currentHp = calcMineHpRegen(rawHp, computedMaxHp, regenPerHour, mine.last_hp_update);

  const attackDuration = Math.max(3, Math.ceil(currentHp / avgDamage));
  const attackEndsAt = new Date(Date.now() + attackDuration * 1000).toISOString();

  const { error: updateError } = await supabase.from('mines').update({
    status: 'under_attack',
    attacker_id: player.id,
    attack_started_at: new Date().toISOString(),
    attack_ends_at: attackEndsAt,
    hp: currentHp,
    max_hp: computedMaxHp,
    last_hp_update: new Date().toISOString(),
  }).eq('id', mine_id).eq('status', 'normal');

  if (updateError) return res.status(500).json({ error: 'Failed to start attack' });

  const atkMsg = `⚔️ Ваша шахта Ур.${mine.level} атакована игроком ${player.game_username || 'Неизвестный'}!`;
  await supabase.from('notifications').insert({
    player_id: mine.owner_id,
    type: 'mine_attacked',
    message: atkMsg,
    data: { mine_id: mine.id },
  });

  // Telegram notification to mine owner
  const { data: owner } = await supabase.from('players').select('telegram_id').eq('id', mine.owner_id).maybeSingle();
  if (owner?.telegram_id) sendTelegramNotification(owner.telegram_id, atkMsg);

  return res.json({
    success: true,
    attackDuration,
    attackEndsAt,
    weapon: weapon ? { emoji: weapon.emoji, rarity: weapon.rarity, type: weapon.type } : null,
    mineHp: currentHp,
    mineMaxHp: computedMaxHp,
    avgDamage: Math.round(avgDamage),
  });
}

// ── Finish attack ─────────────────────────────────────────────────────────────
async function handleFinish(req, res) {
  const { telegram_id, mine_id } = req.body;
  if (!telegram_id || !mine_id) return res.status(400).json({ error: 'telegram_id and mine_id required' });

  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id,bonus_attack,bonus_crit');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { data: mine, error: mErr } = await supabase
    .from('mines')
    .select('id,owner_id,level,hp,max_hp,status,attacker_id,attack_started_at,attack_ends_at')
    .eq('id', mine_id).maybeSingle();

  if (mErr) return res.status(500).json({ error: mErr.message });
  if (!mine) return res.status(404).json({ error: 'Mine not found' });
  if (mine.status !== 'under_attack') return res.status(400).json({ error: 'Шахта не атакуется' });
  if (mine.attacker_id !== player.id) return res.status(403).json({ error: 'Вы не атакуете эту шахту' });

  const now = Date.now();
  if (new Date(mine.attack_ends_at).getTime() > now + 2000) {
    return res.status(400).json({ error: 'Атака ещё не завершена' });
  }

  const { data: weapon } = await supabase
    .from('items').select('type,attack,crit_chance')
    .eq('owner_id', player.id).eq('equipped', true).in('type', ['sword', 'axe']).maybeSingle();

  const baseAttack = 10;
  const weaponAttack = weapon?.attack || 0;
  const totalAttack = baseAttack + weaponAttack;
  const critChance = weapon?.type === 'sword' ? (weapon.crit_chance || 0) : 0;

  const attackDuration = Math.round((now - new Date(mine.attack_started_at).getTime()) / 1000);
  let remainingHp = mine.hp;
  for (let i = 0; i < attackDuration && remainingHp > 0; i++) {
    const isCrit = Math.random() * 100 < critChance;
    const dmg = isCrit ? totalAttack * 2 : totalAttack;
    remainingHp = Math.max(0, remainingHp - dmg);
  }

  if (remainingHp <= 0) {
    await supabase.from('mines').update({
      status: 'burning',
      hp: 0,
      burning_started_at: new Date().toISOString(),
      attacker_id: null,
      attack_started_at: null,
      attack_ends_at: null,
      last_hp_update: null,
    }).eq('id', mine_id);

    const burnMsg = `🔥 Ваша шахта Ур.${mine.level} горит! Потушите в течение 24 часов или она исчезнет.`;
    await supabase.from('notifications').insert({
      player_id: mine.owner_id,
      type: 'mine_burning',
      message: burnMsg,
      data: { mine_id: mine.id },
    });

    // Telegram notification
    const { data: burnOwner } = await supabase.from('players').select('telegram_id').eq('id', mine.owner_id).maybeSingle();
    if (burnOwner?.telegram_id) sendTelegramNotification(burnOwner.telegram_id, burnMsg);

    const xpGain = mine.level * 10;
    let xpResult = null;
    try { xpResult = await addXp(player.id, xpGain); } catch (_) {}

    return res.json({ success: true, result: 'burning', xpGain, xp: xpResult });
  } else {
    await supabase.from('mines').update({
      status: 'normal',
      hp: remainingHp,
      attacker_id: null,
      attack_started_at: null,
      attack_ends_at: null,
      last_hp_update: new Date().toISOString(),
    }).eq('id', mine_id);

    return res.json({ success: true, result: 'survived', remainingHp, maxHp: getMineHp(mine.level) });
  }
}

// ── Extinguish ────────────────────────────────────────────────────────────────
async function handleExtinguish(req, res) {
  const { telegram_id, mine_id } = req.body;
  if (!telegram_id || !mine_id) return res.status(400).json({ error: 'telegram_id and mine_id required' });

  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { data: mine, error: mErr } = await supabase
    .from('mines').select('id,owner_id,level,status,burning_started_at')
    .eq('id', mine_id).maybeSingle();

  if (mErr) return res.status(500).json({ error: mErr.message });
  if (!mine) return res.status(404).json({ error: 'Mine not found' });
  if (mine.owner_id !== player.id) return res.status(403).json({ error: 'Не ваша шахта' });
  if (mine.status !== 'burning') return res.status(400).json({ error: 'Шахта не горит' });

  if (Date.now() - new Date(mine.burning_started_at).getTime() > 86400000) {
    await supabase.from('mines').update({ status: 'destroyed' }).eq('id', mine_id);
    return res.json({ success: false, error: 'Шахта сгорела — слишком поздно' });
  }

  const computedMaxHp = getMineHp(mine.level);
  const restoredHp = Math.round(computedMaxHp * 0.25);

  await supabase.from('mines').update({
    status: 'normal',
    hp: restoredHp,
    max_hp: computedMaxHp,
    burning_started_at: null,
    last_hp_update: new Date().toISOString(),
  }).eq('id', mine_id);

  return res.json({ success: true, restoredHp, maxHp: computedMaxHp });
}

// ── Sell mine ─────────────────────────────────────────────────────────────────
function calcSellRefund(level) {
  let sum = 0;
  for (let i = 0; i < level; i++) sum += getMineUpgradeCost(i);
  return Math.floor(sum * 0.3);
}

async function handleSell(req, res) {
  const { telegram_id, mine_id } = req.body;
  if (!telegram_id || !mine_id) return res.status(400).json({ error: 'telegram_id and mine_id are required' });

  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id, 'id, coins');
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { data: mine, error: mineError } = await supabase
    .from('mines').select('id,owner_id,level,last_collected,lat,lng').eq('id', mine_id).maybeSingle();
  if (mineError) return res.status(500).json({ error: mineError.message });
  if (!mine) return res.status(404).json({ error: 'Mine not found' });
  if (mine.owner_id !== player.id) return res.status(403).json({ error: 'You do not own this mine' });

  const collected = calcAccumulatedCoins(mine.level, mine.last_collected);
  const refund = calcSellRefund(mine.level);
  const total = collected + refund;
  const newCoins = (player.coins ?? 0) + Math.round(total);

  const [{ data: coinsOk, error: playerUpdateError }, { error: deleteError }] = await Promise.all([
    supabase.from('players').update({ coins: newCoins }).eq('id', player.id).eq('coins', player.coins ?? 0).select('id').maybeSingle(),
    supabase.from('mines').delete().eq('id', mine_id),
  ]);

  if (playerUpdateError || deleteError) return res.status(500).json({ error: 'Failed to sell mine' });
  if (!coinsOk && !playerUpdateError) return res.status(409).json({ error: 'Конфликт — попробуйте снова' });

  return res.status(200).json({
    collected: Math.round(collected),
    refund: Math.round(refund),
    total: Math.round(total),
    player_coins: newCoins,
  });
}

// ── Router ────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body || {};
  if (action === 'finish')     return handleFinish(req, res);
  if (action === 'extinguish') return handleExtinguish(req, res);
  if (action === 'sell')       return handleSell(req, res);
  // Default: start attack
  return handleStart(req, res);
}
