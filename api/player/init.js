import { supabase } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { telegram_id, username } = req.body;

  if (!telegram_id) {
    return res.status(400).json({ error: 'telegram_id is required' });
  }

  // Upsert player
  const { data: player, error: playerError } = await supabase
    .from('players')
    .upsert(
      { telegram_id: Number(telegram_id), username: username || null },
      { onConflict: 'telegram_id', ignoreDuplicates: false }
    )
    .select()
    .single();

  if (playerError) {
    console.error('player upsert error:', playerError);
    return res.status(500).json({ error: 'Failed to init player' });
  }

  // Fetch headquarters
  const { data: headquarters } = await supabase
    .from('headquarters')
    .select('*')
    .eq('player_id', player.id)
    .maybeSingle();

  // Fetch mines
  const { data: mines } = await supabase
    .from('mines')
    .select('*')
    .eq('owner_id', player.id);

  return res.status(200).json({
    player,
    headquarters: headquarters || null,
    mines: mines || [],
  });
}
