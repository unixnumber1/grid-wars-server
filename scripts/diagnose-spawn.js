#!/usr/bin/env node
// Usage: node scripts/diagnose-spawn.js [username]
// Shows spawn coverage for a player or finds all uncovered players
import dotenv from 'dotenv';
dotenv.config();
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const username = process.argv[2];

// Haversine in meters
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function main() {
  const client = await pool.connect();
  try {
    // If username given, show detailed info for that player
    if (username) {
      const { rows } = await client.query(
        `SELECT telegram_id, game_username, last_lat, last_lng, level, last_seen
         FROM players WHERE game_username ILIKE $1 OR username ILIKE $1 OR telegram_id::text = $1`,
        [username]
      );
      if (!rows.length) { console.log('Player not found:', username); return; }
      const p = rows[0];
      console.log(`=== ${p.game_username} (tg:${p.telegram_id}, lv${p.level}) ===`);
      console.log(`Position: ${p.last_lat}, ${p.last_lng}`);
      console.log(`Last seen: ${p.last_seen}`);

      for (const radius of [1, 3, 5, 10]) {
        const dLat = radius / 111;
        const dLng = radius / (111 * Math.cos(p.last_lat * Math.PI / 180));
        const { rows: ores } = await client.query(
          `SELECT COUNT(*) as cnt FROM ore_nodes WHERE expires_at > NOW()
           AND lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4`,
          [p.last_lat - dLat, p.last_lat + dLat, p.last_lng - dLng, p.last_lng + dLng]
        );
        const { rows: vases } = await client.query(
          `SELECT COUNT(*) as cnt FROM vases WHERE expires_at > NOW() AND broken_by IS NULL
           AND lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4`,
          [p.last_lat - dLat, p.last_lat + dLat, p.last_lng - dLng, p.last_lng + dLng]
        );
        console.log(`  ${radius}km: ${ores[0].cnt} ores, ${vases[0].cnt} vases`);
      }

      // Nearest ore/vase
      const { rows: nearOres } = await client.query(
        `SELECT lat, lng, ore_type, level FROM ore_nodes WHERE expires_at > NOW()
         ORDER BY (lat - $1)^2 + (lng - $2)^2 LIMIT 3`,
        [p.last_lat, p.last_lng]
      );
      console.log('\nNearest ores:');
      for (const o of nearOres) {
        const dist = haversine(p.last_lat, p.last_lng, o.lat, o.lng);
        console.log(`  ${o.ore_type} lv${o.level} at ${(dist / 1000).toFixed(1)}km`);
      }

      const { rows: nearVases } = await client.query(
        `SELECT lat, lng FROM vases WHERE expires_at > NOW() AND broken_by IS NULL
         ORDER BY (lat - $1)^2 + (lng - $2)^2 LIMIT 3`,
        [p.last_lat, p.last_lng]
      );
      console.log('\nNearest vases:');
      for (const v of nearVases) {
        const dist = haversine(p.last_lat, p.last_lng, v.lat, v.lng);
        console.log(`  at ${(dist / 1000).toFixed(1)}km`);
      }

      // Check Overpass for this area
      console.log('\nChecking Overpass road data...');
      const PAD = 0.018;
      const bbox = `${p.last_lat - PAD},${p.last_lng - PAD},${p.last_lat + PAD},${p.last_lng + PAD}`;
      try {
        const resp = await fetch(
          `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(`[out:json][timeout:15];(way["highway"="residential"](${bbox});way["highway"="living_street"](${bbox});way["highway"="tertiary"](${bbox});way["highway"="pedestrian"](${bbox});way["highway"="secondary"](${bbox});way["highway"="unclassified"](${bbox});way["highway"="service"](${bbox}););out center 100;`)}`,
          { signal: AbortSignal.timeout(20000) }
        );
        const data = await resp.json();
        console.log(`  Road points in 2km zone: ${data.elements?.length ?? 0}`);
      } catch (e) {
        console.log(`  Overpass error: ${e.message}`);
      }
      return;
    }

    // No username — find all uncovered players
    console.log('=== Finding uncovered players (active in 7d, level >= 5) ===\n');

    const { rows: players } = await client.query(
      `SELECT telegram_id, game_username, last_lat, last_lng, level
       FROM players WHERE last_lat IS NOT NULL AND last_lng IS NOT NULL
         AND last_seen > NOW() - INTERVAL '7 days' AND level >= 5
       ORDER BY level DESC`
    );

    const { rows: ores } = await client.query(`SELECT lat, lng FROM ore_nodes WHERE expires_at > NOW()`);
    const { rows: vases } = await client.query(`SELECT lat, lng FROM vases WHERE expires_at > NOW() AND broken_by IS NULL`);

    console.log(`Total: ${players.length} active players, ${ores.length} ores, ${vases.length} vases\n`);

    const noVases = [];
    const noOres = [];
    const noBoth = [];

    for (const p of players) {
      let nearestOre = Infinity, nearestVase = Infinity;
      for (const o of ores) {
        const d = haversine(p.last_lat, p.last_lng, o.lat, o.lng);
        if (d < nearestOre) nearestOre = d;
        if (nearestOre < 3000) break;
      }
      for (const v of vases) {
        const d = haversine(p.last_lat, p.last_lng, v.lat, v.lng);
        if (d < nearestVase) nearestVase = d;
        if (nearestVase < 3000) break;
      }

      const hasOre = nearestOre < 3000;
      const hasVase = nearestVase < 3000;
      if (!hasOre && !hasVase) noBoth.push({ ...p, nearestOre, nearestVase });
      else if (!hasVase) noVases.push({ ...p, nearestVase });
      else if (!hasOre) noOres.push({ ...p, nearestOre });
    }

    if (noBoth.length) {
      console.log(`NO ORES + NO VASES (${noBoth.length}):`);
      for (const p of noBoth) {
        console.log(`  ${p.game_username} lv${p.level} (${p.last_lat.toFixed(3)}, ${p.last_lng.toFixed(3)}) — nearest ore: ${(p.nearestOre / 1000).toFixed(1)}km, vase: ${(p.nearestVase / 1000).toFixed(1)}km`);
      }
    }

    if (noVases.length) {
      console.log(`\nNO VASES in 3km (${noVases.length}):`);
      for (const p of noVases.slice(0, 20)) {
        console.log(`  ${p.game_username} lv${p.level} (${p.last_lat.toFixed(3)}, ${p.last_lng.toFixed(3)}) — nearest vase: ${(p.nearestVase / 1000).toFixed(1)}km`);
      }
      if (noVases.length > 20) console.log(`  ... and ${noVases.length - 20} more`);
    }

    if (noOres.length) {
      console.log(`\nNO ORES in 3km (${noOres.length}):`);
      for (const p of noOres) {
        console.log(`  ${p.game_username} lv${p.level} (${p.last_lat.toFixed(3)}, ${p.last_lng.toFixed(3)}) — nearest ore: ${(p.nearestOre / 1000).toFixed(1)}km`);
      }
    }

    const covered = players.length - noBoth.length - noVases.length - noOres.length;
    console.log(`\n=== Summary ===`);
    console.log(`Fully covered: ${covered}/${players.length}`);
    console.log(`No vases: ${noVases.length + noBoth.length}`);
    console.log(`No ores: ${noOres.length + noBoth.length}`);
    console.log(`No both: ${noBoth.length}`);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
