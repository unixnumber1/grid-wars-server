import { supabase, parseTgId } from '../../lib/supabase.js';

const ADMIN_TG_ID = 560013667;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telegram_id } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });

  let tgId;
  try { tgId = parseTgId(telegram_id); } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (tgId !== ADMIN_TG_ID) return res.status(403).json({ error: 'Admin only' });

  // Find players with duplicate HQs
  const { data: dupes, error: dupError } = await supabase.rpc('find_duplicate_hqs');

  if (dupError) {
    // Fallback: do it manually if RPC doesn't exist
    console.log('[fix-hq] RPC not available, using manual query');

    const { data: allHqs, error: allError } = await supabase
      .from('headquarters')
      .select('id, player_id, created_at')
      .order('created_at', { ascending: true });

    if (allError) return res.status(500).json({ error: allError.message });

    // Group by player_id
    const byPlayer = {};
    for (const hq of allHqs) {
      if (!byPlayer[hq.player_id]) byPlayer[hq.player_id] = [];
      byPlayer[hq.player_id].push(hq);
    }

    const toDelete = [];
    for (const [playerId, hqs] of Object.entries(byPlayer)) {
      if (hqs.length > 1) {
        // Keep first (oldest), delete the rest
        for (let i = 1; i < hqs.length; i++) {
          toDelete.push(hqs[i].id);
        }
      }
    }

    if (toDelete.length === 0) {
      return res.status(200).json({ success: true, deleted: 0, message: 'No duplicates found' });
    }

    const { error: delError } = await supabase
      .from('headquarters')
      .delete()
      .in('id', toDelete);

    if (delError) return res.status(500).json({ error: delError.message });

    return res.status(200).json({
      success: true,
      deleted: toDelete.length,
      message: `Deleted ${toDelete.length} duplicate HQs`,
    });
  }

  return res.status(200).json({ success: true, data: dupes });
}
