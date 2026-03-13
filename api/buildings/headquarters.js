import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { getCellId } from '../../lib/grid.js';
import { hqUpgradeCost, HQ_MAX_LEVEL } from '../../lib/formulas.js';
import { addXp, XP_REWARDS } from '../../lib/xp.js';
import { gridDisk, cellToLatLng } from 'h3-js';

// ── PLACE HQ ───────────────────────────────────────────────────────────────
async function handlePlace(player, body, res) {
  const { lat, lng } = body;
  if (lat == null || lng == null) {
    return res.status(400).json({ error: 'lat, lng are required' });
  }

  const { data: existingHqs } = await supabase
    .from('headquarters').select('id').eq('player_id', player.id);
  if (existingHqs && existingHqs.length > 0) return res.status(409).json({ error: 'Headquarters already placed' });

  const targetCell = getCellId(parseFloat(lat), parseFloat(lng));

  // Find a free cell — start with targetCell, expand rings 1-5 if occupied
  let finalCell = null;

  const isCellFree = async (cell) => {
    const [hqRow, mineRow] = await Promise.all([
      supabase.from('headquarters').select('id').eq('cell_id', cell).maybeSingle(),
      supabase.from('mines').select('id').eq('cell_id', cell).maybeSingle(),
    ]);
    return !hqRow.data && !mineRow.data;
  };

  if (await isCellFree(targetCell)) {
    finalCell = targetCell;
  } else {
    for (let ring = 1; ring <= 5; ring++) {
      const candidates = gridDisk(targetCell, ring).filter(c => c !== targetCell);
      for (const candidate of candidates) {
        if (await isCellFree(candidate)) {
          finalCell = candidate;
          break;
        }
      }
      if (finalCell) break;
    }
  }

  if (!finalCell) {
    return res.status(400).json({ error: 'Нет свободных клеток рядом' });
  }

  const [centerLat, centerLng] = cellToLatLng(finalCell);
  const cell_id = finalCell;

  const bonusClaimed    = player.starting_bonus_claimed === true;
  const startingCoins   = bonusClaimed ? 0 : 100_000;
  const startingDiamonds = bonusClaimed ? 0 : 100;

  const { data: hq, error: insertError } = await supabase
    .from('headquarters')
    .insert({ player_id: player.id, owner_username: player.username, lat: centerLat, lng: centerLng, cell_id })
    .select('id,player_id,lat,lng,cell_id,level,created_at').single();
  if (insertError) {
    console.error('[headquarters] insert error:', insertError);
    return res.status(500).json({ error: 'Failed to place headquarters' });
  }

  if (!bonusClaimed) {
    const { data: bonusOk } = await supabase.from('players').update({
      starting_bonus_claimed: true,
      coins:    (player.coins    ?? 0) + startingCoins,
      diamonds: (player.diamonds ?? 0) + startingDiamonds,
    }).eq('id', player.id).eq('starting_bonus_claimed', false).select('id').maybeSingle();
    if (!bonusOk) return res.status(409).json({ error: 'Бонус уже получен' });
  }

  let xpResult = null;
  try { xpResult = await addXp(player.id, XP_REWARDS.BUILD_HQ); } catch (e) {}

  return res.status(201).json({
    headquarters: hq,
    xp: xpResult,
    startingBonus: !bonusClaimed,
    player_coins:    (player.coins    ?? 0) + startingCoins,
    player_diamonds: (player.diamonds ?? 0) + startingDiamonds,
  });
}

// ── UPGRADE HQ ─────────────────────────────────────────────────────────────
async function handleUpgrade(player, res) {
  const { data: hq, error: hqError } = await supabase
    .from('headquarters').select('id,level').eq('player_id', player.id).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (hqError) return res.status(500).json({ error: hqError.message });
  if (!hq)     return res.status(404).json({ error: 'Headquarters not found' });

  const currentLevel = hq.level ?? 1;
  if (currentLevel >= HQ_MAX_LEVEL) return res.status(400).json({ error: 'Headquarters is already at max level' });

  const cost = hqUpgradeCost(currentLevel);
  const balance = player.coins ?? 0;
  if (balance < cost) return res.status(400).json({ error: `Не хватает монет (нужно ${Math.round(cost).toLocaleString()})` });

  const newBalance = balance - cost;
  const [{ data: updatedHq, error: updateError }, { data: coinsOk, error: coinsError }] = await Promise.all([
    supabase.from('headquarters').update({ level: currentLevel + 1 })
      .eq('id', hq.id).select('id,player_id,lat,lng,cell_id,level,created_at').single(),
    supabase.from('players').update({ coins: newBalance }).eq('id', player.id).eq('coins', balance).select('id').maybeSingle(),
  ]);
  if (updateError || coinsError) return res.status(500).json({ error: 'Failed to upgrade headquarters' });
  if (!coinsOk && !coinsError) return res.status(409).json({ error: 'Конфликт — попробуйте снова' });

  let xpResult = null;
  try { xpResult = await addXp(player.id, XP_REWARDS.UPGRADE_HQ); } catch (e) {}

  return res.status(200).json({
    headquarters: updatedHq,
    player_coins: newBalance,
    xp: xpResult,
  });
}

// ── SELL HQ ────────────────────────────────────────────────────────────────
async function handleSell(player, res) {
  const { data: hqs, error: hqError } = await supabase
    .from('headquarters').select('id').eq('player_id', player.id);
  if (hqError) return res.status(500).json({ error: hqError.message });
  if (!hqs || hqs.length === 0) return res.status(404).json({ error: 'Headquarters not found' });

  // Delete all HQs for this player (handles duplicates)
  const { error: delError } = await supabase.from('headquarters').delete().eq('player_id', player.id);
  if (delError) return res.status(500).json({ error: delError.message });
  return res.status(200).json({ success: true });
}

// ── ROUTER ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telegram_id, action } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });

  const { player, error: playerError } = await getPlayerByTelegramId(telegram_id, 'id, username, starting_bonus_claimed, coins, diamonds');
  if (playerError) return res.status(500).json({ error: playerError?.message || 'DB error' });
  if (!player)     return res.status(404).json({ error: 'Player not found' });

  if (action === 'upgrade') return handleUpgrade(player, res);
  if (action === 'sell')    return handleSell(player, res);
  return handlePlace(player, req.body, res);
}
