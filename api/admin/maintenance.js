import { supabase } from '../../lib/supabase.js';
import { getCellCenter } from '../../lib/grid.js';

const ADMIN_TG_ID = 560013667;

export default async function handler(req, res) {
  // GET — public status check
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'maintenance_mode')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ maintenance: data?.value === 'true' });
  }

  // POST — admin actions
  if (req.method === 'POST') {
    const { telegram_id, enabled, action } = req.body;
    const tgId = parseInt(telegram_id, 10);
    if (tgId !== ADMIN_TG_ID) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // ── fix-positions: snap all HQs and mines to cell centers ──
    if (action === 'fix-positions') {
      const [{ data: hqs }, { data: mines }] = await Promise.all([
        supabase.from('headquarters').select('id, cell_id'),
        supabase.from('mines').select('id, cell_id'),
      ]);

      const hqUpdates  = (hqs  || []).map(({ id, cell_id }) => {
        const [lat, lng] = getCellCenter(cell_id);
        return supabase.from('headquarters').update({ lat, lng }).eq('id', id);
      });
      const mineUpdates = (mines || []).map(({ id, cell_id }) => {
        const [lat, lng] = getCellCenter(cell_id);
        return supabase.from('mines').update({ lat, lng }).eq('id', id);
      });

      await Promise.all([...hqUpdates, ...mineUpdates]);
      return res.status(200).json({ fixed_hq: hqs?.length ?? 0, fixed_mines: mines?.length ?? 0 });
    }

    // ── maintenance toggle ──
    const value = enabled ? 'true' : 'false';
    const { error } = await supabase
      .from('app_settings')
      .upsert({ key: 'maintenance_mode', value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ maintenance: enabled });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
