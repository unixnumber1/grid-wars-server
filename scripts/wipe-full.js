/**
 * FULL WIPE SCRIPT — Beta Exit
 *
 * What it does:
 * 1. Calculates level-based compensation (gems, shards, ether)
 * 2. Counts referral links → converts to post-wipe diamond bonus (50💎 per ref)
 * 3. Resets all player stats (level, xp, coins, diamonds → 0, then adds compensation)
 * 4. Deletes ALL player-created data (buildings, items, cores, clans, etc.)
 * 5. Preserves: monuments, app_settings, player accounts (identity + created_at)
 * 6. Preserves: pioneer badges for accounts created before 2026-04-01
 * 7. Cleans all other badges
 *
 * Run: node scripts/wipe-full.js
 * Add --dry-run to preview without changes
 */

import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../lib/supabase.js';

const DRY_RUN = process.argv.includes('--dry-run');

// ── Compensation formula: flat per level ──
function getLevelCompensation(level) {
  if (level <= 0) return { diamonds: 0, crystals: 0, ether: 0 };
  return { diamonds: level * 20, crystals: level * 200, ether: level * 200 };
}

async function wipeFull() {
  console.log(DRY_RUN ? '=== DRY RUN — no changes ===' : '=== FULL WIPE — BETA EXIT ===');
  console.log('');

  // ─── Step 1: Load all players ───
  const { data: players } = await supabase.from('players').select('id, telegram_id, level, created_at');
  if (!players || players.length === 0) {
    console.log('No players found. Aborting.');
    return;
  }
  console.log(`Players: ${players.length}`);

  // ─── Step 2: Count referral links per referrer ───
  const { data: referrals } = await supabase.from('referrals').select('referrer_id, referred_id');
  const refCountByTgId = new Map(); // telegram_id → count of referrals
  for (const ref of referrals || []) {
    const cur = refCountByTgId.get(ref.referrer_id) || 0;
    refCountByTgId.set(ref.referrer_id, cur + 1);
  }
  console.log(`Referral links: ${(referrals || []).length} total, ${refCountByTgId.size} referrers`);

  // ─── Step 3: Calculate compensation per player ───
  const REFERRAL_DIAMOND_REWARD = 50; // diamonds per referral link
  const PIONEER_CUTOFF = new Date('2026-04-01T00:00:00Z');

  const compensations = [];
  let totalDiamonds = 0, totalCrystals = 0, totalEther = 0, totalRefDiamonds = 0;

  for (const p of players) {
    const level = p.level || 1;
    const comp = getLevelCompensation(level);

    // Referral bonus
    const refCount = refCountByTgId.get(p.telegram_id) || 0;
    const refDiamonds = refCount * REFERRAL_DIAMOND_REWARD;

    compensations.push({
      id: p.id,
      telegram_id: p.telegram_id,
      level,
      diamonds: comp.diamonds + refDiamonds,
      crystals: comp.crystals,
      ether: comp.ether,
      refCount,
      refDiamonds,
      isPioneer: p.created_at && new Date(p.created_at) < PIONEER_CUTOFF,
    });

    totalDiamonds += comp.diamonds + refDiamonds;
    totalCrystals += comp.crystals;
    totalEther += comp.ether;
    totalRefDiamonds += refDiamonds;
  }

  console.log('');
  console.log('── Compensation summary ──');
  console.log(`  Total diamonds: ${totalDiamonds.toLocaleString()} (incl. ${totalRefDiamonds.toLocaleString()} from referrals)`);
  console.log(`  Total crystals: ${totalCrystals.toLocaleString()}`);
  console.log(`  Total ether: ${totalEther.toLocaleString()}`);
  console.log('');

  // Show top 10 compensations
  const top = compensations.sort((a, b) => b.level - a.level).slice(0, 10);
  console.log('── Top 10 by level ──');
  for (const c of top) {
    console.log(`  tg:${c.telegram_id} lv${c.level} → 💎${c.diamonds} (ref:${c.refCount}×${REFERRAL_DIAMOND_REWARD}=${c.refDiamonds}) 🔮${c.crystals} ⚗️${c.ether} ${c.isPioneer ? '🧭pioneer' : ''}`);
  }
  console.log('');

  if (DRY_RUN) {
    console.log('DRY RUN complete. No changes made.');
    return;
  }

  // ─── Step 4: Reset all players + apply compensation ───
  console.log('── Resetting players + applying compensation ──');
  let resetCount = 0;
  for (const c of compensations) {
    const { error } = await supabase.from('players').update({
      coins: 10_000_000,
      diamonds: c.diamonds,
      crystals: c.crystals,
      ether: c.ether,
      level: 1,
      xp: 0,
      hp: 1000,
      max_hp: 1000,
      kills: 0,
      deaths: 0,
      shield_until: null,
      respawn_until: null,
      last_hp_regen: null,
      bonus_attack: 0,
      bonus_hp: 0,
      bonus_crit: 0,
      equipped_sword: null,
      equipped_shield: null,
      active_badge: c.isPioneer ? 'pioneer' : null,
      clan_id: null,
      clan_role: null,
      daily_diamonds_claimed_at: null,
      streak_day: 0,
      streak_claimed_at: null,
    }).eq('id', c.id);
    if (error) console.error(`  ERROR resetting player ${c.telegram_id}:`, error.message);
    else resetCount++;
  }
  console.log(`  Reset ${resetCount}/${players.length} players`);

  // ─── Step 5: Clean badges — keep only pioneer for pre-April accounts ───
  console.log('── Cleaning badges ──');
  // Delete all badges first
  await supabase.from('player_badges').delete().neq('badge_id', '__none__');
  // Re-insert pioneer for eligible players
  const pioneers = compensations.filter(c => c.isPioneer);
  let pioneerCount = 0;
  for (const p of pioneers) {
    const { error } = await supabase.from('player_badges').insert({
      player_id: p.telegram_id,
      badge_id: 'pioneer',
    });
    if (!error) pioneerCount++;
  }
  console.log(`  Pioneer badge: ${pioneerCount} players`);

  // ─── Step 6: Delete all game data tables ───
  console.log('── Deleting game data ──');
  const deleteTables = [
    // Monument state (NOT monuments themselves)
    'monument_loot_boxes',
    'monument_defenders',
    // Buildings
    'fire_trucks',
    'collectors',
    'ore_nodes',
    'clan_headquarters',
    'barracks',
    'mines',
    'headquarters',
    // Items & economy
    'items',
    'cores',
    'market_listings',
    'couriers',
    'courier_drops',
    // Combat & mobs
    'bots',
    'vases',
    'zombies',
    'zombie_hordes',
    // Military
    'training_queue',
    'unit_bag',
    'unit_upgrades',
    'active_scouts',
    // Markets (auto-spawned, wipe stale locations)
    'markets',
    // Social & tracking
    'clans',
    'clan_members',
    'pvp_log',
    'pvp_cooldowns',
    'referrals',
    'player_skills',
    'level_rewards_claimed',
    'notifications',
    'monument_requests',
  ];

  // Tables with integer PK or no standard 'id' column
  const intIdTables = new Set(['pvp_cooldowns', 'player_skills', 'level_rewards_claimed', 'monument_requests']);
  for (const table of deleteTables) {
    let result;
    if (intIdTables.has(table)) {
      // Use gt on a safe column or gte on id for integer PKs
      result = await supabase.from(table).delete().gte('id', 0);
      // Fallback: if that fails, try neq on a text field
      if (result.error) result = await supabase.from(table).delete().not('id', 'is', null);
    } else {
      result = await supabase.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000');
    }
    if (result.error) console.error(`  ERROR ${table}:`, result.error.message);
    else console.log(`  ✓ ${table}`);
  }

  // ─── Step 7: Reset monuments to fresh state ───
  console.log('── Resetting monuments (preserved, HP restored) ──');
  const { data: monuments } = await supabase.from('monuments').select('id, level, max_hp, max_shield_hp');
  for (const m of monuments || []) {
    // Reset to shield phase, full HP (use stored max values)
    await supabase.from('monuments').update({
      phase: 'shield',
      hp: m.max_hp,
      shield_hp: m.max_shield_hp,
      waves_triggered: null,
      respawn_at: null,
      raid_started_at: null,
    }).eq('id', m.id);
  }
  console.log(`  Reset ${(monuments || []).length} monuments`);

  // ─── Step 8: Clean app_settings (temp keys) ───
  console.log('── Cleaning app_settings ──');
  for (const key of ['last_bots_move', 'last_vases_spawn']) {
    await supabase.from('app_settings').delete().eq('key', key);
  }
  console.log('  ✓ Cleared temp settings');

  // ─── Done ───
  console.log('');
  console.log('=== FULL WIPE COMPLETE ===');
  console.log(`  Players reset: ${resetCount}`);
  console.log(`  Pioneers kept: ${pioneerCount}`);
  console.log(`  Tables wiped: ${deleteTables.length}`);
  console.log(`  Monuments preserved: ${(monuments || []).length}`);
  console.log('');
  console.log('⚠️  Restart the server: pm2 restart grid-wars');
}

wipeFull().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
