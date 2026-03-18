import { haversine } from '../../lib/haversine.js';
import { getCellId } from '../../lib/grid.js';

/**
 * Spawn vases for each HQ: 15-50 random vases within 5km radius.
 * Vases spawn at random positions (not hex centers), and never on top of player mines.
 */
export async function spawnVasesForAllHQs(supabase, gameState) {
  const { data: allHQ } = await supabase.from('headquarters').select('lat, lng, player_id');
  if (!allHQ || allHQ.length === 0) return 0;

  // Collect occupied cells (mines) to avoid placing vases on them
  const mineCells = new Set();
  if (gameState?.loaded) {
    for (const m of gameState.mines.values()) {
      if (m.cell_id && m.status !== 'destroyed') mineCells.add(m.cell_id);
    }
  }

  let totalSpawned = 0;
  const allNewVases = [];

  for (const hq of allHQ) {
    const vaseCount = 15 + Math.floor(Math.random() * 36); // 15-50
    const cosLat = Math.cos(hq.lat * Math.PI / 180) || 1;
    const hqVases = [];
    let attempts = 0;

    while (hqVases.length < vaseCount && attempts < 100) {
      attempts++;
      const angle = Math.random() * Math.PI * 2;
      const distance = 200 + Math.random() * 4800; // 200m - 5km
      const lat = hq.lat + (distance / 111000) * Math.cos(angle);
      const lng = hq.lng + (distance / (111000 * cosLat)) * Math.sin(angle);

      // Don't place on player mines
      const cellId = getCellId(lat, lng);
      if (mineCells.has(cellId)) continue;

      // Min 300m between vases
      const tooClose = [...allNewVases, ...hqVases]
        .some(v => haversine(lat, lng, v.lat, v.lng) < 300);
      if (tooClose) continue;

      hqVases.push({
        lat,
        lng,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        diamonds_reward: Math.floor(Math.random() * 5) + 1,
      });
    }

    allNewVases.push(...hqVases);
  }

  if (allNewVases.length > 0) {
    const { error } = await supabase.from('vases').insert(allNewVases);
    if (!error) totalSpawned = allNewVases.length;
    else console.error('[vases] insert error:', error.message);
  }

  return totalSpawned;
}
