/**
 * SCOUT UPDATE NOTIFICATION
 * Sends broadcast message about scout economy changes.
 *
 * Usage: node scripts/notify-scouts.js
 */

import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../lib/supabase.js';

const BOT = process.env.BOT_TOKEN;

async function notifyAll() {
  if (!BOT) { console.error('BOT_TOKEN not set'); process.exit(1); }

  const { data: players } = await supabase
    .from('players')
    .select('telegram_id')
    .not('telegram_id', 'is', null);

  if (!players?.length) { console.log('No players found.'); return; }
  console.log(`Sending to ${players.length} players...`);

  const text =
    `🤠 <b>Обновление скаутов!</b>\n\n` +
    `Пересмотрели экономику — стало выгоднее.\n\n` +
    `Подробности в канале 👇`;

  let sent = 0, failed = 0;

  for (let i = 0; i < players.length; i += 30) {
    const batch = players.slice(i, i + 30);

    const results = await Promise.allSettled(
      batch.map(p =>
        fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: p.telegram_id,
            text,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                { text: '📢 Канал', url: 'https://t.me/OverthrowInsider' },
              ]],
            },
          }),
        })
      )
    );

    sent += results.filter(r => r.status === 'fulfilled').length;
    failed += results.filter(r => r.status === 'rejected').length;

    if (i + 30 < players.length) await new Promise(r => setTimeout(r, 1000));
    process.stdout.write(`\r  Sent: ${sent}/${players.length} (failed: ${failed})`);
  }

  console.log(`\n\nDone! Sent: ${sent}, Failed: ${failed}`);
}

notifyAll().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
