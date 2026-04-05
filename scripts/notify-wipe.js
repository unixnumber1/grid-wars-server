/**
 * WIPE NOTIFICATION SCRIPT
 * Sends personalized compensation message to every player via Telegram Bot API.
 * Run AFTER wipe-full.js (reads post-wipe player data).
 *
 * Usage: node scripts/notify-wipe.js
 */

import dotenv from 'dotenv';
dotenv.config();

import { supabase } from '../lib/supabase.js';

const BOT = process.env.BOT_TOKEN;
const WEB_APP_URL = 'https://overthrow.ru:8443';

function formatNum(n) {
  return Number(n || 0).toLocaleString('ru-RU');
}

async function notifyAll() {
  if (!BOT) { console.error('BOT_TOKEN not set'); process.exit(1); }

  const { data: players } = await supabase
    .from('players')
    .select('telegram_id, coins, diamonds, crystals, ether')
    .not('telegram_id', 'is', null);

  if (!players?.length) { console.log('No players found.'); return; }
  console.log(`Sending to ${players.length} players...`);

  let sent = 0, failed = 0;

  for (let i = 0; i < players.length; i += 30) {
    const batch = players.slice(i, i + 30);

    const results = await Promise.allSettled(
      batch.map(p => {
        const text =
          `🔄 <b>Бета завершена! Полный вайп выполнен.</b>\n\n` +
          `Спасибо, что играл в бету! Твоя компенсация:\n\n` +
          `💰 <b>${formatNum(p.coins)}</b> монет\n` +
          `💎 <b>${formatNum(p.diamonds)}</b> алмазов\n` +
          `✨ <b>${formatNum(p.crystals)}</b> осколков\n` +
          `🌀 <b>${formatNum(p.ether)}</b> эфира\n\n` +
          `Удачи в новом сезоне! 🚀`;

        return fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: p.telegram_id,
            text,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                { text: '🎮 Играть', web_app: { url: WEB_APP_URL } },
              ]],
            },
          }),
        });
      })
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
