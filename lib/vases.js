import { haversine } from './haversine.js';

/**
 * Spawn vases for each HQ: 3-10 random vases within 5km radius.
 * Minimum 300m between vases to avoid clustering.
 */
export async function spawnVasesForAllHQs(supabase) {
  const { data: allHQ } = await supabase.from('headquarters').select('lat, lng, player_id');
  if (!allHQ || allHQ.length === 0) return 0;

  let totalSpawned = 0;
  const allNewVases = [];

  for (const hq of allHQ) {
    const vaseCount = 3 + Math.floor(Math.random() * 8); // 3-10
    const cosLat = Math.cos(hq.lat * Math.PI / 180) || 1;
    const hqVases = [];
    let attempts = 0;

    while (hqVases.length < vaseCount && attempts < 100) {
      attempts++;
      const angle = Math.random() * Math.PI * 2;
      const distance = 200 + Math.random() * 4800; // 200m - 5km from HQ
      const lat = hq.lat + (distance / 111000) * Math.cos(angle);
      const lng = hq.lng + (distance / (111000 * cosLat)) * Math.sin(angle);

      // Min 300m between vases (including vases from other HQs)
      const tooClose = [...allNewVases, ...hqVases]
        .some(v => haversine(lat, lng, v.lat, v.lng) < 300);
      if (tooClose) continue;

      hqVases.push({
        lat,
        lng,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        diamonds_reward: Math.floor(Math.random() * 5) + 1, // 1-5
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
