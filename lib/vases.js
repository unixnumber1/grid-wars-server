import { haversine } from './haversine.js';

export async function spawnVasesForClusters(supabase) {
  const { data: allHQ } = await supabase.from('headquarters').select('lat, lng, player_id');
  if (!allHQ || allHQ.length === 0) return 0;

  // Group HQs into clusters (10km radius)
  const clusters = [];
  const assigned = new Set();
  for (const hq of allHQ) {
    if (assigned.has(hq.player_id)) continue;
    const cluster = [hq];
    assigned.add(hq.player_id);
    for (const other of allHQ) {
      if (assigned.has(other.player_id)) continue;
      if (haversine(hq.lat, hq.lng, other.lat, other.lng) <= 10000) {
        cluster.push(other);
        assigned.add(other.player_id);
      }
    }
    clusters.push(cluster);
  }

  let totalSpawned = 0;
  const nowISO = new Date().toISOString();

  for (const cluster of clusters) {
    const centerLat = cluster.reduce((s, h) => s + h.lat, 0) / cluster.length;
    const centerLng = cluster.reduce((s, h) => s + h.lng, 0) / cluster.length;
    const vaseCount = cluster.length === 1 ? 2 : cluster.length <= 3 ? 4 : 6;

    const { data: existingVases } = await supabase
      .from('vases')
      .select('id, lat, lng')
      .gt('expires_at', nowISO)
      .is('broken_by', null)
      .gte('lat', centerLat - 0.1).lte('lat', centerLat + 0.1)
      .gte('lng', centerLng - 0.1).lte('lng', centerLng + 0.1);

    const needed = vaseCount - (existingVases?.length || 0);
    if (needed <= 0) continue;

    const cosLat   = Math.cos(centerLat * Math.PI / 180) || 1;
    const newVases = [];
    let   attempts = 0;

    while (newVases.length < needed && attempts < 50) {
      attempts++;
      const angle    = Math.random() * Math.PI * 2;
      const distance = 500 + Math.random() * 4500;
      const lat = centerLat + (distance / 111000) * Math.cos(angle);
      const lng = centerLng + (distance / (111000 * cosLat)) * Math.sin(angle);

      const tooClose = [...(existingVases || []), ...newVases]
        .some(v => haversine(lat, lng, v.lat, v.lng) < 500);
      if (tooClose) continue;

      newVases.push({
        lat,
        lng,
        expires_at:       new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        diamonds_reward:  Math.floor(Math.random() * 5) + 1,
      });
    }

    if (newVases.length > 0) {
      const { error } = await supabase.from('vases').insert(newVases);
      if (!error) totalSpawned += newVases.length;
      else console.error('[vases] insert error:', error.message);
    }
  }

  return totalSpawned;
}
