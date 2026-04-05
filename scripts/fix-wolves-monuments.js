import dotenv from 'dotenv';
dotenv.config();
import { supabase } from '../lib/supabase.js';

const BOT = process.env.BOT_TOKEN;

async function run() {
  // 1. Compensate wolf-avatar players with 50 diamonds + notify
  const { data: wolves } = await supabase.from('players').select('id, telegram_id, diamonds').eq('avatar', '🐺');
  let comp = 0;
  for (const p of (wolves || [])) {
    await supabase.from('players').update({ diamonds: (p.diamonds || 0) + 50 }).eq('id', p.id);
    const text = '🐺 Твоя аватарка была сброшена при обновлении пула.\n\n+50 💎 в качестве компенсации!\nВыбери новую аватарку бесплатно в настройках.';
    await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: p.telegram_id, text, parse_mode: 'HTML' }),
    }).catch(() => {});
    comp++;
    if (comp % 30 === 0) await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`Wolves compensated: ${comp}`);

  // 2. Reset all monuments to level 1
  const { data: mons } = await supabase.from('monuments').select('id, level');
  let reset = 0;
  for (const m of (mons || [])) {
    if (m.level === 1) { reset++; continue; }
    await supabase.from('monuments').update({
      level: 1, hp: 50000, max_hp: 50000,
      shield_hp: 8000, max_shield_hp: 8000,
      phase: 'shield', waves_triggered: null, respawn_at: null, raid_started_at: null,
    }).eq('id', m.id);
    reset++;
  }
  console.log(`Monuments reset to lv1: ${reset} / ${(mons || []).length}`);

  process.exit(0);
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
