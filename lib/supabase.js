import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_KEY environment variables');
}

export const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Parse telegram_id safely.
 * JSON delivers it as a number or string; bigint columns in Postgres need
 * an integer — parseInt handles both without floating-point precision loss
 * (all current Telegram user IDs fit in Number.MAX_SAFE_INTEGER).
 */
export function parseTgId(telegram_id) {
  const n = parseInt(telegram_id, 10);
  if (isNaN(n)) throw new Error(`Invalid telegram_id: ${telegram_id}`);
  return n;
}

/**
 * Look up a player row by telegram_id.
 * Returns { player, error } — caller decides how to handle null player.
 */
export async function getPlayerByTelegramId(telegram_id, select = 'id') {
  let tgId;
  try { tgId = parseTgId(telegram_id); } catch (e) {
    return { player: null, error: e.message };
  }
  console.log('[getPlayer] telegram_id:', tgId);
  const { data: player, error } = await supabase
    .from('players')
    .select(select)
    .eq('telegram_id', tgId)
    .maybeSingle();
  if (error) console.error('[getPlayer] error:', error);
  return { player, error };
}
