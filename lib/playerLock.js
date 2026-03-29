// Per-player async mutex — prevents race conditions on currency operations
// JavaScript is single-threaded but await yields, allowing parallel requests
// for the same player to interleave and read stale balances.

const _locks = new Map(); // telegramId -> Promise chain

export async function withPlayerLock(telegramId, fn) {
  const key = String(telegramId);
  const prev = _locks.get(key) || Promise.resolve();
  let resolve;
  const next = new Promise(r => { resolve = r; });
  _locks.set(key, next);

  try {
    await prev; // wait for previous operation on this player
    return await fn();
  } finally {
    resolve();
    // Cleanup if no more pending
    if (_locks.get(key) === next) _locks.delete(key);
  }
}
