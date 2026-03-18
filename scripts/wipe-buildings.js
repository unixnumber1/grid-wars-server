import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../lib/supabase.js';
import { getMineUpgradeCost } from '../lib/formulas.js';

function getMineUpgradeCostTotal(level) {
  let total = 0;
  for (let i = 1; i <= level; i++) {
    total += getMineUpgradeCost(i);
  }
  return total;
}

async function wipeBuildings() {
  console.log('=== WIPE BUILDINGS WITH COMPENSATION ===');

  // 1. Compensation for mines
  const { data: mines } = await supabase.from('mines').select('owner_id, level');
  const coinCompensation = new Map();

  for (const mine of mines || []) {
    const cost = getMineUpgradeCostTotal(mine.level);
    const current = coinCompensation.get(mine.owner_id) || 0;
    coinCompensation.set(mine.owner_id, current + cost);
  }
  console.log(`Mines: ${(mines || []).length} total`);

  // 2. Compensation for HQs (10M each)
  const HQ_COST = 10_000_000;
  const { data: hqs } = await supabase.from('headquarters').select('player_id');
  for (const hq of hqs || []) {
    const current = coinCompensation.get(hq.player_id) || 0;
    coinCompensation.set(hq.player_id, current + HQ_COST);
  }
  console.log(`HQs: ${(hqs || []).length} total`);

  // 3. Compensation for collectors (75 diamonds + stored coins)
  const { data: collectors } = await supabase.from('collectors').select('owner_id, stored_coins');
  const diamondCompensation = new Map();
  for (const col of collectors || []) {
    const curDia = diamondCompensation.get(col.owner_id) || 0;
    diamondCompensation.set(col.owner_id, curDia + 75);
    const curCoins = coinCompensation.get(col.owner_id) || 0;
    coinCompensation.set(col.owner_id, curCoins + (col.stored_coins || 0));
  }
  console.log(`Collectors: ${(collectors || []).length} total`);

  // 4. Compensation for clan HQs (10M to clan treasury)
  const CLAN_HQ_COST = 10_000_000;
  const { data: clanHqs } = await supabase.from('clan_headquarters').select('clan_id');
  for (const chq of clanHqs || []) {
    // Read current treasury, add, write back
    const { data: clan } = await supabase.from('clans').select('id, treasury').eq('id', chq.clan_id).maybeSingle();
    if (clan) {
      const newTreasury = (Number(clan.treasury) || 0) + CLAN_HQ_COST;
      await supabase.from('clans').update({ treasury: newTreasury }).eq('id', clan.id);
      console.log(`  Clan ${clan.id}: +${CLAN_HQ_COST} to treasury`);
    }
  }
  console.log(`Clan HQs: ${(clanHqs || []).length} total`);

  // 5. Apply coin compensation
  let compensatedPlayers = 0;
  for (const [player_id, coins] of coinCompensation) {
    if (coins <= 0) continue;
    const { data: player } = await supabase.from('players').select('id, coins').eq('id', player_id).maybeSingle();
    if (player) {
      const newCoins = (Number(player.coins) || 0) + coins;
      await supabase.from('players').update({ coins: newCoins }).eq('id', player.id);
      console.log(`  Player ${player_id}: +${coins.toLocaleString()} coins`);
      compensatedPlayers++;
    }
  }

  // 6. Apply diamond compensation
  for (const [player_id, diamonds] of diamondCompensation) {
    if (diamonds <= 0) continue;
    const { data: player } = await supabase.from('players').select('id, diamonds').eq('id', player_id).maybeSingle();
    if (player) {
      const newDiamonds = (Number(player.diamonds) || 0) + diamonds;
      await supabase.from('players').update({ diamonds: newDiamonds }).eq('id', player.id);
      console.log(`  Player ${player_id}: +${diamonds} diamonds`);
    }
  }

  // 7. Delete all buildings
  console.log('\nDeleting buildings...');
  const tables = [
    'monument_loot_boxes',
    'monument_raid_damage',
    'monument_defenders',
    'monuments',
    'collectors',
    'ore_nodes',
    'clan_headquarters',
    'mines',
    'headquarters',
  ];
  for (const table of tables) {
    const { error } = await supabase.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) console.error(`  ERROR deleting ${table}:`, error.message);
    else console.log(`  Deleted all from ${table}`);
  }

  console.log('\n=== WIPE COMPLETE ===');
  console.log(`Compensated players: ${compensatedPlayers}`);
  console.log(`Total coin compensation entries: ${coinCompensation.size}`);
  console.log(`Total diamond compensation entries: ${diamondCompensation.size}`);
}

wipeBuildings().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
