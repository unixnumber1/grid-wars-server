import { supabase } from '../../lib/supabase.js';
import { ALLOWED_AVATARS } from '../../lib/formulas.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { telegram_id, avatar } = req.body;

  if (!telegram_id || !avatar) {
    return res.status(400).json({ error: 'telegram_id and avatar are required' });
  }

  if (!ALLOWED_AVATARS.includes(avatar)) {
    return res.status(400).json({ error: 'Invalid avatar' });
  }

  const { data: player, error: updateError } = await supabase
    .from('players')
    .update({ avatar })
    .eq('telegram_id', Number(telegram_id))
    .select('id, telegram_id, username, avatar')
    .maybeSingle();

  if (updateError || !player) {
    return res.status(404).json({ error: 'Player not found' });
  }

  return res.status(200).json({ player });
}
