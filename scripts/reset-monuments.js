/**
 * Reset all monuments: cap level to 4, restore defeated to shield phase.
 * Run: node scripts/reset-monuments.js
 */
import { supabase } from '../lib/supabase.js';

const MAX_LEVEL = 4;

// Monument HP/Shield from constants
const MONUMENT_HP = [0, 50000, 120000, 280000, 600000, 1200000, 2500000, 5000000, 10000000, 22000000, 40000000];
const MONUMENT_SHIELD_HP = [0, 8000, 20000, 50000, 120000, 300000, 700000, 1500000, 3500000, 6000000, 10000000];

async function main() {
  const { data: monuments, error } = await supabase.from('monuments').select('*');
  if (error) { console.error('Failed to fetch monuments:', error.message); process.exit(1); }

  console.log(`Found ${monuments.length} monuments`);

  let updated = 0;
  for (const m of monuments) {
    const needsLevelCap = m.level > MAX_LEVEL;
    const needsRevive = m.phase === 'defeated';
    if (!needsLevelCap && !needsRevive) continue;

    const newLevel = needsLevelCap ? (1 + Math.floor(Math.random() * MAX_LEVEL)) : m.level;
    const hp = MONUMENT_HP[newLevel];
    const shieldHp = MONUMENT_SHIELD_HP[newLevel];

    const { error: upErr } = await supabase.from('monuments').update({
      level: newLevel,
      hp, max_hp: hp,
      shield_hp: shieldHp, max_shield_hp: shieldHp,
      phase: 'shield',
      respawn_at: null,
    }).eq('id', m.id);

    if (upErr) {
      console.error(`  Failed to update monument ${m.id}:`, upErr.message);
    } else {
      const reason = [needsLevelCap ? `lv${m.level}->${newLevel}` : null, needsRevive ? 'revived' : null].filter(Boolean).join(', ');
      console.log(`  ${m.name} (${m.id}): ${reason}`);
      updated++;
    }
  }

  // Delete all defenders (they belong to old phases)
  const { error: defErr } = await supabase.from('monument_defenders').delete().not('id', 'is', null);
  if (defErr) console.error('Failed to clear defenders:', defErr.message);
  else console.log('Cleared all monument defenders');

  console.log(`Done. Updated ${updated}/${monuments.length} monuments`);
  process.exit(0);
}

main();
