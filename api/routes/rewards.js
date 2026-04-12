import { Router } from 'express';
import { supabase, getPlayerByTelegramId, parseTgId } from '../../lib/supabase.js';
import { generateItem, BOX_ODDS, rollWeighted, rollRandomType } from '../../lib/items.js';
import { randomCoreType } from '../../game/mechanics/cores.js';
import { gameState } from '../../lib/gameState.js';
import { LEVEL_REWARDS_MAP } from '../../config/levelRewards.js';
import { withPlayerLock } from '../../lib/playerLock.js';
import { persistNow } from '../../game/state/persist.js';

export const rewardsRouter = Router();

rewardsRouter.post('/', async (req, res) => {
  const { action, telegram_id } = req.body || {};

  let tgId;
  try { tgId = parseTgId(telegram_id); } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  return withPlayerLock(tgId, async () => {
    const player = gameState.getPlayerByTgId(tgId);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    if (action === 'get-level-rewards') return handleGetRewards(res, player, tgId);
    if (action === 'claim-reward')      return handleClaimReward(res, player, tgId, req.body);
    if (action === 'claim-all')         return handleClaimAll(res, player, tgId);
    return res.status(400).json({ error: 'Unknown action' });
  });
});

// ── get-level-rewards ──────────────────────────────────────────
async function handleGetRewards(res, player, tgId) {
  const { data: claimed } = await supabase
    .from('level_rewards_claimed')
    .select('level')
    .eq('player_id', tgId);

  const claimedSet = new Set((claimed || []).map(r => r.level));
  const playerLevel = player.level || 1;

  const rewards = [];
  let unclaimed_count = 0;
  for (let lv = 1; lv <= Math.min(playerLevel, 100); lv++) {
    const reward = LEVEL_REWARDS_MAP.get(lv);
    if (!reward) continue;
    const isClaimed = claimedSet.has(lv);
    if (!isClaimed) unclaimed_count++;
    rewards.push({ level: lv, reward, claimed: isClaimed });
  }

  // Find next locked reward (first level above player that has a reward)
  let next_reward = null;
  for (let lv = playerLevel + 1; lv <= 100; lv++) {
    const r = LEVEL_REWARDS_MAP.get(lv);
    if (r) { next_reward = { level: lv, reward: r }; break; }
  }

  return res.json({ success: true, rewards, unclaimed_count, next_reward });
}

// ── claim-reward ───────────────────────────────────────────────
async function handleClaimReward(res, player, tgId, body) {
  const level = Number(body.level);
  if (!level || level < 1 || level > 100) return res.status(400).json({ error: 'Invalid level' });
  if (level > (player.level || 1)) return res.status(400).json({ error: 'Level not reached' });

  const reward = LEVEL_REWARDS_MAP.get(level);
  if (!reward) return res.status(400).json({ error: 'No reward for this level' });

  // Claim FIRST (PK prevents duplicates), then grant rewards
  // This prevents race conditions from double-clicks
  const { error: claimErr } = await supabase
    .from('level_rewards_claimed')
    .insert({ player_id: tgId, level });
  if (claimErr) return res.status(400).json({ error: 'Already claimed' });

  const result = await grantReward(player, tgId, reward);

  return res.json({
    success: true,
    level,
    reward,
    granted: result,
    diamonds_total: player.diamonds,
    crystals_total: player.crystals,
    ether_total: player.ether,
  });
}

// ── claim-all ──────────────────────────────────────────────────
async function handleClaimAll(res, player, tgId) {
  const playerLevel = player.level || 1;

  const { data: claimed } = await supabase
    .from('level_rewards_claimed')
    .select('level')
    .eq('player_id', tgId);
  const claimedSet = new Set((claimed || []).map(r => r.level));

  const unclaimed = [];
  for (let lv = 1; lv <= Math.min(playerLevel, 100); lv++) {
    const reward = LEVEL_REWARDS_MAP.get(lv);
    if (reward && !claimedSet.has(lv)) unclaimed.push(lv);
  }

  if (!unclaimed.length) return res.json({ success: true, granted: null, message: 'Nothing to claim' });

  // Claim FIRST to prevent race conditions
  const claimRows = unclaimed.map(lv => ({ player_id: tgId, level: lv }));
  const { error: claimErr } = await supabase.from('level_rewards_claimed').insert(claimRows);
  if (claimErr) return res.status(400).json({ error: 'Already claimed (partial)' });

  const totals = { diamonds: 0, shards: 0, ether: 0, items: [], cores: [] };

  for (const lv of unclaimed) {
    const reward = LEVEL_REWARDS_MAP.get(lv);
    const result = await grantReward(player, tgId, reward);
    totals.diamonds += result.diamonds;
    totals.shards += result.shards;
    totals.ether += result.ether;
    totals.items.push(...result.items);
    totals.cores.push(...result.cores);
  }

  return res.json({
    success: true,
    claimed_levels: unclaimed,
    granted: totals,
    diamonds_total: player.diamonds,
    crystals_total: player.crystals,
    ether_total: player.ether,
  });
}

// ── Grant reward helper ────────────────────────────────────────
export async function grantReward(player, tgId, reward) {
  const result = { diamonds: 0, shards: 0, ether: 0, items: [], cores: [] };

  // Grant currencies — gameState is the source of truth (Iron Rule #2).
  // The 30s persist loop will write to DB; persistNow ensures crash safety (Iron Rule #11).
  // Caller must hold withPlayerLock so this read-modify-write is race-safe.
  const hasCurrency = (reward.diamonds > 0) || (reward.shards > 0) || (reward.ether > 0);
  if (hasCurrency) {
    if (reward.diamonds > 0) {
      player.diamonds = (player.diamonds || 0) + reward.diamonds;
      result.diamonds = reward.diamonds;
    }
    if (reward.shards > 0) {
      player.crystals = (player.crystals || 0) + reward.shards;
      result.shards = reward.shards;
    }
    if (reward.ether > 0) {
      player.ether = (player.ether || 0) + reward.ether;
      result.ether = reward.ether;
    }
    gameState.markDirty('players', player.id);
    await persistNow('players', {
      id: player.id,
      diamonds: player.diamonds,
      crystals: player.crystals,
      ether: player.ether,
    });
  }

  // Grant boxes → items
  for (const boxRarity of (reward.boxes || [])) {
    const odds = BOX_ODDS[boxRarity];
    if (!odds) continue;
    const itemRarity = rollWeighted(odds);
    const itemType = rollRandomType();
    const item = generateItem(itemType, itemRarity);

    // Skip if inventory full
    const { hasInventorySpace } = await import('../../game/mechanics/items.js');
    if (gameState.loaded && !hasInventorySpace(gameState, player.id)) continue;

    const insertData = {
      type: itemType, rarity: item.rarity, name: item.name, emoji: item.emoji,
      stat_value: item.stat_value, owner_id: player.id, equipped: false,
      attack: item.attack || 0, crit_chance: item.crit_chance || 0, defense: item.defense || 0,
      base_attack: item.base_attack || 0, base_crit_chance: item.base_crit_chance || 0,
      base_defense: item.base_defense || 0, block_chance: item.block_chance || 0, upgrade_level: 0, plus: 0,
    };
    const { data: newItem } = await supabase.from('items').insert(insertData).select().single();
    if (newItem) {
      if (gameState.loaded) gameState.upsertItem(newItem);
      result.items.push({
        id: newItem.id, type: itemType, rarity: item.rarity, name: item.name, emoji: item.emoji,
        attack: newItem.attack || 0, crit_chance: newItem.crit_chance || 0,
        defense: newItem.defense || 0, block_chance: newItem.block_chance || 0,
        plus: newItem.plus || 0, upgrade_level: newItem.upgrade_level || 0,
      });
    }
  }

  // Grant cores
  for (const coreDef of (reward.cores || [])) {
    const coreRow = {
      owner_id: Number(tgId),
      mine_cell_id: null,
      slot_index: null,
      core_type: randomCoreType(),
      level: coreDef.level || 0,
    };
    const { data: inserted } = await supabase.from('cores').insert(coreRow).select().single();
    if (inserted) {
      if (gameState.loaded) gameState.upsertCore(inserted);
      result.cores.push({ id: inserted.id, core_type: inserted.core_type, level: inserted.level });
    }
  }

  return result;
}
