import { haversine } from './haversine.js';

export const GOBLIN = {
  emoji: '👺',
  baseHp: 50,
  baseAttack: 15,
  speed: {
    roaming: 0.00008,
    aggro: 0.00015,
    fleeing: 0.00012,
  },
  aggroRadius: 500,
  stealPercent: 0.15,
  stealMinLeft: 0.10,
  stealDuration: 15000,
  respawnDelay: 300000,
  maxPerZone: 2,
  globalMax: 50,
  xpReward: 75,
  dropDiamonds: [1, 3],
};

export function getGoblinEmoji(goblin) {
  if (goblin.state === 'aggro') return '👺';
  if (goblin.state === 'fleeing') {
    const s = goblin.stolen_coins || 0;
    return s > 100000 ? '👺💰💰💰' : s > 50000 ? '👺💰💰' : s > 0 ? '👺💰' : '👺';
  }
  return '👺';
}

function isNightMSK() {
  const h = new Date(Date.now() + 3 * 3600000).getUTCHours();
  return h >= 0 && h < 6;
}

export async function ensureGoblinsNearPlayer(supabase, playerLat, playerLng) {
  if (!playerLat || !playerLng) return [];
  const needed = Math.ceil(GOBLIN.maxPerZone * (isNightMSK() ? 1.5 : 1));

  const PAD = 0.05;
  const [{ data: nearby }, { count: globalCount }] = await Promise.all([
    supabase.from('bots').select('id,lat,lng').eq('status', 'alive')
      .gte('lat', playerLat - PAD).lte('lat', playerLat + PAD)
      .gte('lng', playerLng - PAD).lte('lng', playerLng + PAD),
    supabase.from('bots').select('*', { count: 'exact', head: true }).eq('status', 'alive'),
  ]);

  const nearbyCount = (nearby || []).filter(b => haversine(playerLat, playerLng, b.lat, b.lng) <= 5000).length;
  if (nearbyCount >= needed) return [];
  const canSpawn = Math.max(0, GOBLIN.globalMax - (globalCount || 0));
  const toSpawn = Math.min(needed - nearbyCount, canSpawn);
  if (toSpawn <= 0) return [];

  const cosLat = Math.cos(playerLat * Math.PI / 180);
  const goblins = [];
  for (let i = 0; i < toSpawn; i++) {
    const angle = Math.random() * 2 * Math.PI;
    const distM = 500 + Math.random() * 2500;
    const lat = playerLat + Math.cos(angle) * (distM / 111000);
    const lng = playerLng + Math.sin(angle) * (distM / (111000 * (cosLat || 1)));
    goblins.push({
      type: 'goblin', category: 'evil', emoji: '👺',
      lat, lng, spawn_lat: playerLat, spawn_lng: playerLng,
      hp: GOBLIN.baseHp, max_hp: GOBLIN.baseHp, attack: GOBLIN.baseAttack,
      status: 'alive', state: 'roaming', stolen_coins: 0,
      direction: Math.random() * 2 * Math.PI,
      waypoint_lat: lat + (Math.random() - 0.5) * 0.003,
      waypoint_lng: lng + (Math.random() - 0.5) * 0.003,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  }
  const { data: inserted } = await supabase.from('bots').insert(goblins).select('*');
  return inserted || [];
}

export async function tickGoblins(supabase, allBots, allMines, nowISO) {
  if (!allBots?.length) return [];
  const updates = [];
  const mineDrains = new Map();

  for (const g of allBots) {
    const u = { id: g.id };
    const speed = GOBLIN.speed[g.state] || GOBLIN.speed.roaming;

    if (g.state === 'roaming') {
      const wpDist = Math.sqrt(Math.pow(g.waypoint_lat - g.lat, 2) + Math.pow(g.waypoint_lng - g.lng, 2));
      if (wpDist < 0.0002) {
        const a = Math.random() * 2 * Math.PI;
        u.waypoint_lat = g.lat + Math.cos(a) * (0.001 + Math.random() * 0.002);
        u.waypoint_lng = g.lng + Math.sin(a) * (0.001 + Math.random() * 0.002);
      }
      const dx = (g.waypoint_lng || g.lng) - g.lng;
      const dy = (g.waypoint_lat || g.lat) - g.lat;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      u.lat = g.lat + (dy / len) * speed;
      u.lng = g.lng + (dx / len) * speed;
      u.direction = Math.atan2(dx, dy);

      // Aggro check
      const nightChance = isNightMSK() ? 0.7 : 0.5;
      if (Math.random() < 0.15 * nightChance && allMines?.length) {
        const nearMines = allMines.filter(m => m.level > 0 && m.status === 'normal' && haversine(g.lat, g.lng, m.lat, m.lng) <= GOBLIN.aggroRadius);
        if (nearMines.length) {
          const target = nearMines[Math.floor(Math.random() * nearMines.length)];
          u.state = 'aggro';
          u.target_mine_id = target.id;
          u.last_state_change = nowISO;
          u.emoji = '👺';
        }
      }
    } else if (g.state === 'aggro') {
      const mine = allMines?.find(m => m.id === g.target_mine_id);
      if (!mine || mine.status !== 'normal' || mine.level === 0) {
        u.state = 'roaming'; u.target_mine_id = null;
        u.lat = g.lat; u.lng = g.lng;
      } else {
        const dist = haversine(g.lat, g.lng, mine.lat, mine.lng);
        if (dist < 15) {
          // Steal
          const stealingFor = Date.now() - new Date(g.last_state_change || nowISO).getTime();
          if (stealingFor >= GOBLIN.stealDuration) {
            u.state = 'fleeing'; u.last_state_change = nowISO;
            u.emoji = getGoblinEmoji({ ...g, state: 'fleeing', stolen_coins: g.stolen_coins || 0 });
          } else {
            mineDrains.set(mine.id, { owner_id: mine.owner_id });
            u.stolen_coins = (g.stolen_coins || 0) + Math.floor(GOBLIN.stealPercent * 1000);
            u.lat = g.lat; u.lng = g.lng;
          }
        } else {
          const dx = mine.lng - g.lng;
          const dy = mine.lat - g.lat;
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          u.lat = g.lat + (dy / len) * GOBLIN.speed.aggro;
          u.lng = g.lng + (dx / len) * GOBLIN.speed.aggro;
          u.direction = Math.atan2(dx, dy);
        }
      }
    } else if (g.state === 'fleeing') {
      const fleeFor = Date.now() - new Date(g.last_state_change || nowISO).getTime();
      if (fleeFor > 30000) {
        u.state = 'roaming'; u.stolen_coins = 0; u.target_mine_id = null;
        u.emoji = '👺';
      }
      const a = (g.direction || 0) + (Math.random() - 0.5) * 0.3;
      u.lat = g.lat + Math.cos(a) * GOBLIN.speed.fleeing;
      u.lng = g.lng + Math.sin(a) * GOBLIN.speed.fleeing;
      u.direction = a;
      u.emoji = getGoblinEmoji({ ...g, state: 'fleeing' });
    }

    updates.push(u);
  }

  // Apply DB updates
  await Promise.all(updates.map(u => {
    const { id, ...fields } = u;
    if (Object.keys(fields).length === 0) return Promise.resolve();
    return supabase.from('bots').update(fields).eq('id', id);
  }));

  // Drain mines (reset last_collected)
  if (mineDrains.size > 0) {
    await Promise.all([...mineDrains.keys()].map(mineId =>
      supabase.from('mines').update({ last_collected: nowISO }).eq('id', mineId)
    ));
  }

  return updates;
}
