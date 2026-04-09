import { Router } from 'express';
import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { haversine } from '../../lib/haversine.js';
import { logPlayer } from '../../lib/logger.js';
import { gameState } from '../../lib/gameState.js';
import { io, connectedPlayers, lastAttackTime, recordAttack, getAttackCooldown, logActivity } from '../../server.js';
import { ORE_CAPTURE_RADIUS, getOreHp } from '../../lib/oreNodes.js';
import { calcHpRegen, LARGE_RADIUS, distanceMultiplier } from '../../lib/formulas.js';
import { addXp } from '../../lib/xp.js';
import { ts, getLang } from '../../config/i18n.js';
import { getPlayerSkillEffects, isInShadow } from '../../config/skills.js';
import { WEAPON_COOLDOWNS, ORE_TYPES } from '../../config/constants.js';
import { withPlayerLock } from '../../lib/playerLock.js';
import { awardContestTickets, CONTEST_RULES } from '../../game/mechanics/contest.js';

export const oreRouter = Router();
const _oreClaimCooldown = new Map();
const ORE_CLAIM_CD_MS = 5000; // 5s cooldown — prevents spam but doesn't block gameplay

function emitToNearby(lat, lng, radiusM, event, data) {
  for (const [sid, info] of connectedPlayers) {
    if (!info.lat || !info.lng) continue;
    if (haversine(lat, lng, info.lat, info.lng) <= radiusM) io.to(sid).emit(event, data);
  }
}

oreRouter.post('/', async (req, res) => {
  const { action, telegram_id } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });
  return withPlayerLock(telegram_id, async () => {

  // ── Claim: capture a broken ore node (hp <= 0, no owner) ──
  if (action === 'claim') {
    const { ore_node_id, lat, lng, currency } = req.body;
    if (!ore_node_id) return res.status(400).json({ error: 'ore_node_id required' });

    // Claim cooldown
    const lastClaim = _oreClaimCooldown.get(String(telegram_id)) || 0;
    if (Date.now() - lastClaim < ORE_CLAIM_CD_MS)
      return res.status(429).json({ error: 'Подожди перед следующим захватом' });

    const player = gameState.getPlayerByTgId(telegram_id);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const ore = gameState.oreNodes.get(ore_node_id);
    if (!ore) return res.status(404).json({ error: 'Ore node not found' });

    const lang = getLang(gameState, telegram_id);
    if (ore.owner_id) return res.status(400).json({ error: ts(lang, 'err.ore_occupied') });
    if ((ore.hp ?? ore.max_hp) > 0) return res.status(400).json({ error: ts(lang, 'err.ore_not_broken') });

    if (!player.last_lat || !player.last_lng) return res.status(400).json({ error: 'Position unknown' });
    const dist = haversine(player.last_lat, player.last_lng, ore.lat, ore.lng);
    if (dist > ORE_CAPTURE_RADIUS) return res.status(400).json({ error: ts(lang, 'err.too_far_closer', { radius: ORE_CAPTURE_RADIUS }) });

    // Dual currency types always produce both — currency choice only for single-currency types
    const oreTypeCfg = ORE_TYPES[ore.ore_type] || ORE_TYPES.hill;
    const selectedCurrency = oreTypeCfg.dualCurrency ? 'both' : ((currency === 'ether') ? 'ether' : 'shards');

    ore.owner_id = player.id;
    ore.hp = ore.max_hp;
    ore.last_collected = new Date().toISOString();
    ore.currency = selectedCurrency;
    ore._claimed_at = new Date().toISOString(); // runtime-only: for eruption tracking
    gameState.markDirty('oreNodes', ore.id);

    await supabase.from('ore_nodes').update({
      owner_id: player.id, hp: ore.max_hp,
      last_collected: ore.last_collected, currency: selectedCurrency,
    }).eq('id', ore.id);

    _oreClaimCooldown.set(String(telegram_id), Date.now());
    logActivity(player.game_username, `захватил рудник ${oreTypeCfg.emoji} Ур.${ore.level}`);
    logPlayer(telegram_id, 'action', `Захватил рудник ${oreTypeCfg.emoji} Ур.${ore.level}`);

    emitToNearby(ore.lat, ore.lng, 1000, 'ore:captured', {
      ore_node_id: ore.id, new_owner: player.id,
      new_owner_name: player.game_username || player.username,
    });

    return res.json({ success: true, ore_node: ore });
  }

  if (action === 'switch-currency') {
    const { ore_node_id, currency } = req.body;
    if (!ore_node_id) return res.status(400).json({ error: 'ore_node_id required' });

    const player = gameState.getPlayerByTgId(telegram_id);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const ore = gameState.oreNodes.get(ore_node_id);
    if (!ore) return res.status(404).json({ error: 'Ore node not found' });
    if (ore.owner_id !== player.id) return res.status(403).json({ error: ts(getLang(gameState, telegram_id), 'err.not_your_ore') });

    // Dual currency types cannot switch — they always produce both
    const oreTypeCfg = ORE_TYPES[ore.ore_type] || ORE_TYPES.hill;
    if (oreTypeCfg.dualCurrency) return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.ore_dual_currency') });

    const selectedCurrency = (currency === 'ether') ? 'ether' : 'shards';
    ore.currency = selectedCurrency;
    gameState.markDirty('oreNodes', ore.id);
    await supabase.from('ore_nodes').update({ currency: selectedCurrency }).eq('id', ore.id);

    return res.json({ success: true, currency: selectedCurrency });
  }

  if (action === 'release') {
    const { ore_node_id } = req.body;
    const player = gameState.getPlayerByTgId(telegram_id);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const ore = gameState.oreNodes.get(ore_node_id);
    if (!ore) return res.status(404).json({ error: 'Ore node not found' });
    if (ore.owner_id !== player.id) return res.status(403).json({ error: ts(getLang(gameState, telegram_id), 'err.not_your_ore') });

    ore.owner_id = null;
    delete ore._claimed_at;
    gameState.markDirty('oreNodes', ore.id);
    await supabase.from('ore_nodes').update({ owner_id: null }).eq('id', ore.id);

    return res.json({ success: true });
  }

  if (action === 'hit') {
    // Attack any ore node (owned by others OR unowned)
    const { ore_node_id, lat, lng } = req.body;
    if (!ore_node_id) return res.status(400).json({ error: 'ore_node_id required' });

    const player = gameState.getPlayerByTgId(telegram_id);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const ore = gameState.oreNodes.get(ore_node_id);
    if (!ore) return res.status(404).json({ error: 'Ore node not found' });
    const hitLang = getLang(gameState, telegram_id);

    // Cannot attack own ore
    if (ore.owner_id === player.id) return res.status(400).json({ error: ts(hitLang, 'err.ore_cant_attack') });
    // Cannot attack already broken ore
    if ((ore.hp || 0) <= 0) return res.status(400).json({ error: ts(hitLang, 'err.ore_already_broken') });

    const _oSkFx = getPlayerSkillEffects(gameState.getPlayerSkills(telegram_id));
    if (!player.last_lat || !player.last_lng) return res.status(400).json({ error: 'Position unknown' });
    const dist = haversine(player.last_lat, player.last_lng, ore.lat, ore.lng);
    if (dist > LARGE_RADIUS + (_oSkFx.attack_radius_bonus || 0)) return res.status(400).json({ error: ts(hitLang, 'err.too_far_short') });

    // Rate limit by weapon CD (centralized: weapon + skill speed bonus)
    const cooldownMs = getAttackCooldown(telegram_id);
    const now = Date.now();
    const last = lastAttackTime.get(String(telegram_id)) || 0;
    if (now - last < cooldownMs) return res.status(429).json({ error: 'Cooldown' });
    recordAttack(telegram_id, now);

    const items = gameState.getPlayerItems(player.id);
    const weapon = items.find(i => (i.type === 'sword' || i.type === 'axe') && i.equipped);
    const weaponType = weapon ? weapon.type : 'none';

    // Calculate damage
    const baseDmg = 10 + (weapon?.attack || 0);
    const multiplier = distanceMultiplier(dist, LARGE_RADIUS);
    let damage = Math.round(baseDmg * multiplier);
    if (_oSkFx.weapon_damage_bonus) damage = Math.round(damage * (1 + _oSkFx.weapon_damage_bonus));
    if (_oSkFx.pve_damage_bonus) damage = Math.round(damage * (1 + _oSkFx.pve_damage_bonus));
    let isCrit = false;
    let isExecution = false;

    // Sword crit
    if (weapon?.type === 'sword') {
      const critChance = (weapon.crit_chance || 0) + (_oSkFx.crit_chance_bonus || 0) * 100;
      if (Math.random() * 100 < critChance) {
        const wLvl = weapon.upgrade_level || 0;
        let critMul = 1.5;
        if (weapon.rarity === 'mythic') critMul = 1.5 + (wLvl / 90) * 0.7;
        else if (weapon.rarity === 'legendary') critMul = 1.5 + (wLvl / 100) * 1.5;
        damage = Math.floor(damage * critMul);
        isCrit = true;
      }
    }

    // Axe execution on ore < 50% HP
    if (weapon?.type === 'axe') {
      const wLvl = weapon.upgrade_level || 0;
      let execChance = 0;
      if (weapon.rarity === 'mythic') execChance = 7 + (wLvl / 90) * 10;
      else if (weapon.rarity === 'legendary') execChance = 13 + (wLvl / 100) * 7;
      const oreHpNow = ore.hp ?? ore.max_hp;
      if (execChance > 0 && oreHpNow < ore.max_hp * 0.5 && Math.random() * 100 < execChance) {
        damage = oreHpNow;
        isExecution = true;
      }
    }

    ore.hp = Math.max(0, (ore.hp ?? ore.max_hp) - damage);
    let broken = false;

    if (ore.hp <= 0) {
      // Ore is broken — reset owner, DO NOT auto-capture
      broken = true;
      const oldOwnerId = ore.owner_id;
      ore.owner_id = null;
      ore.hp = 0;
      delete ore._claimed_at;
      gameState.markDirty('oreNodes', ore.id);
      await supabase.from('ore_nodes').update({ owner_id: null, hp: 0 }).eq('id', ore.id);

      // Notify old owner
      if (oldOwnerId) {
        const oldOwner = gameState.getPlayerById(oldOwnerId);
        if (oldOwner) {
          const oldOwnerLang = oldOwner.language || 'en';
          const oreTypeCfg = ORE_TYPES[ore.ore_type] || ORE_TYPES.hill;
          const notif = {
            id: globalThis.crypto.randomUUID(),
            player_id: oldOwnerId,
            type: 'ore_captured',
            message: ts(oldOwnerLang, 'notif.ore_broken', { level: ore.level, emoji: oreTypeCfg.emoji, name: isInShadow(player) ? '???' : (player.game_username || 'player') }),
            read: false, created_at: new Date().toISOString(),
          };
          gameState.addNotification(notif);
          supabase.from('notifications').insert(notif).then(() => {}).catch(e => console.error('[ore] DB error:', e.message));
        }
      }

      // Contest: ticket for PvP-breaking another player's ore node
      if (oldOwnerId && oldOwnerId !== player.id) {
        awardContestTickets(player.telegram_id, 'ore_capture', CONTEST_RULES.oreCaptureTickets, {
          ore_id: ore.id, ore_type: ore.ore_type, ore_level: ore.level, prev_owner_id: oldOwnerId,
        }).catch(() => {});
      }

      const _oreShadow = isInShadow(player);
      emitToNearby(ore.lat, ore.lng, 1000, 'ore:broken', {
        ore_node_id: ore.id,
        broken_by: _oreShadow ? 0 : player.id,
        broken_by_name: _oreShadow ? '???' : (player.game_username || player.username),
      });
    } else {
      gameState.markDirty('oreNodes', ore.id);
    }

    // Emit projectile
    emitToNearby(player.last_lat, player.last_lng, 1000, 'projectile', {
      from_lat: player.last_lat, from_lng: player.last_lng,
      to_lat: ore.lat, to_lng: ore.lng,
      damage, crit: isCrit, execution: isExecution,
      target_type: 'ore',
      target_id: ore.id,
      attacker_id: isInShadow(player) ? 0 : player.telegram_id,
      weapon_type: weaponType === 'none' ? 'fist' : weaponType,
    });

    emitToNearby(ore.lat, ore.lng, 1000, 'ore:hp_update', {
      ore_node_id: ore.id, hp: ore.hp, max_hp: ore.max_hp,
    });

    return res.json({ success: true, damage, crit: isCrit, hp: ore.hp, max_hp: ore.max_hp, broken, effective_cd: cooldownMs });
  }

  return res.status(400).json({ error: 'Unknown action' });
  }); // withPlayerLock
});
