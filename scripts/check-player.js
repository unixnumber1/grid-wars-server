#!/usr/bin/env node
// Usage: node scripts/check-player.js <username>
import dotenv from 'dotenv';
dotenv.config();
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const username = process.argv[2] || 'pakenrol';

async function main() {
  const client = await pool.connect();
  try {
    // Find player
    const { rows: players } = await client.query(
      `SELECT id, telegram_id, game_username, username, level, xp, coins, diamonds, crystals, ether,
              last_lat, last_lng, last_seen, created_at, is_banned, ban_reason, ban_until
       FROM players WHERE game_username = $1 OR username = $1`, [username]
    );
    if (!players.length) { console.log('Player not found:', username); return; }
    const p = players[0];
    console.log('=== PLAYER ===');
    console.log(`Name: ${p.game_username || p.username} | TG: ${p.telegram_id} | ID: ${p.id}`);
    console.log(`Level: ${p.level} | XP: ${p.xp} | Coins: ${p.coins} | Diamonds: ${p.diamonds}`);
    console.log(`Crystals: ${p.crystals} | Ether: ${p.ether}`);
    console.log(`Last pos: ${p.last_lat}, ${p.last_lng} | Last seen: ${p.last_seen}`);
    console.log(`Created: ${p.created_at} | Banned: ${p.is_banned} (${p.ban_reason || '-'})`);

    // Mines count
    const { rows: mines } = await client.query(
      `SELECT COUNT(*) as cnt, MAX(level) as max_lvl FROM mines WHERE owner_id = $1 AND status != 'destroyed'`, [p.id]
    );
    console.log(`\n=== MINES === Count: ${mines[0].cnt} | Max level: ${mines[0].max_lvl}`);

    // Spoof violations from logs
    const { rows: spoofLogs } = await client.query(
      `SELECT message, data, created_at FROM player_logs
       WHERE player_id = $1 AND type = 'spoof'
       ORDER BY created_at DESC LIMIT 20`, [p.telegram_id]
    );
    if (spoofLogs.length) {
      console.log(`\n=== SPOOF VIOLATIONS (${spoofLogs.length}) ===`);
      for (const l of spoofLogs) {
        const d = typeof l.data === 'string' ? JSON.parse(l.data) : l.data;
        console.log(`  ${l.created_at} | ${l.message} | speed=${d?.speed?.toFixed(0)||'?'}km/h dist=${d?.distance?.toFixed(2)||'?'}km type=${d?.type||'?'}`);
        if (d?.from && d?.to) console.log(`    from: ${d.from.lat?.toFixed(4)},${d.from.lng?.toFixed(4)} → to: ${d.to.lat?.toFixed(4)},${d.to.lng?.toFixed(4)}`);
      }
    } else {
      console.log('\n=== SPOOF VIOLATIONS: none ===');
    }

    // Recent actions
    const { rows: actions } = await client.query(
      `SELECT type, message, created_at FROM player_logs
       WHERE player_id = $1 AND type = 'action'
       ORDER BY created_at DESC LIMIT 30`, [p.telegram_id]
    );
    if (actions.length) {
      console.log(`\n=== RECENT ACTIONS (${actions.length}) ===`);
      for (const a of actions) {
        console.log(`  ${a.created_at} | ${a.message}`);
      }
    }

    // Position history from logs (location updates)
    const { rows: posLogs } = await client.query(
      `SELECT data, created_at FROM player_logs
       WHERE player_id = $1 AND type IN ('location', 'spoof')
       ORDER BY created_at DESC LIMIT 30`, [p.telegram_id]
    );
    if (posLogs.length) {
      console.log(`\n=== POSITION HISTORY (${posLogs.length}) ===`);
      for (const l of posLogs) {
        const d = typeof l.data === 'string' ? JSON.parse(l.data) : l.data;
        if (d?.from && d?.to) {
          console.log(`  ${l.created_at} | ${d.from.lat?.toFixed(5)},${d.from.lng?.toFixed(5)} → ${d.to.lat?.toFixed(5)},${d.to.lng?.toFixed(5)} (${d?.speed?.toFixed(0)||'?'}km/h)`);
        }
      }
    }

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
