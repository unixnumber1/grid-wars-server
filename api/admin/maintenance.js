import { supabase } from '../../lib/supabase.js';
import { getCellCenter } from '../../lib/grid.js';

const ADMIN_TG_ID = 560013667;

export default async function handler(req, res) {
  // GET — public status check OR admin queries
  if (req.method === 'GET') {
    const { action, admin_id, search } = req.query || {};

    // ── players-list: search players by username ──
    if (action === 'players-list') {
      const adminId = parseInt(admin_id, 10);
      if (adminId !== ADMIN_TG_ID) return res.status(403).json({ error: 'Forbidden' });

      const q = (search || '').trim();
      if (!q) return res.status(200).json({ players: [] });

      const { data, error } = await supabase
        .from('players')
        .select('id, username, avatar, level, coins, diamonds, is_banned, ban_reason, ban_until')
        .ilike('username', `%${q}%`)
        .order('last_seen', { ascending: false })
        .limit(20);

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ players: data || [] });
    }

    // ── default: maintenance status ──
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
    const { telegram_id, admin_id, enabled, action } = req.body;
    const tgId = parseInt(telegram_id || admin_id, 10);
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

    // ── fix-usernames: backfill owner_username on all headquarters ──
    if (action === 'fix-usernames') {
      const { data: allHQ } = await supabase.from('headquarters').select('id, player_id');
      for (const hq of (allHQ || [])) {
        const { data: player } = await supabase.from('players').select('username').eq('id', hq.player_id).single();
        await supabase.from('headquarters').update({ owner_username: player?.username ?? null }).eq('id', hq.id);
      }
      return res.status(200).json({ fixed: allHQ?.length ?? 0 });
    }

    // ── reward: give coins or diamonds to a player ──
    if (action === 'reward') {
      const { player_id, currency, amount } = req.body;
      if (!player_id || !currency || !amount) {
        return res.status(400).json({ error: 'player_id, currency, amount are required' });
      }
      if (currency !== 'coins' && currency !== 'diamonds') {
        return res.status(400).json({ error: 'currency must be coins or diamonds' });
      }
      const numAmount = parseInt(amount, 10);
      if (isNaN(numAmount) || numAmount <= 0) {
        return res.status(400).json({ error: 'amount must be a positive number' });
      }

      const { data: player, error: fetchErr } = await supabase
        .from('players').select('id, coins, diamonds').eq('id', player_id).single();
      if (fetchErr || !player) return res.status(404).json({ error: 'Player not found' });

      const newBalance = (player[currency] ?? 0) + numAmount;
      const { error: updateErr } = await supabase
        .from('players').update({ [currency]: newBalance }).eq('id', player_id);
      if (updateErr) return res.status(500).json({ error: updateErr.message });

      return res.status(200).json({ success: true, newBalance });
    }

    // ── ban: ban a player ──
    if (action === 'ban') {
      const { player_id, reason, duration_days } = req.body;
      if (!player_id) return res.status(400).json({ error: 'player_id is required' });
      if (!reason) return res.status(400).json({ error: 'reason is required' });

      const days = parseInt(duration_days, 10);
      if (isNaN(days) || days < 0) return res.status(400).json({ error: 'Invalid duration_days' });

      const banUntil = days === 0 ? null : new Date(Date.now() + days * 86400000).toISOString();

      const { error } = await supabase
        .from('players')
        .update({
          is_banned: true,
          ban_reason: reason,
          ban_until: banUntil,
          banned_at: new Date().toISOString(),
        })
        .eq('id', player_id);
      if (error) return res.status(500).json({ error: error.message });

      return res.status(200).json({ success: true, banned: true, until: banUntil });
    }

    // ── unban: unban a player ──
    if (action === 'unban') {
      const { player_id } = req.body;
      if (!player_id) return res.status(400).json({ error: 'player_id is required' });

      const { error } = await supabase
        .from('players')
        .update({ is_banned: false, ban_reason: null, ban_until: null })
        .eq('id', player_id);
      if (error) return res.status(500).json({ error: error.message });

      return res.status(200).json({ success: true, unbanned: true });
    }

    // ── fix-hq: remove duplicate headquarters (keep oldest per player) ──
    if (action === 'fix-hq') {
      const { data: allHqs, error: allError } = await supabase
        .from('headquarters')
        .select('id, player_id, created_at')
        .order('created_at', { ascending: true });

      if (allError) return res.status(500).json({ error: allError.message });

      const byPlayer = {};
      for (const hq of allHqs) {
        if (!byPlayer[hq.player_id]) byPlayer[hq.player_id] = [];
        byPlayer[hq.player_id].push(hq);
      }

      const toDelete = [];
      for (const [, hqs] of Object.entries(byPlayer)) {
        if (hqs.length > 1) {
          for (let i = 1; i < hqs.length; i++) toDelete.push(hqs[i].id);
        }
      }

      if (toDelete.length === 0) {
        return res.status(200).json({ success: true, deleted: 0, message: 'Дублей не найдено' });
      }

      const { error: delError } = await supabase.from('headquarters').delete().in('id', toDelete);
      if (delError) return res.status(500).json({ error: delError.message });

      return res.status(200).json({
        success: true,
        deleted: toDelete.length,
        message: `Удалено ${toDelete.length} дублей штабов`,
      });
    }

    // ── maintenance toggle (default) ──
    const value = enabled ? 'true' : 'false';
    const { error } = await supabase
      .from('app_settings')
      .upsert({ key: 'maintenance_mode', value }, { onConflict: 'key' });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ maintenance: enabled });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
