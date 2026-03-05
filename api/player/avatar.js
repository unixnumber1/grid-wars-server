import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { ALLOWED_AVATARS } from '../../lib/formulas.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { telegram_id, avatar } = req.body;
  console.log('[avatar] incoming:', { telegram_id, avatar });

  if (!telegram_id || !avatar) {
    return res.status(400).json({ error: 'telegram_id and avatar are required' });
  }

  if (!ALLOWED_AVATARS.includes(avatar)) {
    return res.status(400).json({ error: 'Invalid avatar' });
  }

  // Step 1: find player
  const { player, error: findError } = await getPlayerByTelegramId(telegram_id);
  if (findError) return res.status(500).json({ error: findError });
  if (!player)   return res.status(404).json({ error: 'Player not found' });

  // Step 2: update avatar
  const { data: updated, error: updateError } = await supabase
    .from('players')
    .update({ avatar })
    .eq('id', player.id)               // use uuid PK, not bigint
    .select('id, telegram_id, username, avatar')
    .single();

  if (updateError) {
    console.error('[avatar] update error:', updateError);
    return res.status(500).json({ error: updateError.message });
  }

  console.log('[avatar] updated:', updated);
  return res.status(200).json({ player: updated });
}
