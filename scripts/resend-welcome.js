#!/usr/bin/env node
// Resend welcome message with referral button to all players and pin it
// Run on VPS: node scripts/resend-welcome.js
import dotenv from 'dotenv';
dotenv.config();
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const BOT = process.env.BOT_TOKEN;
if (!BOT) { console.error('BOT_TOKEN not set'); process.exit(1); }

const DELAY_MS = 50; // 50ms between messages to avoid rate limits

async function sendToPlayer(telegramId) {
  const name = 'Игрок';
  const welcomeText = `⚔️ *Добро пожаловать в Overthrow!*\n\n🌍 Геолокационная стратегия в реальном мире.\n\n🏗️ Строй шахты\n⛏️ Добывай ресурсы\n⚔️ Сражайся с игроками\n🏛️ Рейди монументы\n\nНажми кнопку ниже чтобы начать игру! 👇`;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramId,
        text: welcomeText,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '🎮 Играть', web_app: { url: 'https://overthrow.ru:8443' } }],
          [{ text: '💬 Чат игры', url: 'https://t.me/overthrowglobal' }, { text: '📢 Новости', url: 'https://t.me/OverthrowInsider' }],
          [{ text: '🔗 Реферальная ссылка', callback_data: 'get_referral_link' }],
        ] },
      }),
    });
    const data = await resp.json();
    if (data.ok && data.result?.message_id) {
      // Pin the message
      await fetch(`https://api.telegram.org/bot${BOT}/pinChatMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: telegramId, message_id: data.result.message_id, disable_notification: true }),
      }).catch(() => {});
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

async function main() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT telegram_id FROM players ORDER BY created_at');
    console.log(`[resend-welcome] Found ${rows.length} players`);
    let sent = 0, failed = 0;
    for (const row of rows) {
      const ok = await sendToPlayer(row.telegram_id);
      if (ok) sent++; else failed++;
      if (sent % 10 === 0) console.log(`  sent: ${sent}, failed: ${failed}`);
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
    console.log(`[resend-welcome] Done: ${sent} sent, ${failed} failed`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
