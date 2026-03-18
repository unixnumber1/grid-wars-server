import { Router } from 'express';
import { supabase } from '../../lib/supabase.js';
import { haversine } from '../../lib/haversine.js';
import { gameState } from '../../lib/gameState.js';
import { CORE_TYPES, MAX_CORE_SLOTS, getCoreMultiplier, getCoreUpgradeCost } from '../../lib/cores.js';
import { SMALL_RADIUS } from '../../lib/formulas.js';

export const coresRouter = Router();

coresRouter.post('/', async (req, res) => {
  const { action } = req.body || {};
  if (action === 'install')   return handleInstall(req, res);
  if (action === 'uninstall') return handleUninstall(req, res);
  if (action === 'upgrade')   return handleUpgrade(req, res);
  if (action === 'inventory') return handleInventory(req, res);
  return res.status(400).json({ error: 'Unknown action' });
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
  if (String(core.owner_id) !== String(player.telegram_id) && String(core.owner_id) !== String(player.id))
    return res.status(403).json({ error: 'Not your core' });
  if (core.mine_cell_id) return res.status(400).json({ error: 'Core already installed' });

  const mine = gameState.mines.get(mine_id);
  if (!mine) return res.status(404).json({ error: 'Mine not found' });
  if (mine.owner_id !== player.id) return res.status(403).json({ error: 'Not your mine' });

  // Distance check
  if (lat != null && lng != null) {
    const dist = haversine(parseFloat(lat), parseFloat(lng), mine.lat, mine.lng);
    if (dist > SMALL_RADIUS) return res.status(400).json({ error: 'Слишком далеко' });
  }

  // Check slot count
  const existing = gameState.getCoresForMine(mine.cell_id);
  if (existing.length >= MAX_CORE_SLOTS)
    return res.status(400).json({ error: 'Все слоты заняты (10/10)' });

  // Find next free slot
  const usedSlots = new Set(existing.map(c => c.slot_index));
  let slot = 0;
  while (usedSlots.has(slot)) slot++;

  core.mine_cell_id = mine.cell_id;
  core.slot_index = slot;
  gameState.markDirty('cores', core.id);

  await supabase.from('cores').update({ mine_cell_id: mine.cell_id, slot_index: slot }).eq('id', core.id);

  return res.json({ success: true, core, slot });
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
  if (String(core.owner_id) !== String(player.telegram_id) && String(core.owner_id) !== String(player.id))
    return res.status(403).json({ error: 'Not your core' });
  if (!core.mine_cell_id) return res.status(400).json({ error: 'Core not installed' });

  core.mine_cell_id = null;
  core.slot_index = null;
  gameState.markDirty('cores', core.id);

  await supabase.from('cores').update({ mine_cell_id: null, slot_index: null }).eq('id', core.id);

  return res.json({ success: true, core });
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
  if (String(core.owner_id) !== String(player.telegram_id) && String(core.owner_id) !== String(player.id))
    return res.status(403).json({ error: 'Not your core' });

  const cost = getCoreUpgradeCost(core.level);
  const playerEther = player.ether || 0;
  if (playerEther < cost)
    return res.status(400).json({ error: 'Недостаточно эфира', need: cost, have: playerEther });

  // Deduct ether
  player.ether = playerEther - cost;
  gameState.markDirty('players', player.id);
  await supabase.from('players').update({ ether: player.ether }).eq('id', player.id);

  // Level up core
  core.level = (core.level || 0) + 1;
  gameState.markDirty('cores', core.id);
  await supabase.from('cores').update({ level: core.level }).eq('id', core.id);

  return res.json({
    success: true,
    core,
    new_level: core.level,
    multiplier: getCoreMultiplier(core.level),
    ether_left: player.ether,
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
