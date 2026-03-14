import { supabase, getPlayerByTelegramId, rateLimit } from '../lib/supabase.js';
import { GOBLIN, getGoblinEmoji } from '../lib/goblins.js';
import { haversine } from '../lib/haversine.js';
import { addXp } from '../lib/xp.js';
import { LARGE_RADIUS } from '../lib/formulas.js';

// ── ATTACK GOBLIN ────────────────────────────────────────────
async function handleAttack(req, res) {
  const { telegram_id, bot_id, lat, lng } = req.body || {};
  if (!telegram_id || !bot_id) return res.status(400).json({ error: 'Missing fields' });
  if (!rateLimit(telegram_id, 30)) return res.status(429).json({ error: 'Too many requests' });

  const { player, error: pErr } = await getPlayerByTelegramId(
    telegram_id, 'id,hp,max_hp,bonus_attack,bonus_crit,equipped_sword,diamonds,kills,respawn_until'
  );
  if (pErr || !player) return res.status(404).json({ error: 'Player not found' });

  // Respawn check
  if (player.respawn_until && new Date(player.respawn_until) > new Date()) {
    return res.status(400).json({ error: 'Respawn cooldown' });
  }

  const { data: bot } = await supabase.from('bots').select('*').eq('id', bot_id).eq('status', 'alive').maybeSingle();
  if (!bot) return res.status(404).json({ error: 'Goblin not found' });

  if (lat != null && lng != null) {
    const dist = haversine(parseFloat(lat), parseFloat(lng), bot.lat, bot.lng);
    if (dist > LARGE_RADIUS) return res.status(400).json({ error: 'Too far' });
  }

  // Player damage
  const { data: weapon } = await supabase.from('items')
    .select('type,attack,crit_chance').eq('owner_id', player.id).eq('equipped', true)
    .in('type', ['sword', 'axe']).maybeSingle();

  const baseAtk = 10 + (player.bonus_attack || 0);
  const weaponAtk = weapon?.attack || 0;
  const critChance = weapon?.type === 'sword' ? (weapon.crit_chance || 0) : 0;
  const isCrit = Math.random() * 100 < critChance;
  let damage = Math.round((baseAtk + weaponAtk) * (0.8 + Math.random() * 0.4));
  if (isCrit) damage = Math.round(damage * 2);

  const newBotHp = Math.max(0, (bot.hp || GOBLIN.baseHp) - damage);
  const botDefeated = newBotHp <= 0;

  // Bot counter-attack
  let counterDamage = 0;
  let playerHp = player.hp || 100;
  let playerDied = false;

  if (!botDefeated && Math.random() < 0.3) {
    counterDamage = Math.round(GOBLIN.baseAttack * (0.8 + Math.random() * 0.4));
    playerHp = Math.max(0, playerHp - counterDamage);
    if (playerHp <= 0) {
      playerDied = true;
      playerHp = Math.round((player.max_hp || 100) * 0.3);
      await supabase.from('players').update({
        hp: playerHp, respawn_until: new Date(Date.now() + 10000).toISOString(),
      }).eq('id', player.id);
    } else {
      await supabase.from('players').update({ hp: playerHp }).eq('id', player.id);
    }
  }

  const result = {
    damage, isCrit, botDefeated, counterDamage, playerDied,
    playerHp, playerMaxHp: player.max_hp || 100,
    botHp: newBotHp, botMaxHp: bot.max_hp || GOBLIN.baseHp,
  };

  if (botDefeated) {
    // Award XP + diamonds
    const diamonds = Math.floor(Math.random() * (GOBLIN.dropDiamonds[1] - GOBLIN.dropDiamonds[0] + 1)) + GOBLIN.dropDiamonds[0];
    const xpResult = await addXp(player.id, GOBLIN.xpReward).catch(() => null);

    await Promise.all([
      supabase.from('bots').delete().eq('id', bot.id),
      supabase.from('players').update({
        diamonds: (player.diamonds || 0) + diamonds,
        kills: (player.kills || 0) + 1,
      }).eq('id', player.id),
    ]);

    result.reward = { diamonds, xp: GOBLIN.xpReward };
    result.xp = xpResult;

    // Drop stolen coins if fleeing
    if (bot.state === 'fleeing' && (bot.stolen_coins || 0) > 0) {
      const dropCoins = Math.floor(bot.stolen_coins * 0.5);
      result.reward.coinsDropped = dropCoins;
      // Add coins directly to killer
      await supabase.from('players').update({
        coins: supabase.rpc ? undefined : undefined, // handled below
      }).eq('id', player.id);
      // Simple: just give coins to player
      const { data: p } = await supabase.from('players').select('coins').eq('id', player.id).single();
      if (p) await supabase.from('players').update({ coins: (p.coins || 0) + dropCoins }).eq('id', player.id);
    }
  } else {
    await supabase.from('bots').update({ hp: newBotHp }).eq('id', bot.id);
  }

  return res.json(result);
}

// ── ROUTER ───────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { action } = req.body || {};
  if (action === 'attack') return handleAttack(req, res);
  return res.status(400).json({ error: 'Unknown action' });
}
