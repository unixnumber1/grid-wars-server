import { Router } from 'express';
import { supabase, getPlayerByTelegramId } from '../lib/supabase.js';
import { rateLimitMw } from '../lib/rateLimit.js';
import { haversine } from '../lib/haversine.js';
import { gameState } from '../lib/gameState.js';
import { io, connectedPlayers, lastAttackTime, logActivity } from '../server.js';
import { ORE_CAPTURE_RADIUS, getOreHp } from '../lib/oreNodes.js';
import { calcHpRegen, LARGE_RADIUS } from '../lib/formulas.js';
import { addXp } from '../lib/xp.js';

export const oreRouter = Router();

const WEAPON_COOLDOWNS = { sword: 500, axe: 700, none: 200 };

function emitToNearby(lat, lng, radiusM, event, data) {
  for (const [sid, info] of connectedPlayers) {
    if (!info.lat || !info.lng) continue;
    if (haversine(lat, lng, info.lat, info.lng) <= radiusM) io.to(sid).emit(event, data);
  }
}

oreRouter.post('/', rateLimitMw('attack'), async (req, res) => {
  const { action, telegram_id } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  if (action === 'capture') {
    const { ore_node_id, lat, lng, currency } = req.body;
    if (!ore_node_id) return res.status(400).json({ error: 'ore_node_id required' });

    const player = gameState.getPlayerByTgId(telegram_id);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const ore = gameState.oreNodes.get(ore_node_id);
    if (!ore) return res.status(404).json({ error: 'Ore node not found' });

    const pLat = parseFloat(lat), pLng = parseFloat(lng);
    const dist = haversine(pLat, pLng, ore.lat, ore.lng);
    if (dist > ORE_CAPTURE_RADIUS) return res.status(400).json({ error: 'Подойди ближе (200м)' });

    if (ore.owner_id && ore.owner_id !== player.id && String(ore.owner_id) !== String(player.telegram_id)) {
      const ONLINE_MS = 3 * 60 * 1000;
      const ownerPlayer = gameState.getPlayerById(ore.owner_id) || gameState.getPlayerByTgId(ore.owner_id);
      const ownerOnline = ownerPlayer?.last_seen ? (Date.now() - new Date(ownerPlayer.last_seen).getTime()) < ONLINE_MS : false;
      return res.status(400).json({
        error: 'Рудник занят',
        owner_id: ownerPlayer?.id,
        owner_tg: ownerPlayer?.telegram_id,
        owner_name: ownerPlayer?.game_username || ownerPlayer?.username,
        owner_online: ownerOnline,
      });
    }

    // Capture with currency choice (shards or ether)
    const selectedCurrency = (currency === 'ether') ? 'ether' : 'shards';
    ore.owner_id = player.id;
    ore.last_collected = new Date().toISOString();
    ore.currency = selectedCurrency;
    gameState.markDirty('oreNodes', ore.id);

    await supabase.from('ore_nodes').update({
      owner_id: player.id,
      last_collected: ore.last_collected,
      currency: selectedCurrency,
    }).eq('id', ore.id);

    logActivity(player.game_username, `захватил рудник (${selectedCurrency})`);

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
    if (ore.owner_id !== player.id) return res.status(403).json({ error: 'Не ваш рудник' });

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
    if (ore.owner_id !== player.id) return res.status(403).json({ error: 'Не ваш рудник' });

    ore.owner_id = null;
    gameState.markDirty('oreNodes', ore.id);
    await supabase.from('ore_nodes').update({ owner_id: null }).eq('id', ore.id);

    return res.json({ success: true });
  }

  if (action === 'hit') {
    // Attack ore node (when owner is offline)
    const { ore_node_id, lat, lng } = req.body;
    if (!ore_node_id) return res.status(400).json({ error: 'ore_node_id required' });

    const player = gameState.getPlayerByTgId(telegram_id);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const ore = gameState.oreNodes.get(ore_node_id);
    if (!ore) return res.status(404).json({ error: 'Ore node not found' });
    if (!ore.owner_id || ore.owner_id === player.id) return res.status(400).json({ error: 'Нельзя атаковать' });

    const pLat = parseFloat(lat), pLng = parseFloat(lng);
    const dist = haversine(pLat, pLng, ore.lat, ore.lng);
    if (dist > LARGE_RADIUS) return res.status(400).json({ error: 'Слишком далеко' });

    // Rate limit by weapon CD
    const items = gameState.getPlayerItems(player.id);
    const weapon = items.find(i => (i.type === 'sword' || i.type === 'axe') && i.equipped);
    const weaponType = weapon ? weapon.type : 'none';
    const cdMs = WEAPON_COOLDOWNS[weaponType] || 500;
    const now = Date.now();
    const last = lastAttackTime.get(String(telegram_id)) || 0;
    if (now - last < cdMs) return res.status(429).json({ error: 'Cooldown' });
    lastAttackTime.set(String(telegram_id), now);

    // Calculate damage
    const baseDmg = 10 + (weapon?.attack || 0);
    const multiplier = 0.8 + Math.random() * 0.4;
    let damage = Math.round(baseDmg * multiplier);
    let isCrit = false;
    let isExecution = false;

    // Sword crit
    if (weapon?.type === 'sword') {
      const critChance = weapon.crit_chance || 0;
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
      const oreHpNow = ore.hp || ore.max_hp;
      if (execChance > 0 && oreHpNow < ore.max_hp * 0.5 && Math.random() * 100 < execChance) {
        damage = oreHpNow;
        isExecution = true;
      }
    }

    ore.hp = Math.max(0, (ore.hp || ore.max_hp) - damage);
    let captured = false;

    if (ore.hp <= 0) {
      // Ore captured by attacker
      captured = true;
      const oldOwnerId = ore.owner_id;
      ore.owner_id = player.id;
      ore.hp = ore.max_hp;
      ore.last_collected = new Date().toISOString();
      gameState.markDirty('oreNodes', ore.id);
      await supabase.from('ore_nodes').update({ owner_id: player.id, hp: ore.max_hp, last_collected: ore.last_collected }).eq('id', ore.id);

      // Notify old owner
      if (oldOwnerId) {
        const oldOwner = gameState.getPlayerById(oldOwnerId);
        if (oldOwner) {
          const notif = {
            id: globalThis.crypto.randomUUID(),
            player_id: oldOwnerId,
            type: 'ore_captured',
            message: `⛏️ Ваш рудник Ур.${ore.level} захвачен ${player.game_username || 'игроком'}!`,
            read: false, created_at: new Date().toISOString(),
          };
          gameState.addNotification(notif);
          supabase.from('notifications').insert(notif).then(() => {}).catch(() => {});
        }
      }

      emitToNearby(ore.lat, ore.lng, 1000, 'ore:captured', {
        ore_node_id: ore.id, new_owner: player.id,
        new_owner_name: player.game_username || player.username,
      });
    } else {
      gameState.markDirty('oreNodes', ore.id);
    }

    // Emit projectile
    emitToNearby(pLat, pLng, 1000, 'projectile', {
      from_lat: pLat, from_lng: pLng,
      to_lat: ore.lat, to_lng: ore.lng,
      damage, crit: isCrit, execution: isExecution,
      target_type: 'ore',
      target_id: ore.id,
      attacker_id: player.telegram_id,
      weapon_type: weaponType === 'none' ? 'fist' : weaponType,
    });

    emitToNearby(ore.lat, ore.lng, 1000, 'ore:hp_update', {
      ore_node_id: ore.id, hp: ore.hp, max_hp: ore.max_hp,
    });

    return res.json({ success: true, damage, crit: isCrit, hp: ore.hp, max_hp: ore.max_hp, captured });
  }

  return res.status(400).json({ error: 'Unknown action' });
});
