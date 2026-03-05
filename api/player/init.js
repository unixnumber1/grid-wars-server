import { supabase, parseTgId } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { telegram_id, username } = req.body;

  if (!telegram_id) {
    return res.status(400).json({ error: 'telegram_id is required' });
  }

  let tgId;
  try { tgId = parseTgId(telegram_id); } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Upsert player
  const { data: player, error: playerError } = await supabase
    .from('players')
    .upsert(
      { telegram_id: tgId, username: username || null },
      { onConflict: 'telegram_id', ignoreDuplicates: false }
    )
    .select()
    .single();

  if (playerError) {
    console.error('[init] player upsert error:', playerError);
    return res.status(500).json({ error: 'Failed to init player' });
  }

  // Fetch headquarters and mines in parallel
  const [{ data: headquarters }, { data: mines }] = await Promise.all([
    supabase.from('headquarters').select('*').eq('player_id', player.id).maybeSingle(),
    supabase.from('mines').select('*').eq('owner_id', player.id),
  ]);

  return res.status(200).json({
    player,
    headquarters: headquarters || null,
    mines: mines || [],
  });
}
