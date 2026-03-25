import { Router } from 'express';
import { supabase, getPlayerByTelegramId, parseTgId, sendTelegramNotification } from '../../lib/supabase.js';
import { xpForLevel, SMALL_RADIUS, LARGE_RADIUS, calcHpRegen, getMineIncome, getMineCapacity, getMineHp, getMineHpRegen, calcMineHpRegen, ALLOWED_AVATARS } from '../../lib/formulas.js';
import { haversine } from '../../lib/haversine.js';
import { addXp } from '../../lib/xp.js';
import { gameState } from '../../lib/gameState.js';
import { ensureMarketNearPlayer } from '../../lib/markets.js';
import { io, connectedPlayers, lastAttackTime, recordAttack, logActivity } from '../../server.js';
import { validatePosition } from '../../lib/antispoof.js';
import { logPlayer } from '../../lib/logger.js';
import { ts, getLang } from '../../config/i18n.js';
import { getPlayerSkillEffects } from '../../config/skills.js';
import { getSniperFirstHit } from '../../game/mechanics/skills.js';
import { WEAPON_COOLDOWNS } from '../../config/constants.js';
import { BADGES, checkAndAwardBadges } from '../../config/badges.js';

export const playerRouter = Router();

const USERNAME_RE = /^[a-zA-Zа-яА-ЯёЁ0-9_]+$/;
const RENAME_COST_DIAMONDS = 50;

async function handleSetUsername(req, res) {
  const { telegram_id, username } = req.body || {};
  if (!telegram_id || !username)
    return res.status(400).json({ error: 'telegram_id and username are required' });
  const trimmed = username.trim();
  if (trimmed.length < 3 || trimmed.length > 16)
    return res.status(400).json({ error: 'Ник должен быть 3-16 символов' });
  if (!USERNAME_RE.test(trimmed))
    return res.status(400).json({ error: 'Только буквы, цифры и _' });
  const { player, error: findErr } = await getPlayerByTelegramId(telegram_id, 'id,game_username,username_changes,diamonds');
  if (findErr) return res.status(500).json({ error: findErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const { data: existing } = await supabase.from('players').select('id').ilike('game_username', trimmed).neq('id', player.id).maybeSingle();
  if (existing) return res.status(400).json({ error: 'Этот ник уже занят' });
  const changes = player.username_changes ?? 0;
  let newDiamonds = player.diamonds ?? 0;
  if (changes > 0) {
    if (newDiamonds < RENAME_COST_DIAMONDS)
      return res.status(400).json({ error: `Недостаточно алмазов (нужно ${RENAME_COST_DIAMONDS} 💎)` });
    newDiamonds -= RENAME_COST_DIAMONDS;
  }
  const updateObj = { game_username: trimmed, username_changes: changes + 1 };
  if (changes > 0) updateObj.diamonds = newDiamonds;
  const { error: updateErr } = await supabase.from('players').update(updateObj).eq('id', player.id);
  if (updateErr) return res.status(500).json({ error: updateErr.message });
  if (gameState.loaded) {
    const p = gameState.getPlayerById(player.id);
    if (p) {
      p.game_username = trimmed;
      p.username_changes = changes + 1;
      if (changes > 0) p.diamonds = newDiamonds;
      gameState.markDirty('players', p.id);
    }
  }
  return res.status(200).json({ success: true, game_username: trimmed, diamonds: newDiamonds, username_changes: changes + 1 });
}

async function handleSetLanguage(req, res) {
  const { telegram_id, language } = req.body || {};
  if (!telegram_id || !language) return res.status(400).json({ error: 'telegram_id and language required' });
  const lang = ['ru', 'en'].includes(language) ? language : 'en';
  const { player, error: findErr } = await getPlayerByTelegramId(telegram_id, 'id');
  if (findErr) return res.status(500).json({ error: findErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  await supabase.from('players').update({ language: lang }).eq('id', player.id);
  if (gameState.loaded) {
    const p = gameState.getPlayerById(player.id);
    if (p) { p.language = lang; gameState.markDirty('players', p.id); }
  }
  return res.json({ success: true, language: lang });
}

async function handleAvatar(req, res) {
  const { telegram_id, avatar } = req.body;
  if (!telegram_id || !avatar) return res.status(400).json({ error: 'telegram_id and avatar are required' });
  if (!ALLOWED_AVATARS.includes(avatar)) return res.status(400).json({ error: 'Invalid avatar' });
  const { player, error: findError } = await getPlayerByTelegramId(telegram_id);
  if (findError) return res.status(500).json({ error: findError });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const { data: updated, error: updateError } = await supabase.from('players').update({ avatar }).eq('id', player.id).select('id, telegram_id, username, avatar').single();
  if (updateError) return res.status(500).json({ error: updateError.message });
  // Update gameState so tick doesn't overwrite with old avatar
  if (gameState.loaded) {
    const p = gameState.getPlayerById(player.id);
    if (p) { p.avatar = avatar; gameState.markDirty('players', p.id); }
  }
  return res.status(200).json({ player: updated });
}

async function handleLocation(req, res) {
  const { telegram_id, lat, lng, pin_mode, pin_unpin } = req.body;
  if (!telegram_id || lat == null || lng == null) return res.status(400).json({ error: 'telegram_id, lat, lng are required' });
  const playerLat = parseFloat(lat), playerLng = parseFloat(lng);
  if (isNaN(playerLat) || isNaN(playerLng)) return res.status(400).json({ error: 'lat and lng must be numbers' });

  // Pin unpin — player returning from pin to GPS, reset position history to avoid false speed violation
  if (pin_unpin === true) {
    const { resetPositionHistory } = await import('../../lib/antispoof.js');
    if (resetPositionHistory) resetPositionHistory(telegram_id);
  }

  // GPS antispoof validation
  const isPinMode = pin_mode === true || pin_unpin === true;
  const validation = validatePosition(telegram_id, playerLat, playerLng, isPinMode);
  if (!validation.valid) {
    if (validation.reason === 'impossible_speed') {
      // Don't reveal detection — silently accept
      return res.json({ ok: true });
    }
    if (validation.reason === 'too_frequent') {
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id);
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player) return res.status(404).json({ error: 'Player not found' });
  const { error } = await supabase.from('players').update({ last_lat: playerLat, last_lng: playerLng, last_seen: new Date().toISOString() }).eq('id', player.id);
  if (error) return res.status(500).json({ error: 'Failed to update location' });
  return res.status(200).json({ ok: true });
}

function simulateBattle(attacker, defender, attackerWeapon, defenderWeapon) {
  const ROUNDS = 3;
  const rounds = [];
  let attackerHp = 1000 + (attacker.bonus_hp || 0);
  let defenderHp = 1000 + (defender.bonus_hp || 0);
  const attackerBonus = 1.2;
  for (let r = 0; r < ROUNDS; r++) {
    const roundResult = {};
    const atkBase = 10 + (attackerWeapon?.attack || 0);
    const atkCrit = attackerWeapon?.type === 'sword' ? (attackerWeapon.crit_chance || 0) : 0;
    const atkIsCrit = Math.random() * 100 < atkCrit;
    const atkDmg = Math.round(atkBase * (r === 0 ? attackerBonus : 1) * (atkIsCrit ? 2 : 1));
    defenderHp = Math.max(0, defenderHp - atkDmg);
    roundResult.attackerDmg = atkDmg; roundResult.attackerCrit = atkIsCrit; roundResult.defenderHpAfter = defenderHp;
    if (defenderHp <= 0) { rounds.push(roundResult); break; }
    const defBase = 10 + (defenderWeapon?.attack || 0);
    const defCrit = defenderWeapon?.type === 'sword' ? (defenderWeapon.crit_chance || 0) : 0;
    const defIsCrit = Math.random() * 100 < defCrit;
    const defDmg = Math.round(defBase * (defIsCrit ? 2 : 1));
    attackerHp = Math.max(0, attackerHp - defDmg);
    roundResult.defenderDmg = defDmg; roundResult.defenderCrit = defIsCrit; roundResult.attackerHpAfter = attackerHp;
    rounds.push(roundResult);
    if (attackerHp <= 0) break;
  }
  const winner = attackerHp > defenderHp ? 'attacker' : 'defender';
  return { rounds, winner, attackerHpLeft: attackerHp, defenderHpLeft: defenderHp };
}

async function handlePvpInitiate(req, res) {
  const { telegram_id, defender_telegram_id, lat, lng } = req.body || {};
  if (!telegram_id || !defender_telegram_id || lat == null || lng == null) return res.status(400).json({ error: 'Missing fields' });
  if (String(telegram_id) === String(defender_telegram_id)) return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.cant_attack_self') });
  const { player: attacker, error: aErr } = await getPlayerByTelegramId(telegram_id, 'id,telegram_id,game_username,avatar,level,xp,coins,bonus_attack,bonus_hp,bonus_crit,equipped_sword');
  if (aErr || !attacker) return res.status(404).json({ error: 'Attacker not found' });
  const { player: defender, error: dErr } = await getPlayerByTelegramId(defender_telegram_id, 'id,telegram_id,game_username,avatar,level,xp,coins,bonus_attack,bonus_hp,bonus_crit,equipped_sword,shield_until,last_lat,last_lng');
  if (dErr || !defender) return res.status(404).json({ error: 'Defender not found' });
  const pLat = parseFloat(lat), pLng = parseFloat(lng);
  const dist = haversine(pLat, pLng, defender.last_lat, defender.last_lng);
  const _pvpFx1 = getPlayerSkillEffects(gameState.getPlayerSkills(telegram_id));
  if (dist > LARGE_RADIUS + (_pvpFx1.attack_radius_bonus || 0)) return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.too_far_short'), distance: Math.round(dist) });
  if (defender.shield_until && new Date(defender.shield_until) > new Date()) return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.player_shielded'), shield_until: defender.shield_until });
  const [{ data: atkItems }, { data: defItems }] = await Promise.all([
    supabase.from('items').select('type,attack,crit_chance,emoji,rarity,name,defense').eq('owner_id', attacker.id).eq('equipped', true),
    supabase.from('items').select('type,attack,crit_chance,emoji,rarity,name,defense').eq('owner_id', defender.id).eq('equipped', true),
  ]);
  const atkWeapon = (atkItems || []).find(i => i.type === 'sword' || i.type === 'axe');
  const defWeapon = (defItems || []).find(i => i.type === 'sword' || i.type === 'axe');
  const atkShield = (atkItems || []).find(i => i.type === 'shield');
  const defShield = (defItems || []).find(i => i.type === 'shield');
  const battleResult = simulateBattle(attacker, defender, atkWeapon, defWeapon);
  const winnerIsAttacker = battleResult.winner === 'attacker';
  const loser = winnerIsAttacker ? defender : attacker;
  const winner = winnerIsAttacker ? attacker : defender;
  const _loserFx = getPlayerSkillEffects(gameState.getPlayerSkills(loser.telegram_id));
  const _winnerFx = getPlayerSkillEffects(gameState.getPlayerSkills(winner.telegram_id));
  const _lossRate = _loserFx.safe_pvp_loss ? 0.05 : 0.10;
  const coinsLost = Math.round((loser.coins || 0) * _lossRate);
  const coinsWon = Math.round(coinsLost * Math.min(0.5 + (_winnerFx.pvp_loot_bonus || 0), 0.75));
  const xpGain = 100 + (winner.level || 1) * 10;
  const [loserUpdate, winnerUpdate] = await Promise.all([
    supabase.from('players').update({ coins: Math.max(0, (loser.coins || 0) - coinsLost), shield_until: new Date(Date.now() + 2 * 60 * 1000).toISOString() }).eq('id', loser.id).eq('coins', loser.coins || 0),
    supabase.from('players').update({ coins: (winner.coins || 0) + coinsWon, last_fight_at: new Date().toISOString() }).eq('id', winner.id).eq('coins', winner.coins || 0),
  ]);
  let xpResult = null;
  try { xpResult = await addXp(winner.id, xpGain); } catch (_) {}
  await supabase.from('pvp_log').insert({ attacker_id: attacker.id, defender_id: defender.id, winner_id: winner.id, attacker_hp_left: battleResult.attackerHpLeft, defender_hp_left: battleResult.defenderHpLeft, rounds: battleResult.rounds, coins_transferred: coinsWon });
  const defLang = getLang(gameState, defender.telegram_id);
  const notifMsg = winnerIsAttacker
    ? ts(defLang, 'notif.pvp_defeated', { name: attacker.game_username || ts(defLang, 'misc.player'), coins: coinsLost })
    : ts(defLang, 'notif.pvp_defended', { name: attacker.game_username || ts(defLang, 'misc.player') });
  const battlePayload = {
    battle: battleResult,
    attacker: { telegram_id: attacker.telegram_id, username: attacker.game_username, avatar: attacker.avatar, level: attacker.level, weapon: atkWeapon ? { emoji: atkWeapon.emoji, type: atkWeapon.type, name: atkWeapon.name, rarity: atkWeapon.rarity, attack: atkWeapon.attack } : null, shield: atkShield ? { emoji: atkShield.emoji, name: atkShield.name, defense: atkShield.defense } : null, bonusHp: attacker.bonus_hp || 0 },
    defender: { telegram_id: defender.telegram_id, username: defender.game_username, avatar: defender.avatar, level: defender.level, weapon: defWeapon ? { emoji: defWeapon.emoji, type: defWeapon.type, name: defWeapon.name, rarity: defWeapon.rarity, attack: defWeapon.attack } : null, shield: defShield ? { emoji: defShield.emoji, name: defShield.name, defense: defShield.defense } : null, bonusHp: defender.bonus_hp || 0 },
    winner: battleResult.winner, coinsLost, coinsWon, xpGain,
  };
  await supabase.from('notifications').insert({ player_id: defender.id, type: 'pvp_battle', message: notifMsg, data: battlePayload });
  sendTelegramNotification(defender.telegram_id, notifMsg);
  await Promise.all([
    supabase.from('players').update({ kills: (winner.kills ?? 0) + 1 }).eq('id', winner.id),
    supabase.from('players').update({ deaths: (loser.deaths ?? 0) + 1 }).eq('id', loser.id),
  ]);

  // Update gameState
  if (gameState.loaded) {
    const gw = gameState.getPlayerById(winner.id);
    if (gw) {
      gw.coins = (winner.coins || 0) + coinsWon;
      gw.kills = (gw.kills ?? 0) + 1;
      gameState.markDirty('players', gw.id);
    }
    const gl = gameState.getPlayerById(loser.id);
    if (gl) {
      gl.coins = Math.max(0, (loser.coins || 0) - coinsLost);
      gl.deaths = (gl.deaths ?? 0) + 1;
      gl.shield_until = new Date(Date.now() + 1 * 60 * 1000).toISOString();
      gameState.markDirty('players', gl.id);
    }
  }

  return res.json({
    success: true, battle: battleResult,
    attacker: { telegram_id: attacker.telegram_id, username: attacker.game_username, avatar: attacker.avatar, level: attacker.level, weapon: atkWeapon ? { emoji: atkWeapon.emoji, type: atkWeapon.type, name: atkWeapon.name, rarity: atkWeapon.rarity, attack: atkWeapon.attack } : null, shield: atkShield ? { emoji: atkShield.emoji, name: atkShield.name, defense: atkShield.defense } : null, bonusHp: attacker.bonus_hp || 0 },
    defender: { telegram_id: defender.telegram_id, username: defender.game_username, avatar: defender.avatar, level: defender.level, weapon: defWeapon ? { emoji: defWeapon.emoji, type: defWeapon.type, name: defWeapon.name, rarity: defWeapon.rarity, attack: defWeapon.attack } : null, shield: defShield ? { emoji: defShield.emoji, name: defShield.name, defense: defShield.defense } : null, bonusHp: defender.bonus_hp || 0 },
    winner: battleResult.winner, coinsLost, coinsWon, xpGain, xp: xpResult,
  });
}

async function handlePvpFlee(req, res) {
  const { telegram_id, attacker_telegram_id } = req.body || {};
  if (!telegram_id || !attacker_telegram_id) return res.status(400).json({ error: 'Missing fields' });
  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id,coins');
  if (pErr || !player) return res.status(404).json({ error: 'Player not found' });
  const fleeCost = Math.round((player.coins || 0) * 0.03);
  const { error: upErr } = await supabase.from('players').update({ coins: Math.max(0, (player.coins || 0) - fleeCost) }).eq('id', player.id).eq('coins', player.coins || 0);
  if (upErr) return res.status(500).json({ error: 'Failed to flee' });
  return res.json({ success: true, fleeCost, coinsLeft: Math.max(0, (player.coins || 0) - fleeCost) });
}

// ─── Projectile PvP (single-hit) ─────────────────────────────────────

function emitToNearbyPlayers(lat, lng, radiusM, event, data) {
  for (const [sid, info] of connectedPlayers) {
    if (!info.lat || !info.lng) continue;
    const d = haversine(lat, lng, info.lat, info.lng);
    if (d <= radiusM) io.to(sid).emit(event, data);
  }
}

// WEAPON_COOLDOWNS imported from config/constants.js

async function handlePvpAttack(req, res) {
  const { telegram_id, target_telegram_id, lat, lng } = req.body || {};
  if (!telegram_id || !target_telegram_id || lat == null || lng == null)
    return res.status(400).json({ error: 'Missing fields' });
  if (String(telegram_id) === String(target_telegram_id))
    return res.status(400).json({ error: 'Нельзя атаковать себя' });

  // Look up attacker & defender in gameState
  const attacker = gameState.getPlayerByTgId(telegram_id);
  if (!attacker) return res.status(404).json({ error: 'Attacker not found' });
  const defender = gameState.getPlayerByTgId(target_telegram_id);
  if (!defender) return res.status(404).json({ error: 'Defender not found' });

  // Get equipped weapon from gameState items
  const attackerItems = gameState.getPlayerItems(attacker.id);
  const weapon = attackerItems.find(i => (i.type === 'sword' || i.type === 'axe') && i.equipped);

  // Rate limit by weapon cooldown (with skill speed bonus)
  const weaponType = weapon ? weapon.type : 'none';
  const _atkFx = getPlayerSkillEffects(gameState.getPlayerSkills(telegram_id));
  const cooldownMs = Math.max(100, Math.floor((WEAPON_COOLDOWNS[weaponType] ?? 0) * (1 - (_atkFx.attack_speed_bonus || 0))));
  const now = Date.now();
  const lastTime = lastAttackTime.get(String(telegram_id)) || 0;
  if (now - lastTime < cooldownMs)
    return res.status(429).json({ error: 'Cooldown', retry_after: cooldownMs - (now - lastTime) });
  recordAttack(telegram_id, now);

  // Distance check
  const pLat = parseFloat(lat), pLng = parseFloat(lng);
  const defLat = defender.last_lat, defLng = defender.last_lng;
  if (!defLat || !defLng) return res.status(400).json({ error: 'Defender position unknown' });
  const dist = haversine(pLat, pLng, defLat, defLng);
  if (dist > LARGE_RADIUS + (_atkFx.attack_radius_bonus || 0)) return res.status(400).json({ error: 'Слишком далеко', distance: Math.round(dist) });

  // Shield check
  if (defender.shield_until && new Date(defender.shield_until) > new Date())
    return res.status(400).json({ error: 'Игрок под защитой', shield_until: defender.shield_until });

  // Get defender's equipped shield
  const defenderItems = gameState.getPlayerItems(defender.id);
  const defShield = defenderItems.find(i => i.type === 'shield' && i.equipped);

  // 1. Shield block check
  let blocked = false;
  if (defShield?.block_chance && Math.random() * 100 < defShield.block_chance) {
    blocked = true;
  }

  let damage = 0, isCrit = false, isExecution = false;

  if (!blocked) {
    // 2. Base damage
    const baseDmg = 10 + (weapon?.attack || 0);
    const multiplier = 0.8 + Math.random() * 0.4;
    damage = Math.round(baseDmg * multiplier);
    // Skill weapon damage bonus
    if (_atkFx.weapon_damage_bonus) damage = Math.round(damage * (1 + _atkFx.weapon_damage_bonus));

    // Sniper ability — first hit on new target = forced crit
    const _sniperForced = _atkFx.sniper_ability && weapon?.type === 'sword' && getSniperFirstHit(Number(telegram_id), defender.id);

    // 3. Sword crit (crit_multiplier computed from upgrade_level + rarity)
    if (weapon?.type === 'sword') {
      const critChance = (weapon.crit_chance || 0) + (_atkFx.crit_chance_bonus || 0) * 100;
      if (_sniperForced || Math.random() * 100 < critChance) {
        const wLvl = weapon.upgrade_level || 0;
        let critMul = 1.5;
        if (weapon.rarity === 'mythic') critMul = 1.5 + (wLvl / 90) * 0.7;
        else if (weapon.rarity === 'legendary') critMul = 1.5 + (wLvl / 100) * 1.5;
        damage = Math.floor(damage * critMul);
        isCrit = true;
      }
    }

    // 4. Axe execution (target < 50% HP — computed from upgrade_level + rarity)
    if (weapon?.type === 'axe') {
      const wLvl = weapon.upgrade_level || 0;
      let execChance = 0;
      if (weapon.rarity === 'mythic') execChance = 7 + (wLvl / 90) * 10;
      else if (weapon.rarity === 'legendary') execChance = 13 + (wLvl / 100) * 7;
      if (execChance > 0) {
        const defMaxHpCheck = 1000 + (defender.bonus_hp || 0);
        const defHpCheck = defender.hp ?? defMaxHpCheck;
        if (defHpCheck < defMaxHpCheck * 0.5 && Math.random() * 100 < execChance) {
          damage = defHpCheck;
          isExecution = true;
        }
      }
    }

    // Lifesteal
    if (_atkFx.lifesteal > 0 && damage > 0 && !isExecution) {
      const healed = Math.floor(damage * _atkFx.lifesteal);
      if (healed > 0) {
        const atkMaxHp = 1000 + (attacker.bonus_hp || 0);
        attacker.hp = Math.min(atkMaxHp, (attacker.hp || atkMaxHp) + healed);
        gameState.markDirty('players', attacker.id);
      }
    }
  }

  // Apply HP regen to defender, then subtract damage
  const _defSkillFx = getPlayerSkillEffects(gameState.getPlayerSkills(target_telegram_id));
  const defMaxHp = Math.round((1000 + (defender.bonus_hp || 0)) * (1 + (_defSkillFx.player_hp_bonus || 0)));
  let defHp = defender.hp ?? defMaxHp;
  defHp = calcHpRegen(defHp, defMaxHp, defender.last_hp_regen);
  if (!blocked) defHp = Math.max(0, defHp - damage);

  // Update defender HP in gameState
  defender.hp = defHp;
  defender.last_hp_regen = new Date().toISOString();
  gameState.markDirty('players', defender.id);

  let killed = false;
  let coinsLost = 0, coinsWon = 0;

  if (defHp <= 0) {
    killed = true;
    // Transfer coins (skill: safe = 5%, default = 10%)
    const _dLossRate = _defSkillFx.safe_pvp_loss ? 0.05 : 0.10;
    coinsLost = Math.round((defender.coins || 0) * _dLossRate);
    coinsWon = Math.round(coinsLost * Math.min(0.5 + (_atkFx.pvp_loot_bonus || 0), 0.75));

    // Update defender
    defender.coins = Math.max(0, (defender.coins || 0) - coinsLost);
    defender.shield_until = new Date(now + 2 * 60 * 1000).toISOString();
    defender.hp = defMaxHp;
    defender.deaths = (defender.deaths ?? 0) + 1;
    gameState.markDirty('players', defender.id);

    // Update attacker
    attacker.coins = (attacker.coins || 0) + coinsWon;
    attacker.kills = (attacker.kills ?? 0) + 1;
    gameState.markDirty('players', attacker.id);

    // Critical writes to DB
    await Promise.all([
      supabase.from('players').update({
        coins: defender.coins, shield_until: defender.shield_until,
        hp: defMaxHp, deaths: defender.deaths, last_hp_regen: defender.last_hp_regen,
      }).eq('id', defender.id),
      supabase.from('players').update({
        coins: attacker.coins, kills: attacker.kills,
      }).eq('id', attacker.id),
      supabase.from('pvp_log').insert({
        attacker_id: attacker.id, defender_id: defender.id, winner_id: attacker.id,
        rounds: [{ damage, crit: isCrit }], coins_transferred: coinsWon,
      }),
    ]);

    // Notify defender
    const defKillLang = getLang(gameState, target_telegram_id);
    const killMsg = ts(defKillLang, 'notif.pvp_killed', { name: attacker.game_username || ts(defKillLang, 'misc.player'), coins: coinsLost });
    supabase.from('notifications').insert({
      player_id: defender.id, type: 'pvp_kill', message: killMsg,
      data: { attacker_id: attacker.id, damage, coins_lost: coinsLost },
    }).then(() => {}).catch(() => {});
    sendTelegramNotification(defender.telegram_id, killMsg);

    // XP for kill
    try { await addXp(attacker.id, 100 + (attacker.level || 1) * 10); } catch (_) {}

    logActivity(attacker.game_username, `убил ${defender.game_username}`);
    logPlayer(attacker.telegram_id, 'action', `Убил ${defender.game_username}`, { damage, coins_won: coinsWon, target_id: defender.telegram_id });
    logPlayer(defender.telegram_id, 'action', `Убит игроком ${attacker.game_username}`, { coins_lost: coinsLost, attacker_id: attacker.telegram_id });

    // Emit kill event to nearby
    emitToNearbyPlayers(pLat, pLng, 1000, 'pvp:kill', {
      winner_id: attacker.id, winner_tg: attacker.telegram_id, winner_name: attacker.game_username,
      loser_id: defender.id, loser_tg: defender.telegram_id, loser_name: defender.game_username,
      coins_transferred: coinsWon,
      shield_until: defender.shield_until,
    });
  }

  // Emit projectile to nearby sockets (1km)
  emitToNearbyPlayers(pLat, pLng, 1000, 'projectile', {
    from_lat: pLat, from_lng: pLng,
    to_lat: defLat, to_lng: defLng,
    damage, crit: isCrit,
    blocked, execution: isExecution,
    target_type: 'player',
    target_id: defender.telegram_id,
    attacker_id: attacker.telegram_id,
    weapon_type: weaponType === 'none' ? 'fist' : weaponType,
  });

  // Emit hit to defender's socket specifically
  for (const [sid, info] of connectedPlayers) {
    if (String(info.telegram_id) === String(target_telegram_id)) {
      io.to(sid).emit('pvp:hit', {
        attacker_id: attacker.telegram_id,
        attacker_name: attacker.game_username,
        damage, crit: isCrit,
        blocked, execution: isExecution,
        hp_left: defHp <= 0 ? defMaxHp : defHp,
        max_hp: defMaxHp,
        killed,
      });
      break;
    }
  }

  return res.json({
    success: true, damage, crit: isCrit,
    blocked, execution: isExecution,
    defender_hp: defHp <= 0 ? defMaxHp : defHp,
    defender_max_hp: defMaxHp,
    killed, coins_won: coinsWon, coins_lost: coinsLost,
  });
}

playerRouter.post('/init', async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { action } = req.body || {};
  if (action === 'avatar') return handleAvatar(req, res);
  if (action === 'location') return handleLocation(req, res);
  if (action === 'set-username') return handleSetUsername(req, res);
  if (action === 'set-language') return handleSetLanguage(req, res);
  if (action === 'pvp-initiate') return handlePvpInitiate(req, res);
  if (action === 'pvp-attack') return handlePvpAttack(req, res);
  if (action === 'pvp-flee') return handlePvpFlee(req, res);
  if (action === 'set-active-badge') return handleSetActiveBadge(req, res);
  if (action === 'pvp-reset') {
    const ADMIN_TG = 560013667;
    let tg; try { tg = parseTgId(req.body.telegram_id); } catch(_) {}
    if (tg !== ADMIN_TG) return res.status(403).json({ error: 'Admin only' });
    const [cd, sh] = await Promise.all([
      supabase.from('pvp_cooldowns').delete().gt('expires_at', '1900-01-01'),
      supabase.from('players').update({ shield_until: null }).not('shield_until', 'is', null),
    ]);
    return res.json({ success: true, cooldowns_deleted: !cd.error, shields_reset: !sh.error });
  }
  // Default: full player init
  const { telegram_id, username } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });
  const ADMIN_TG_ID = 560013667;
  let tgId;
  try { tgId = parseTgId(telegram_id); } catch (e) { return res.status(400).json({ error: e.message }); }
  // Maintenance mode check
  if (tgId !== ADMIN_TG_ID) {
    const { data: setting } = await supabase.from('app_settings').select('value').eq('key', 'maintenance_mode').single();
    if (setting?.value === 'true') return res.status(503).json({ maintenance: true });
  }
  const withTimeout = (promise) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 5000))]);
  let player;
  try {
    const { data, error: playerError } = await withTimeout(supabase.from('players').upsert({ telegram_id: tgId, username: username || null }, { onConflict: 'telegram_id', ignoreDuplicates: false }).select('id,telegram_id,username,game_username,username_changes,avatar,level,xp,hp,max_hp,bonus_attack,bonus_hp,bonus_crit,kills,deaths,diamonds,coins,equipped_sword,equipped_shield,respawn_until,starting_bonus_claimed,last_hp_regen,shield_until,clan_id,clan_role,daily_diamonds_claimed_at,last_lat,last_lng,last_seen,is_banned,active_badge,created_at').single());
    if (playerError) throw new Error(playerError.message);
    player = data;
  } catch (err) { return res.status(503).json({ error: 'DB unavailable', message: 'Сервер временно недоступен, попробуй через минуту' }); }
  // Ban check
  try {
    const { data: banData } = await supabase.from('players').select('is_banned,ban_reason,ban_until').eq('id', player.id).single();
    if (banData?.is_banned) {
      const bannedForever = !banData.ban_until;
      const bannedUntil = banData.ban_until ? new Date(banData.ban_until) : null;
      const stillBanned = bannedForever || bannedUntil > new Date();
      if (stillBanned) return res.status(403).json({ banned: true, reason: banData.ban_reason, until: banData.ban_until, avatar: player.avatar });
      else await supabase.from('players').update({ is_banned: false, ban_reason: null, ban_until: null }).eq('id', player.id);
    }
  } catch (_) {}
  let headquarters, mines, inventory, notifications;
  try {
    const [hqRes, minesRes, itemsRes, notifRes] = await withTimeout(Promise.all([
      supabase.from('headquarters').select('id,lat,lng,level,player_id,coins').eq('player_id', player.id).order('created_at', { ascending: true }).limit(1).maybeSingle(),
      supabase.from('mines').select('id,lat,lng,level,owner_id,cell_id,upgrade_finish_at,pending_level,last_collected,hp,max_hp,last_hp_update,status,burning_started_at,attacker_id,attack_ends_at').eq('owner_id', player.id),
      supabase.from('items').select('id,type,rarity,name,emoji,stat_value,attack,crit_chance,defense,block_chance,equipped,on_market,obtained_at,upgrade_level,base_attack,base_crit_chance,base_defense').eq('owner_id', player.id).order('obtained_at', { ascending: false }),
      supabase.from('notifications').select('id,type,message,data,created_at').eq('player_id', player.id).eq('read', false).order('created_at', { ascending: false }).limit(20),
    ]));
    headquarters = hqRes.data;
    mines = (minesRes.data || []).map(m => { const cMax = getMineHp(m.level); const rph = getMineHpRegen(m.level); const rawHp = Math.min(m.hp ?? cMax, cMax); return { ...m, max_hp: cMax, hp: calcMineHpRegen(rawHp, cMax, rph, m.last_hp_update), hp_regen: rph, income: getMineIncome(m.level), capacity: getMineCapacity(m.level) }; });
    inventory = itemsRes.data;
    notifications = notifRes.data;
  } catch (err) { return res.status(503).json({ error: 'DB unavailable', message: 'Сервер временно недоступен, попробуй через минуту' }); }
  const level = player.level ?? 1;
  const xp = player.xp ?? 0;
  const _initSkRow = gameState.loaded ? gameState.getPlayerSkills(tgId) : null;
  const _initSkFx = _initSkRow ? getPlayerSkillEffects(_initSkRow) : null;
  const maxHp = Math.round((1000 + (player.bonus_hp ?? 0)) * (1 + (_initSkFx?.player_hp_bonus || 0)));
  const attack = 10 + (player.bonus_attack ?? 0);
  let currentHp = player.hp ?? maxHp;
  let regenApplied = false;
  if (currentHp > maxHp) { currentHp = maxHp; regenApplied = true; }
  if (currentHp < maxHp) { const regenedHp = calcHpRegen(currentHp, maxHp, player.last_hp_regen); if (regenedHp !== currentHp) { currentHp = regenedHp; regenApplied = true; } }
  if (player.hp == null || player.max_hp !== maxHp || regenApplied) {
    const regenTs = new Date().toISOString();
    await supabase.from('players').update({ hp: currentHp, max_hp: maxHp, last_hp_regen: regenTs }).eq('id', player.id);
    player.last_hp_regen = regenTs;
  }
  // Sync player to gameState (merge to avoid overwriting fields not selected from DB)
  if (gameState.loaded) {
    const existing = gameState.getPlayerById(player.id);
    if (existing) {
      Object.assign(existing, player, { hp: currentHp, max_hp: maxHp });
      gameState.markDirty('players', existing.id);
    } else {
      gameState.upsertPlayer({ ...player, hp: currentHp, max_hp: maxHp });
    }
  }
  // Starting bonus: 1M coins + 50 diamonds on first login
  if (player.starting_bonus_claimed !== true) {
    const bonusCoins = 1_000_000;
    const bonusDiamonds = 50;
    const { data: bonusOk } = await supabase.from('players')
      .update({ starting_bonus_claimed: true, coins: (player.coins ?? 0) + bonusCoins, diamonds: (player.diamonds ?? 0) + bonusDiamonds })
      .eq('id', player.id).eq('starting_bonus_claimed', false).select('id').maybeSingle();
    if (bonusOk) {
      player.coins = (player.coins ?? 0) + bonusCoins;
      player.diamonds = (player.diamonds ?? 0) + bonusDiamonds;
      player.starting_bonus_claimed = true;
      if (gameState.loaded) {
        const p = gameState.getPlayerById(player.id);
        if (p) { p.coins = player.coins; p.diamonds = player.diamonds; p.starting_bonus_claimed = true; gameState.markDirty('players', p.id); }
      }
    }
  }
  // Check and award badges on login
  try {
    const newBadges = await checkAndAwardBadges(player, supabase);
    if (newBadges.length > 0) {
      for (const [sid, info] of connectedPlayers) {
        if (String(info.telegram_id) === String(tgId)) {
          for (const badge of newBadges) {
            io.to(sid).emit('badge:earned', { badge_id: badge.id, emoji: badge.emoji, name: badge.name, description: badge.description });
          }
          break;
        }
      }
    }
  } catch (_) {}
  const totalIncome = (mines || []).reduce((sum, m) => sum + getMineIncome(m.level), 0);
  const needUsername = !player.game_username;
  const unreadNotifs = notifications || [];
  if (unreadNotifs.length > 0) { supabase.from('notifications').update({ read: true }).in('id', unreadNotifs.map(n => n.id)).then(() => {}).catch(() => {}); }
  // Fire-and-forget: ensure market near player's HQ (or position)
  if (player.last_lat && player.last_lng) {
    ensureMarketNearPlayer(player.last_lat, player.last_lng, player.id).catch(() => {});
  }
  logActivity(player.game_username || player.username, 'вошёл в игру');
  logPlayer(tgId, 'login', 'Вошёл в игру');
  // Load player cores from gameState (instant, no DB query)
  const playerCores = gameState.loaded
    ? gameState.getPlayerCores(Number(tgId)).concat(gameState.getPlayerCores(player.id))
        .filter((c, i, arr) => arr.findIndex(x => x.id === c.id) === i)
        .map(c => ({ id: c.id, core_type: c.core_type, level: c.level, mine_cell_id: c.mine_cell_id || null, slot_index: c.slot_index ?? null }))
    : [];

  return res.status(200).json({
    needUsername,
    player: { ...player, level, xp, xpForNextLevel: xpForLevel(level), smallRadius: SMALL_RADIUS + (_initSkFx?.radius_bonus || 0), largeRadius: LARGE_RADIUS + (_initSkFx?.attack_radius_bonus || 0), hp: currentHp, max_hp: maxHp, attack, kills: player.kills ?? 0, deaths: player.deaths ?? 0, diamonds: player.diamonds ?? 0, bonus_attack: player.bonus_attack ?? 0, bonus_hp: player.bonus_hp ?? 0, coins: player.coins ?? 0, crystals: player.crystals ?? 0, language: player.language ?? 'ru', active_badge: player.active_badge || null },
    headquarters: headquarters || null,
    mines: mines || [],
    totalIncome,
    inventory: inventory || [],
    player_cores: playerCores,
    notifications: unreadNotifs,
    skill_effects: _initSkFx || {},
    player_skills: _initSkRow || { farmer: {}, raider: {}, skill_points_used: 0 },
  });
});

// ── Set active badge ──────────────────────────────────────────────
async function handleSetActiveBadge(req, res) {
  const { telegram_id, badge_id } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });
  let tgId; try { tgId = parseTgId(telegram_id); } catch (e) { return res.status(400).json({ error: e.message }); }
  // badge_id=null → clear active badge
  if (badge_id) {
    const { data: badge } = await supabase.from('player_badges').select('badge_id').eq('player_id', tgId).eq('badge_id', badge_id).maybeSingle();
    if (!badge) return res.status(403).json({ error: 'Бейдж не найден' });
  }
  await supabase.from('players').update({ active_badge: badge_id || null }).eq('telegram_id', tgId);
  if (gameState.loaded) {
    const p = gameState.getPlayerByTgId(tgId);
    if (p) { p.active_badge = badge_id || null; gameState.markDirty('players', p.id); }
  }
  return res.json({ ok: true, active_badge: badge_id || null });
}

// ── Player profile ────────────────────────────────────────────────
playerRouter.get('/profile', async (req, res) => {
  const { target_id } = req.query;
  if (!target_id) return res.status(400).json({ error: 'target_id required' });
  let tgId; try { tgId = parseTgId(target_id); } catch (e) { return res.status(400).json({ error: e.message }); }

  const target = gameState.loaded ? gameState.getPlayerByTgId(tgId) : null;
  if (!target) {
    const { player } = await getPlayerByTelegramId(tgId, 'id,telegram_id,game_username,avatar,level,xp,kills,deaths,clan_id,active_badge');
    if (!player) return res.status(404).json({ error: 'Игрок не найден' });
    return res.json({ profile: { telegram_id: tgId, game_username: player.game_username, avatar: player.avatar, level: player.level, xp: player.xp, active_badge: player.active_badge || null, kills: player.kills ?? 0, deaths: player.deaths ?? 0, clan_name: null, total_mines: 0, best_mine: null, equipped_items: [], badges: [], monuments_raided: 0 } });
  }

  // Mines
  const playerMines = gameState.getPlayerMines(target.id);
  const bestMine = playerMines.length ? playerMines.reduce((b, m) => m.level > b.level ? m : b) : null;

  // Equipped items
  const equippedItems = gameState.getPlayerItems(target.id).filter(i => i.equipped);

  // Badges
  const { data: badges } = await supabase.from('player_badges').select('badge_id,earned_at').eq('player_id', tgId).order('earned_at', { ascending: true });

  // Clan
  let clanName = null;
  if (target.clan_id) {
    const clan = gameState.getClanById(target.clan_id);
    if (clan) clanName = clan.name;
  }

  // Monument raids (count loot boxes)
  const { count: monumentsRaided } = await supabase.from('monument_loot_boxes').select('id', { count: 'exact', head: true }).eq('player_id', tgId);

  return res.json({
    profile: {
      telegram_id: target.telegram_id,
      game_username: target.game_username,
      avatar: target.avatar,
      level: target.level,
      xp: target.xp,
      hp: target.hp ?? 1000,
      max_hp: target.max_hp ?? 1000,
      active_badge: target.active_badge || null,
      clan_name: clanName,
      kills: target.kills ?? 0,
      deaths: target.deaths ?? 0,
      total_mines: playerMines.length,
      best_mine: bestMine ? { level: bestMine.level } : null,
      equipped_items: equippedItems.map(i => ({ type: i.type, rarity: i.rarity, emoji: i.emoji, upgrade_level: i.upgrade_level || 0 })),
      badges: badges || [],
      monuments_raided: monumentsRaided || 0,
    },
  });
});
