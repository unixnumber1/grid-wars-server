import { haversine } from './haversine.js';

export const GOBLIN = {
  emoji: '👺',
  baseHp: 50,
  baseAttack: 15,
  aggroRadius: 2000,
  stealPercent: 0.15,
  stealMinLeft: 0.10,
  stealDuration: 15000,
  maxPerZone: 2,
  globalMax: 50,
  xpReward: 75,
  dropDiamonds: [1, 3],
};

// Speed in degrees per tick (~5s)
const SPEED = {
  roaming: 0.00005,  // ~5m
  aggro:   0.0001,   // ~10m
  fleeing: 0.00008,  // ~8m
};

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function moveTowards(fromLat, fromLng, toLat, toLng, speed) {
  const dx = toLng - fromLng;
  const dy = toLat - fromLat;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < speed) return { lat: toLat, lng: toLng };
  return { lat: fromLat + (dy / dist) * speed, lng: fromLng + (dx / dist) * speed };
}

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
  const nowISO = new Date().toISOString();

  const PAD = 0.05;
  const [{ data: nearby }, { count: globalCount }] = await Promise.all([
    supabase.from('bots').select('id,lat,lng').eq('status', 'alive')
      .gt('expires_at', nowISO)
      .gte('lat', playerLat - PAD).lte('lat', playerLat + PAD)
      .gte('lng', playerLng - PAD).lte('lng', playerLng + PAD),
    supabase.from('bots').select('*', { count: 'exact', head: true }).eq('status', 'alive').gt('expires_at', nowISO),
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
    // Waypoint 200-400m away
    const wpAngle = Math.random() * 2 * Math.PI;
    const wpDist = 0.002 + Math.random() * 0.002;
    goblins.push({
      type: 'goblin', category: 'evil', emoji: '👺',
      lat, lng, spawn_lat: playerLat, spawn_lng: playerLng,
      hp: GOBLIN.baseHp, max_hp: GOBLIN.baseHp, attack: GOBLIN.baseAttack,
      status: 'alive', state: 'roaming', stolen_coins: 0,
      direction: angle,
      waypoint_lat: lat + Math.cos(wpAngle) * wpDist,
      waypoint_lng: lng + Math.sin(wpAngle) * wpDist,
      last_state_change: nowISO,
      expires_at: new Date(Date.now() + SEVEN_DAYS_MS).toISOString(),
    });
  }
  const { data: inserted } = await supabase.from('bots').insert(goblins).select('*');
  return inserted || [];
}

export async function tickGoblins(supabase, allBots, allMines, nowISO) {
  if (!allBots?.length) return [];
  console.log(`[goblins] tick: ${allBots.length} goblins, ${(allMines || []).length} mines`);
  const updates = [];
  const mineDrains = new Map();

  for (const g of allBots) {
    const u = { id: g.id };

    if (g.state === 'roaming') {
      // Check if waypoint reached (< 20m)
      const wpLat = g.waypoint_lat ?? g.lat;
      const wpLng = g.waypoint_lng ?? g.lng;
      const distToWp = haversine(g.lat, g.lng, wpLat, wpLng);

      if (distToWp < 20 || !g.waypoint_lat) {
        // Pick new waypoint 200-400m away
        const a = Math.random() * 2 * Math.PI;
        const d = 0.002 + Math.random() * 0.002;
        u.waypoint_lat = g.lat + Math.cos(a) * d;
        u.waypoint_lng = g.lng + Math.sin(a) * d;
      }

      // Move towards waypoint
      const tgtLat = u.waypoint_lat ?? wpLat;
      const tgtLng = u.waypoint_lng ?? wpLng;
      const pos = moveTowards(g.lat, g.lng, tgtLat, tgtLng, SPEED.roaming);
      u.lat = pos.lat;
      u.lng = pos.lng;
      u.direction = Math.atan2(tgtLng - g.lng, tgtLat - g.lat);

      // Aggro check — high chance, goblins are aggressive
      const aggroChance = isNightMSK() ? 0.5 : 0.3;
      if (Math.random() < aggroChance && allMines?.length) {
        const nearMines = allMines.filter(m =>
          m.level > 0 && m.status === 'normal' &&
          haversine(g.lat, g.lng, m.lat, m.lng) <= GOBLIN.aggroRadius
        );
        if (nearMines.length) {
          const target = nearMines[Math.floor(Math.random() * nearMines.length)];
          u.state = 'aggro';
          u.target_mine_id = target.id;
          u.last_state_change = nowISO;
          console.log(`[goblins] ${g.id.slice(0,8)} AGGRO → mine ${target.id.slice(0,8)} (${Math.round(haversine(g.lat, g.lng, target.lat, target.lng))}m)`);
        }
      }

    } else if (g.state === 'aggro') {
      const mine = allMines?.find(m => m.id === g.target_mine_id);
      if (!mine || mine.status !== 'normal' || mine.level === 0) {
        u.state = 'roaming';
        u.target_mine_id = null;
      } else {
        const dist = haversine(g.lat, g.lng, mine.lat, mine.lng);
        if (dist < 15) {
          // At mine — stealing
          const stealingFor = Date.now() - new Date(g.last_state_change || nowISO).getTime();
          if (stealingFor >= GOBLIN.stealDuration) {
            u.state = 'fleeing';
            u.last_state_change = nowISO;
            u.direction = Math.atan2(g.lng - mine.lng, g.lat - mine.lat); // away from mine
            u.emoji = getGoblinEmoji({ ...g, state: 'fleeing', stolen_coins: g.stolen_coins || 0 });
          } else {
            mineDrains.set(mine.id, { owner_id: mine.owner_id });
            u.stolen_coins = (g.stolen_coins || 0) + Math.floor(GOBLIN.stealPercent * 1000);
          }
        } else {
          // Move towards mine
          const pos = moveTowards(g.lat, g.lng, mine.lat, mine.lng, SPEED.aggro);
          u.lat = pos.lat;
          u.lng = pos.lng;
          u.direction = Math.atan2(mine.lng - g.lng, mine.lat - g.lat);
        }
      }

    } else if (g.state === 'fleeing') {
      const fleeFor = Date.now() - new Date(g.last_state_change || nowISO).getTime();
      if (fleeFor > 30000) {
        u.state = 'roaming';
        u.stolen_coins = 0;
        u.target_mine_id = null;
        u.emoji = '👺';
      } else {
        // Move in current direction with slight wander
        const dir = (g.direction || 0) + (Math.random() - 0.5) * 0.3;
        u.lat = g.lat + Math.cos(dir) * SPEED.fleeing;
        u.lng = g.lng + Math.sin(dir) * SPEED.fleeing;
        u.direction = dir;
        u.emoji = getGoblinEmoji({ ...g, state: 'fleeing' });
      }
    }

    updates.push(u);
  }

  // Batch DB updates
  await Promise.all(updates.map(u => {
    const { id, ...fields } = u;
    if (Object.keys(fields).length === 0) return Promise.resolve();
    return supabase.from('bots').update(fields).eq('id', id);
  }));

  // Drain mines
  if (mineDrains.size > 0) {
    await Promise.all([...mineDrains.keys()].map(mineId =>
      supabase.from('mines').update({ last_collected: nowISO }).eq('id', mineId)
    ));
  }

  return updates;
}
