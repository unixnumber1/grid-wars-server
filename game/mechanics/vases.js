import { supabase } from '../../lib/supabase.js';
import { gameState } from '../state/GameState.js';

// ── City-based vase count ──
function getVaseCountForCity(playerCount) {
  return playerCount * 10 + Math.floor(Math.random() * playerCount * 5);
}

// ── Spawn vases for a city by bounding box ──
export async function spawnVasesForCity(cityKey, bounds, playerCount) {
  const [minLat, maxLat, minLng, maxLng] = bounds;

  const existingInCity = [...gameState.vases.values()].filter(v =>
    v.lat >= minLat && v.lat <= maxLat && v.lng >= minLng && v.lng <= maxLng &&
    !v.broken_by && new Date(v.expires_at) > new Date()
  );

  const targetCount = getVaseCountForCity(playerCount);
  const toSpawn = targetCount - existingInCity.length;
  if (toSpawn <= 0) return 0;

  console.log(`[VASES] ${cityKey}: spawning ${toSpawn} vases (players: ${playerCount}, existing: ${existingInCity.length})`);

  const batch = [];
  for (let i = 0; i < toSpawn; i++) {
    const lat = minLat + Math.random() * (maxLat - minLat);
    const lng = minLng + Math.random() * (maxLng - minLng);
    batch.push({
      lat, lng,
      diamonds_reward: Math.floor(Math.random() * 5) + 1,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  }

  if (batch.length > 0) {
    // Insert in chunks of 200
    for (let i = 0; i < batch.length; i += 200) {
      const chunk = batch.slice(i, i + 200);
      const { data: inserted, error } = await supabase.from('vases').insert(chunk).select('*');
      if (error) { console.error('[VASES] insert error:', error.message); continue; }
      for (const v of (inserted || [])) gameState.addVase(v);
    }
  }

  console.log(`[VASES] ${cityKey}: spawned ${batch.length}`);
  return batch.length;
}

// ── Legacy function (kept for backward compat) ──
export async function spawnVasesForAllHQs(supabase, gameState) {
  console.log('[VASES] Legacy spawn — delegating to city-based system');
  return 0;
}
