import { Router } from 'express';
import { supabase } from '../../lib/supabase.js';
import { haversine } from '../../lib/haversine.js';
import { gameState } from '../../lib/gameState.js';
import { CORE_TYPES, MAX_CORE_SLOTS, getUnlockedSlots, getCoreMultiplier, getCoreUpgradeCost, getCoresTotalBoost } from '../../lib/cores.js';
import { SMALL_RADIUS, getMineIncome, calcAccumulatedCoins } from '../../lib/formulas.js';
import { ts, getLang } from '../../config/i18n.js';
import { getPlayerSkillEffects } from '../../config/skills.js';
import { withPlayerLock } from '../../lib/playerLock.js';

export const coresRouter = Router();

// Snapshot accumulated coins into mine.coins before core boost changes
function snapshotMineCoins(mine, cellId) {
  if (!mine || mine.status === 'burning' || mine.status === 'destroyed') return;
  if (!mine.last_collected || mine.level <= 0) return;
  const boosts = getMineBoosts(cellId);
  const accumulated = calcAccumulatedCoins(mine.level, mine.last_collected, boosts.income, boosts.capacity);
  if (accumulated > 0) mine.coins = (mine.coins || 0) + accumulated;
  mine.last_collected = new Date().toISOString();
  gameState.markDirty('mines', mine.id);
}

function getMineBoosts(cellId) {
  const cores = gameState.getCoresForMine(cellId);
  return {
    income: getCoresTotalBoost(cores, 'income'),
    capacity: getCoresTotalBoost(cores, 'capacity'),
    hp: getCoresTotalBoost(cores, 'hp'),
    regen: getCoresTotalBoost(cores, 'regen'),
  };
}

coresRouter.post('/', async (req, res) => {
  const { action, telegram_id } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });
  return withPlayerLock(telegram_id, async () => {
    if (action === 'install')   return handleInstall(req, res);
    if (action === 'uninstall') return handleUninstall(req, res);
    if (action === 'upgrade')   return handleUpgrade(req, res);
    if (action === 'sell')      return handleSell(req, res);
    if (action === 'mass-sell') return handleMassSell(req, res);
    if (action === 'inventory') return handleInventory(req, res);
    return res.status(400).json({ error: 'Unknown action' });
  });
});

// ── install: put a core into a mine slot ──
async function handleInstall(req, res) {
  const { telegram_id, core_id, mine_id, lat, lng } = req.body || {};
  if (!telegram_id || !core_id || !mine_id)
    return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const core = gameState.cores.get(core_id);
  if (!core) return res.status(404).json({ error: 'Core not found' });
  if (parseInt(core.owner_id, 10) !== parseInt(player.telegram_id, 10) || !parseInt(core.owner_id, 10))
    return res.status(403).json({ error: 'Not your core' });
  const lang = getLang(gameState, telegram_id);
  if (core.mine_cell_id) return res.status(400).json({ error: ts(lang, 'err.core_installed') });
  if (core.on_market) return res.status(400).json({ error: 'Core is listed on market' });

  const mine = gameState.mines.get(mine_id);
  if (!mine) return res.status(404).json({ error: 'Mine not found' });
  if (mine.owner_id !== player.id) return res.status(403).json({ error: 'Not your mine' });

  // Distance check — use server-side position
  const gsCore = gameState.getPlayerByTgId(Number(telegram_id));
  if (gsCore?.last_lat && gsCore?.last_lng) {
    const dist = haversine(gsCore.last_lat, gsCore.last_lng, mine.lat, mine.lng);
    const _crFx = getPlayerSkillEffects(gameState.getPlayerSkills(telegram_id));
    if (dist > SMALL_RADIUS + (_crFx.radius_bonus || 0)) return res.status(400).json({ error: ts(lang, 'err.too_far_short') });
  }

  // Check slot count (slots unlock every 20 mine levels)
  const existing = gameState.getCoresForMine(mine.cell_id);
  const maxSlots = getUnlockedSlots(mine.level);
  if (existing.length >= maxSlots)
    return res.status(400).json({ error: ts(lang, 'err.all_slots_full'), slots: existing.length, max_slots: maxSlots });

  // Find next free slot
  const usedSlots = new Set(existing.map(c => c.slot_index));
  let slot = 0;
  while (usedSlots.has(slot)) slot++;

  // Snapshot accumulated coins before boost changes
  snapshotMineCoins(mine, mine.cell_id);

  // Add to index AFTER mutating (old mine_cell_id was null, so no removal needed)
  core.mine_cell_id = mine.cell_id;
  core.slot_index = slot;
  gameState._updateCoreIndex(core, false);
  gameState.markDirty('cores', core.id);

  await supabase.from('cores').update({ mine_cell_id: mine.cell_id, slot_index: slot }).eq('id', core.id);

  return res.json({ success: true, core, slot, mine_id: mine.id, mine_cell_id: mine.cell_id, mine_boosts: getMineBoosts(mine.cell_id), snapshot_coins: mine.coins || 0, snapshot_last_collected: mine.last_collected });
}

// ── uninstall: remove core from mine back to inventory ──
async function handleUninstall(req, res) {
  const { telegram_id, core_id } = req.body || {};
  if (!telegram_id || !core_id)
    return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const core = gameState.cores.get(core_id);
  if (!core) return res.status(404).json({ error: 'Core not found' });
  if (parseInt(core.owner_id, 10) !== parseInt(player.telegram_id, 10) || !parseInt(core.owner_id, 10))
    return res.status(403).json({ error: 'Not your core' });
  if (!core.mine_cell_id) return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.core_not_installed') });

  const oldCellId = core.mine_cell_id;
  const mineObj = [...gameState.mines.values()].find(m => m.cell_id === oldCellId);

  // Snapshot accumulated coins before boost changes
  if (mineObj) snapshotMineCoins(mineObj, oldCellId);

  // Remove from index BEFORE mutating (same object reference in gameState.cores)
  gameState._updateCoreIndex(core, true);
  core.mine_cell_id = null;
  core.slot_index = null;
  gameState.markDirty('cores', core.id);

  await supabase.from('cores').update({ mine_cell_id: null, slot_index: null }).eq('id', core.id);

  return res.json({ success: true, core, mine_id: mineObj?.id, mine_cell_id: oldCellId, mine_boosts: getMineBoosts(oldCellId), snapshot_coins: mineObj?.coins || 0, snapshot_last_collected: mineObj?.last_collected });
}

// ── upgrade: level up a core for ether ──
async function handleUpgrade(req, res) {
  const { telegram_id, core_id } = req.body || {};
  if (!telegram_id || !core_id)
    return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const core = gameState.cores.get(core_id);
  if (!core) return res.status(404).json({ error: 'Core not found' });
  if (parseInt(core.owner_id, 10) !== parseInt(player.telegram_id, 10) || !parseInt(core.owner_id, 10))
    return res.status(403).json({ error: 'Not your core' });

  if (core.on_market) return res.status(400).json({ error: 'Core is listed on market' });

  // Distance check if core is installed in a mine
  if (core.mine_cell_id) {
    const mine = [...gameState.mines.values()].find(m => m.cell_id === core.mine_cell_id);
    if (mine && player.last_lat && player.last_lng) {
      const dist = haversine(player.last_lat, player.last_lng, mine.lat, mine.lng);
      const _fx = getPlayerSkillEffects(gameState.getPlayerSkills(telegram_id));
      if (dist > SMALL_RADIUS + (_fx.radius_bonus || 0))
        return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.too_far_short') });
    }
  }

  const cost = getCoreUpgradeCost(core.level);
  const { data: freshE } = await supabase.from('players').select('ether').eq('id', player.id).single();
  const playerEther = freshE?.ether ?? player.ether ?? 0;
  if (playerEther < cost)
    return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.not_enough_ether'), need: cost, have: playerEther });

  // Deduct ether (optimistic lock)
  const newEther = playerEther - cost;
  const { data: etherOk } = await supabase.from('players').update({ ether: newEther }).eq('id', player.id).eq('ether', playerEther).select('id').maybeSingle();
  if (!etherOk) return res.status(409).json({ error: 'Ether changed, retry' });
  player.ether = newEther;
  gameState.markDirty('players', player.id);

  // Snapshot accumulated coins before boost changes
  if (core.mine_cell_id) {
    const upgMine = [...gameState.mines.values()].find(m => m.cell_id === core.mine_cell_id);
    if (upgMine) snapshotMineCoins(upgMine, core.mine_cell_id);
  }

  // Level up core
  core.level = (core.level || 0) + 1;
  gameState.markDirty('cores', core.id);
  await supabase.from('cores').update({ level: core.level }).eq('id', core.id);

  const upgradeBoosts = core.mine_cell_id ? getMineBoosts(core.mine_cell_id) : null;
  const upgMineObj = core.mine_cell_id ? [...gameState.mines.values()].find(m => m.cell_id === core.mine_cell_id) : null;
  return res.json({
    success: true,
    core,
    new_level: core.level,
    multiplier: getCoreMultiplier(core.level),
    ether_left: player.ether,
    ...(upgradeBoosts && { mine_id: upgMineObj?.id, mine_cell_id: core.mine_cell_id, mine_boosts: upgradeBoosts, snapshot_coins: upgMineObj?.coins || 0, snapshot_last_collected: upgMineObj?.last_collected }),
  });
}

// ── sell: sell core for ether (10% of invested resources) ──
async function handleSell(req, res) {
  const { telegram_id, core_id } = req.body || {};
  if (!telegram_id || !core_id)
    return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const core = gameState.cores.get(core_id);
  if (!core) return res.status(404).json({ error: 'Core not found' });
  if (parseInt(core.owner_id, 10) !== parseInt(player.telegram_id, 10) || !parseInt(core.owner_id, 10))
    return res.status(403).json({ error: 'Not your core' });
  if (core.mine_cell_id)
    return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.uninstall_core_first') });
  if (core.on_market) return res.status(400).json({ error: 'Core is listed on market' });

  // Calculate sell price: lv0 = 10 ether, otherwise 10% of invested ether
  let sellPrice = 10;
  if (core.level > 0) {
    let invested = 0;
    for (let i = 0; i < core.level; i++) invested += getCoreUpgradeCost(i);
    sellPrice = Math.max(10, Math.floor(invested * 0.1));
  }

  // Remove core (with ownership guard in DB)
  gameState.cores.delete(core_id);
  await supabase.from('cores').delete().eq('id', core_id).eq('owner_id', Number(player.telegram_id));

  // Grant ether (fresh read for accuracy)
  const { data: freshE } = await supabase.from('players').select('ether').eq('id', player.id).single();
  const newEther = (freshE?.ether ?? 0) + sellPrice;
  player.ether = newEther;
  gameState.markDirty('players', player.id);
  await supabase.from('players').update({ ether: newEther }).eq('id', player.id);

  return res.json({ success: true, sell_price: sellPrice, ether: player.ether });
}

// ── mass-sell: sell multiple cores at once ──
async function handleMassSell(req, res) {
  const { telegram_id, core_ids } = req.body || {};
  if (!telegram_id || !core_ids?.length)
    return res.status(400).json({ error: 'Missing fields' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  let totalEther = 0;
  const soldIds = [];

  for (const coreId of core_ids) {
    const core = gameState.cores.get(coreId);
    if (!core) continue;
    if (parseInt(core.owner_id, 10) !== parseInt(player.telegram_id, 10) || !parseInt(core.owner_id, 10)) continue;
    if (core.mine_cell_id) continue;
    if (core.on_market) continue;

    let sellPrice = 10;
    if (core.level > 0) {
      let invested = 0;
      for (let i = 0; i < core.level; i++) invested += getCoreUpgradeCost(i);
      sellPrice = Math.max(10, Math.floor(invested * 0.1));
    }

    totalEther += sellPrice;
    soldIds.push(coreId);
    gameState.cores.delete(coreId);
  }

  if (!soldIds.length)
    return res.status(400).json({ error: ts(getLang(gameState, telegram_id), 'err.no_cores_available') });

  player.ether = (player.ether || 0) + totalEther;
  gameState.markDirty('players', player.id);

  await supabase.from('cores').delete().in('id', soldIds).eq('owner_id', Number(player.telegram_id));
  const { data: freshE } = await supabase.from('players').select('ether').eq('id', player.id).single();
  const newEther = (freshE?.ether ?? 0) + totalEther;
  player.ether = newEther;
  await supabase.from('players').update({ ether: newEther }).eq('id', player.id);

  return res.json({
    success: true,
    sold_count: soldIds.length,
    ether_gained: totalEther,
    ether_total: player.ether,
  });
}

// ── inventory: list all cores owned by player ──
async function handleInventory(req, res) {
  const { telegram_id } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  const player = gameState.getPlayerByTgId(telegram_id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const allCores = gameState.getPlayerCores(player.telegram_id)
    .concat(gameState.getPlayerCores(player.id));

  // Deduplicate by id
  const seen = new Set();
  const cores = [];
  for (const c of allCores) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    cores.push({
      ...c,
      multiplier: getCoreMultiplier(c.level),
      upgrade_cost: getCoreUpgradeCost(c.level),
      type_info: CORE_TYPES[c.core_type],
    });
  }

  return res.json({ cores });
}
