import dotenv from 'dotenv';
dotenv.config();

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_KEY environment variables');
}

export const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Parse telegram_id safely.
 */
export function parseTgId(telegram_id) {
  const n = parseInt(telegram_id, 10);
  if (isNaN(n)) throw new Error(`Invalid telegram_id: ${telegram_id}`);
  return n;
}

// ── Rate limiting (in-memory) ──────────────
const _rateLimits = new Map();
export function rateLimit(id, maxPerMinute = 30) {
  const now = Date.now();
  const calls = _rateLimits.get(id) || [];
  const recent = calls.filter(t => now - t < 60000);
  if (recent.length >= maxPerMinute) return false;
  recent.push(now);
  _rateLimits.set(id, recent);
  if (_rateLimits.size > 1000) {
    for (const [k, v] of _rateLimits) {
      if (v.every(t => now - t > 60000)) _rateLimits.delete(k);
    }
  }
  return true;
}

/**
 * Send a Telegram message to a player by their telegram_id.
 */
export async function sendTelegramNotification(telegramId, text) {
  const BOT = process.env.BOT_TOKEN;
  if (!BOT || !telegramId) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramId, text, parse_mode: 'HTML' }),
    });
  } catch (e) { console.error('[tg] send error:', e.message); }
}

export async function getPlayerByTelegramId(telegram_id, select = 'id') {
  let tgId;
  try { tgId = parseTgId(telegram_id); } catch (e) {
    return { player: null, error: e.message };
  }
  const { data: player, error } = await supabase
    .from('players')
    .select(select)
    .eq('telegram_id', tgId)
    .maybeSingle();
  if (error) console.error('[getPlayer] error:', error);
  return { player, error };
}
