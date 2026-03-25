import { supabase } from '../../lib/supabase.js';
import { gameState } from './GameState.js';

const PERSIST_INTERVAL = 30_000; // 30 seconds

let _running = false;

export function startPersistLoop() {
  if (_running) return;
  _running = true;
  console.log('[persist] Starting batch persist loop, interval:', PERSIST_INTERVAL, 'ms');

  setInterval(async () => {
    try {
      await batchPersist();
    } catch (e) {
      console.error('[persist] batch error:', e.message);
    }
  }, PERSIST_INTERVAL);
}

async function batchPersist() {
  const dirty = gameState.getDirtyAndClear();
  const keys = Object.keys(dirty);
  if (keys.length === 0) return;

  let totalWritten = 0;

  const tableMap = {
    players: 'players',
    headquarters: 'headquarters',
    mines: 'mines',
    bots: 'bots',
    vases: 'vases',
    items: 'items',
    markets: 'markets',
    marketListings: 'market_listings',
    couriers: 'couriers',
    courierDrops: 'courier_drops',
    notifications: 'notifications',
    clans: 'clans',
    clanMembers: 'clan_members',
    clanHqs: 'clan_headquarters',
    oreNodes: 'ore_nodes',
    collectors: 'collectors',
    fireTrucks: 'fire_trucks',
    monuments: 'monuments',
    cores: 'cores',
    zombieHordes: 'zombie_hordes',
    // zombies: positions are temporary, persisted on create/death only
  };

  const stateMap = {
    players: gameState.players,
    headquarters: gameState.headquarters,
    mines: gameState.mines,
    bots: gameState.bots,
    vases: gameState.vases,
    items: gameState.items,
    markets: gameState.markets,
    marketListings: gameState.marketListings,
    couriers: gameState.couriers,
    courierDrops: gameState.courierDrops,
    notifications: gameState.notifications,
    clans: gameState.clans,
    clanMembers: gameState.clanMembers,
    clanHqs: gameState.clanHqs,
    oreNodes: gameState.oreNodes,
    collectors: gameState.collectors,
    fireTrucks: gameState.fireTrucks,
    monuments: gameState.monuments,
    cores: gameState.cores,
    zombieHordes: gameState.zombieHordes,
  };

  for (const key of keys) {
    const table = tableMap[key];
    const map = stateMap[key];
    if (!table || !map) continue;

    const ids = dirty[key];
    const rows = [];
    for (const id of ids) {
      const obj = map.get(id);
      if (!obj) continue;
      // Skip rows with null NOT-NULL columns to avoid infinite retry
      if (key === 'clanHqs' && !obj.clan_id) continue;
      if ((key === 'mines' || key === 'players') && !obj.created_at) continue;
      // Safety: never send items without upgrade_level (prevents reset to 0)
      if (key === 'items' && obj.upgrade_level == null) obj.upgrade_level = 0;
      // Strip runtime-only fields (prefixed with _) that don't exist in DB
      const clean = {};
      for (const k of Object.keys(obj)) {
        if (!k.startsWith('_')) clean[k] = obj[k];
      }
      // Strip leaked runtime fields from monuments
      if (key === 'monuments') {
        delete clean.wave_started_at;
        delete clean.wave_shield_hp;
      }
      // Items: ensure integer columns are integers (not floats)
      if (key === 'items') {
        for (const f of ['attack', 'crit_chance', 'defense', 'block_chance']) {
          if (typeof clean[f] === 'number') clean[f] = Math.floor(clean[f]);
        }
      }
      rows.push(clean);
    }
    if (rows.length === 0) continue;

    try {
      const { error } = await supabase.from(table).upsert(rows, { onConflict: 'id' });
      if (error) {
        console.error(`[persist] ${table} upsert error:`, error.message);
        // Re-mark as dirty for retry
        for (const id of ids) gameState.markDirty(key, id);
      } else {
        totalWritten += rows.length;
      }
    } catch (e) {
      console.error(`[persist] ${table} error:`, e.message);
      for (const id of ids) gameState.markDirty(key, id);
    }
  }

  if (totalWritten > 0) {
    console.log(`[persist] batch: ${totalWritten} objects written to DB`);
  }
}

// Immediate persist for critical operations (money, PvP, etc.)
export async function persistNow(table, data) {
  try {
    const { error } = await supabase.from(table).upsert(data, { onConflict: 'id' });
    if (error) console.error(`[persist:now] ${table} error:`, error.message);
    return !error;
  } catch (e) {
    console.error(`[persist:now] ${table} error:`, e.message);
    return false;
  }
}

// Immediate insert
export async function insertNow(table, data) {
  try {
    const { data: result, error } = await supabase.from(table).insert(data).select();
    if (error) console.error(`[persist:insert] ${table} error:`, error.message);
    return { data: result, error };
  } catch (e) {
    console.error(`[persist:insert] ${table} error:`, e.message);
    return { data: null, error: e };
  }
}

// Immediate delete
export async function deleteNow(table, column, value) {
  try {
    const { error } = await supabase.from(table).delete().eq(column, value);
    if (error) console.error(`[persist:delete] ${table} error:`, error.message);
    return !error;
  } catch (e) {
    console.error(`[persist:delete] ${table} error:`, e.message);
    return false;
  }
}
