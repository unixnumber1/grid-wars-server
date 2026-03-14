import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { getCell, getCellCenter } from '../../lib/grid.js';
import { SMALL_RADIUS, calcAccumulatedCoins, getMineIncome } from '../../lib/formulas.js';
import { haversine } from '../../lib/haversine.js';
import { addXp, XP_REWARDS } from '../../lib/xp.js';
import { getClanLevel } from '../../lib/clans.js';

// ── Collect coins from all nearby mines ─────────────────────
async function handleCollect(req, res) {
  const { telegram_id, lat, lng } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });

  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id, 'id, coins, clan_id');
  if (playerError) return res.status(500).json({ error: typeof playerError === 'string' ? playerError : playerError?.message || 'DB error' });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { data: allMines, error: minesError } = await supabase
    .from('mines')
    .select('id, level, last_collected, cell_id, lat, lng, status')
    .eq('owner_id', player.id);
  if (minesError) return res.status(500).json({ error: 'Failed to fetch mines' });
  if (!allMines || allMines.length === 0) return res.status(200).json({ collected: 0, player_coins: player.coins ?? 0 });

  if (lat == null || lng == null) return res.status(400).json({ error: 'Координаты игрока не переданы' });
  const pLat = parseFloat(lat), pLng = parseFloat(lng);

  const mines = allMines.filter(m => {
    if (m.status === 'burning' || m.status === 'destroyed') return false;
    const mLat = m.lat != null ? m.lat : getCellCenter(m.cell_id)[0];
    const mLng = m.lng != null ? m.lng : getCellCenter(m.cell_id)[1];
    return haversine(pLat, pLng, mLat, mLng) <= SMALL_RADIUS;
  });
  if (mines.length === 0) return res.status(200).json({ collected: 0, player_coins: player.coins ?? 0 });

  const now = new Date().toISOString();

  // Clan income bonus
  let clanIncomeBonus = 0;
  let clanHqs = [];
  let boostMul = 1;
  if (player.clan_id) {
    const [{ data: clan }, { data: hqs }] = await Promise.all([
      supabase.from('clans').select('*').eq('id', player.clan_id).single(),
      supabase.from('clan_headquarters').select('lat,lng').eq('clan_id', player.clan_id),
    ]);
    if (clan) {
      const config = getClanLevel(clan.level);
      clanIncomeBonus = config.income;
      clanHqs = (hqs || []).map(h => ({ lat: h.lat, lng: h.lng, radius: config.radius }));
      if (clan.boost_expires_at && new Date(clan.boost_expires_at) > new Date()) {
        boostMul = clan.boost_multiplier || 1;
      }
    }
  }

  let totalCoins = 0;
  for (const mine of mines) {
    let acc = calcAccumulatedCoins(mine.level, mine.last_collected);
    if (clanIncomeBonus > 0 && clanHqs.length > 0) {
      const mLat = mine.lat ?? getCellCenter(mine.cell_id)[0];
      const mLng = mine.lng ?? getCellCenter(mine.cell_id)[1];
      const inZone = clanHqs.some(h => haversine(mLat, mLng, h.lat, h.lng) <= h.radius);
      if (inZone) {
        acc = Math.round(acc * (1 + clanIncomeBonus / 100));
        if (boostMul > 1) acc = Math.round(acc * boostMul);
      }
    }
    totalCoins += acc;
  }

  const currentCoins = player.coins ?? 0;
  const newCoins = currentCoins + Math.round(totalCoins);

  const [{ data: coinsOk, error: playerUpdateError }, { error: minesUpdateError }] = await Promise.all([
    supabase.from('players').update({ coins: newCoins }).eq('id', player.id).eq('coins', currentCoins).select('id').maybeSingle(),
    supabase.from('mines').update({ last_collected: now }).in('id', mines.map(m => m.id)),
  ]);
  if (playerUpdateError || minesUpdateError) return res.status(500).json({ error: 'Failed to collect coins' });
  if (!coinsOk && !playerUpdateError) return res.status(409).json({ error: 'Конфликт — попробуйте снова' });

  const collectedAmount = Math.round(totalCoins);
  const xpGained = collectedAmount > 0 ? Math.max(1, Math.floor(collectedAmount * 0.001)) : 0;
  let xpResult = null;
  if (xpGained > 0) { try { xpResult = await addXp(player.id, xpGained); } catch (e) {} }

  const totalIncome = clanIncomeBonus > 0 && clanHqs.length > 0
    ? allMines.reduce((sum, m) => {
        let inc = getMineIncome(m.level);
        const mLat = m.lat ?? getCellCenter(m.cell_id)[0];
        const mLng = m.lng ?? getCellCenter(m.cell_id)[1];
        if (clanHqs.some(h => haversine(mLat, mLng, h.lat, h.lng) <= h.radius)) {
          inc *= (1 + clanIncomeBonus / 100);
          if (boostMul > 1) inc *= boostMul;
        }
        return sum + inc;
      }, 0)
    : allMines.reduce((sum, m) => sum + getMineIncome(m.level), 0);

  return res.status(200).json({ collected: collectedAmount, total_accumulated: collectedAmount, player_coins: newCoins, xp: xpResult, totalIncome });
}

// ── Build a new mine ────────────────────────────────────────
async function handleBuild(req, res) {
  const { telegram_id } = req.body;
  const playerActualLat = parseFloat(req.body.player_lat ?? req.body.lat);
  const playerActualLng = parseFloat(req.body.player_lng ?? req.body.lng);
  const mineLat         = parseFloat(req.body.mine_lat  ?? req.body.lat);
  const mineLng         = parseFloat(req.body.mine_lng  ?? req.body.lng);

  if (!telegram_id || isNaN(mineLat) || isNaN(mineLng) || isNaN(playerActualLat) || isNaN(playerActualLng)) {
    return res.status(400).json({ error: 'telegram_id, player position and mine position are required' });
  }

  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id, 'id, level');
  if (playerError) return res.status(500).json({ error: playerError });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { data: hq, error: hqError } = await supabase
    .from('headquarters').select('id').eq('player_id', player.id).maybeSingle();
  if (hqError) return res.status(500).json({ error: hqError.message });
  if (!hq) return res.status(403).json({ error: 'You must place your headquarters first' });

  const targetCell = getCell(mineLat, mineLng);
  const [cellCenterLat, cellCenterLng] = getCellCenter(targetCell);

  const distance = haversine(playerActualLat, playerActualLng, cellCenterLat, cellCenterLng);
  if (distance > SMALL_RADIUS) {
    return res.status(400).json({ error: `Слишком далеко (${Math.round(distance)}м > ${SMALL_RADIUS}м)`, distance: Math.round(distance) });
  }

  const { data: existingMine } = await supabase.from('mines').select('id').eq('cell_id', targetCell).maybeSingle();
  const { data: existingHqOnCell } = await supabase.from('headquarters').select('id').eq('cell_id', targetCell).maybeSingle();

  if (existingMine) return res.status(409).json({ error: 'A mine already exists on this cell' });
  if (existingHqOnCell) return res.status(409).json({ error: 'Cell is occupied by a headquarters' });

  const { data: mine, error: insertError } = await supabase
    .from('mines')
    .insert({
      owner_id: player.id, original_builder_id: player.id,
      lat: cellCenterLat, lng: cellCenterLng, cell_id: targetCell,
      level: 0, hp: 0, max_hp: 0, last_collected: new Date().toISOString(),
    })
    .select('id,owner_id,lat,lng,cell_id,level,last_collected,upgrade_finish_at,pending_level,hp,max_hp')
    .single();

  if (insertError) return res.status(500).json({ error: insertError.message });

  let xpResult = null;
  try { xpResult = await addXp(player.id, XP_REWARDS.BUILD_MINE); } catch (e) {}

  return res.status(201).json({ mine, xp: xpResult });
}

// ── ROUTER ──────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body || {};
  if (action === 'collect') return handleCollect(req, res);
  return handleBuild(req, res);
}
