#!/usr/bin/env node
/**
 * Overthrow Smoke Test
 * Run: node scripts/test-smoke.js
 * Checks all critical game systems via HTTP + direct imports.
 */

const BASE = 'http://localhost:3000';
const ADMIN_TG_ID = 560013667;

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, detail) {
  passed++;
  console.log(`  ✅ ${name}${detail ? ` (${detail})` : ''}`);
}

function fail(name, reason) {
  failed++;
  failures.push({ name, reason });
  console.log(`  ❌ ${name} — ${reason}`);
}

async function fetchJson(path, opts = {}) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// ══════════════════════════════════════
//  Test groups
// ══════════════════════════════════════

async function testGameState() {
  console.log('\n📊 GameState');
  try {
    const { status, data } = await fetchJson('/api/health');
    if (status === 403) { fail('health endpoint', 'Доступен только с localhost'); return; }
    if (status !== 200 || !data?.gameState) { fail('health endpoint', `status ${status}`); return; }

    const gs = data.gameState;
    gs.loaded ? ok('gameState загружен') : fail('gameState', 'не загружен');
    gs.mines > 0 ? ok('mines', `${gs.mines} шт`) : fail('mines', `пусто (${gs.mines})`);
    gs.players > 0 ? ok('players', `${gs.players} шт`) : fail('players', `пусто`);
    gs.monuments > 0 ? ok('monuments', `${gs.monuments} шт`) : fail('monuments', `пусто — не заспавнились?`);
    gs.oreNodes >= 0 ? ok('oreNodes', `${gs.oreNodes} шт`) : fail('oreNodes', `ошибка`);
    gs.items > 0 ? ok('items', `${gs.items} шт`) : fail('items', `пусто`);
    gs.markets > 0 ? ok('markets', `${gs.markets} шт`) : fail('markets', `пусто`);

    ok('uptime', `${Math.round(data.uptime)}с`);
    ok('memory', `${Math.round(data.memory / 1024 / 1024)}MB`);
  } catch (e) {
    fail('health endpoint', e.message);
  }
}

async function testApiEndpoints() {
  console.log('\n🌐 API эндпоинты');

  const tests = [
    { name: '/api/map tick', path: '/api/map', method: 'POST', body: { action: 'tick', telegram_id: ADMIN_TG_ID, lat: 55.75, lng: 37.61, north: 55.8, south: 55.7, east: 37.7, west: 37.5 } },
    { name: '/health', path: '/health' },
    { name: '/api/admin', path: '/api/admin' },
    { name: '/api/map leaderboard', path: '/api/map?view=leaderboard' },
    { name: '/api/map health', path: '/api/map?view=health' },
  ];

  for (const t of tests) {
    try {
      const { status, data } = await fetchJson(t.path, { method: t.method, body: t.body });
      if (status < 500) {
        ok(t.name, `${status}`);
      } else {
        fail(t.name, `${status} ${data?.error || 'Server Error'}`);
      }
    } catch (e) {
      fail(t.name, e.message);
    }
  }

  // POST endpoints that need telegram_id — expect 400/404, not 500
  const postTests = [
    { name: 'POST /api/bots', path: '/api/bots', body: { action: 'attack', telegram_id: ADMIN_TG_ID } },
    { name: 'POST /api/vases', path: '/api/vases', body: { action: 'break', telegram_id: ADMIN_TG_ID } },
    { name: 'POST /api/clan list', path: '/api/clan', body: { action: 'list' } },
    { name: 'POST /api/items daily-check', path: '/api/items', body: { action: 'daily-check', telegram_id: ADMIN_TG_ID } },
    { name: 'POST /api/monuments', path: '/api/monuments', body: { action: 'start-raid', telegram_id: ADMIN_TG_ID } },
    { name: 'POST /api/collectors', path: '/api/collectors', body: { action: 'build', telegram_id: ADMIN_TG_ID } },
  ];

  for (const t of postTests) {
    try {
      const { status } = await fetchJson(t.path, { method: 'POST', body: t.body });
      if (status < 500) {
        ok(t.name, `${status} (не 500)`);
      } else {
        fail(t.name, `500 Internal Server Error`);
      }
    } catch (e) {
      fail(t.name, e.message);
    }
  }
}

async function testFormulas() {
  console.log('\n🧮 Формулы');
  try {
    const { getMineIncome, getMineUpgradeCost, getMineHp, getMineHpRegen, calcHpRegen, SMALL_RADIUS, LARGE_RADIUS } = await import('../lib/formulas.js');

    // getMineIncome returns coins/sec, lv1 = 50/3600 ≈ 0.0139 (formula: 50 * level^2 / 3600)
    const inc1 = getMineIncome(1);
    (inc1 > 0.01 && inc1 < 0.02) ? ok('getMineIncome(1)', `${inc1.toFixed(4)} coins/s ≈ ${Math.round(inc1*3600)}/ч`) : fail('getMineIncome(1)', `${inc1}`);

    const inc100 = getMineIncome(100);
    (inc100 * 3600 >= 400000 && inc100 * 3600 <= 600000) ? ok('getMineIncome(100)', `${Math.round(inc100*3600)}/ч`) : fail('getMineIncome(100)', `expected ~500K, got ${Math.round(inc100*3600)}`);

    const cost1 = getMineUpgradeCost(1);
    (cost1 === 998) ? ok('getMineUpgradeCost(1)', `${cost1}`) : fail('getMineUpgradeCost(1)', `ожидали 998, получили ${cost1}`);

    const cost100 = getMineUpgradeCost(100);
    (cost100 > 100000000) ? ok('getMineUpgradeCost(100)', `${cost100.toLocaleString()}`) : fail('getMineUpgradeCost(100)', `${cost100}`);

    const hp1 = getMineHp(1);
    (hp1 >= 500) ? ok('getMineHp(1)', `${hp1}`) : fail('getMineHp(1)', `${hp1}`);

    const hp200 = getMineHp(200);
    (hp200 > 50000) ? ok('getMineHp(200)', `${hp200.toLocaleString()}`) : fail('getMineHp(200)', `${hp200}`);

    (SMALL_RADIUS === 200) ? ok('SMALL_RADIUS', '200м') : fail('SMALL_RADIUS', `${SMALL_RADIUS}`);
    (LARGE_RADIUS === 500) ? ok('LARGE_RADIUS', '500м') : fail('LARGE_RADIUS', `${LARGE_RADIUS}`);

    // HP regen: 10hp/sec
    const regen = calcHpRegen(500, 1000, new Date(Date.now() - 10000).toISOString());
    (regen >= 590 && regen <= 610) ? ok('calcHpRegen 10hp/s', `500 + 10s → ${regen}`) : fail('calcHpRegen', `ожидали ~600, получили ${regen}`);

  } catch (e) {
    fail('import formulas', e.message);
  }
}

async function testDatabase() {
  console.log('\n🗄️ База данных');
  try {
    const { supabase } = await import('../lib/supabase.js');
    const { data, error } = await supabase.from('players').select('id').limit(1);
    if (error) fail('Supabase SELECT', error.message);
    else if (data && data.length > 0) ok('Supabase отвечает', `players доступны`);
    else fail('Supabase', 'пустая таблица players');

    // Check critical tables exist
    const tables = ['monuments', 'collectors', 'monument_defenders', 'monument_loot_boxes', 'ore_nodes'];
    for (const t of tables) {
      const { error: tErr } = await supabase.from(t).select('id').limit(1);
      tErr ? fail(`таблица ${t}`, tErr.message) : ok(`таблица ${t}`);
    }
  } catch (e) {
    fail('Supabase connection', e.message);
  }
}

async function testSocketIo() {
  console.log('\n🔌 Socket.io');
  try {
    const res = await fetch(`${BASE}/socket.io/?EIO=4&transport=polling`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok || res.status === 200) {
      ok('Socket.io доступен', `порт 3000`);
    } else {
      fail('Socket.io', `status ${res.status}`);
    }
  } catch (e) {
    fail('Socket.io', e.message);
  }
}

// ══════════════════════════════════════
//  Run all
// ══════════════════════════════════════

async function main() {
  console.log('🔍 Overthrow Smoke Tests');
  console.log(`   ${new Date().toLocaleString('ru')} | ${BASE}`);

  await testGameState();
  await testApiEndpoints();
  await testFormulas();
  await testDatabase();
  await testSocketIo();

  const total = passed + failed;
  console.log('\n' + '═'.repeat(40));
  console.log(`Результат: ${passed}/${total} тестов пройдено`);
  if (failed > 0) {
    console.log(`❌ ${failed} тест(ов) провалились:`);
    for (const f of failures) {
      console.log(`   • ${f.name}: ${f.reason}`);
    }
    process.exit(1);
  } else {
    console.log('✅ Все тесты пройдены!');
    process.exit(0);
  }
}

main().catch(e => {
  console.error('💀 Fatal:', e.message);
  process.exit(1);
});
