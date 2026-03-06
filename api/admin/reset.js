import { supabase } from '../../lib/supabase.js';

// TEMPORARY endpoint — call once to clear old cell_id data, then delete this file
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const [{ error: minesErr }, { error: hqErr }] = await Promise.all([
    supabase.from('mines').delete().neq('id', '00000000-0000-0000-0000-000000000000'),
    supabase.from('headquarters').delete().neq('id', '00000000-0000-0000-0000-000000000000'),
  ]);

  if (minesErr || hqErr) {
    console.error('[reset] error:', minesErr, hqErr);
    return res.status(500).json({ error: 'Reset failed', minesErr, hqErr });
  }

  return res.status(200).json({ ok: true, message: 'All mines and headquarters deleted' });
}
