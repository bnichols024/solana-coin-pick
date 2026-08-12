// Tests for the browser-state modules (cache + history). They talk to
// localStorage, so we install a minimal fake before importing them.

import test from 'node:test';
import assert from 'node:assert/strict';

class FakeStorage {
  constructor({ failWrites = false } = {}) {
    this.map = new Map();
    this.failWrites = failWrites;
  }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.map.set(k, String(v));
  }
  removeItem(k) { this.map.delete(k); }
}

globalThis.localStorage = new FakeStorage();

const { cacheGet, cacheSet, cached, cacheClear, pruneExpired } = await import('../src/cache.js');
const { loadHistory, recordPick, gradeHistory, clearHistory } = await import('../src/history.js');

const T0 = 1_760_000_000_000;

test('cache stores and returns a value inside its TTL', () => {
  cacheClear();
  cacheSet('k', { a: 1 }, 1000, T0);
  assert.deepEqual(cacheGet('k', T0 + 999), { a: 1 });
});

test('cache expires a value past its TTL', () => {
  cacheClear();
  cacheSet('k', 'v', 1000, T0);
  assert.equal(cacheGet('k', T0 + 1001), undefined);
});

test('cached() runs the producer once, then serves from cache', async () => {
  cacheClear();
  let calls = 0;
  const produce = async () => { calls++; return 'result'; };
  assert.equal(await cached('p', 5000, produce, T0), 'result');
  assert.equal(await cached('p', 5000, produce, T0 + 100), 'result');
  assert.equal(calls, 1);
  // ...and re-runs it once the entry has expired.
  assert.equal(await cached('p', 5000, produce, T0 + 6000), 'result');
  assert.equal(calls, 2);
});

test('cache survives corrupt stored JSON', () => {
  cacheClear();
  globalThis.localStorage.setItem('scp:bad', '{not json');
  assert.equal(cacheGet('bad', T0), undefined);
});

test('cache still works in memory when storage refuses writes', () => {
  const real = globalThis.localStorage;
  globalThis.localStorage = new FakeStorage({ failWrites: true });
  cacheClear();
  cacheSet('mem', 'value', 1000, T0);
  assert.equal(cacheGet('mem', T0 + 500), 'value');
  globalThis.localStorage = real;
});

test('pruneExpired removes only expired entries', () => {
  cacheClear();
  cacheSet('fresh', 1, 10_000, T0);
  cacheSet('stale', 2, 100, T0);
  pruneExpired(T0 + 5000);
  assert.equal(cacheGet('fresh', T0 + 5000), 1);
  assert.equal(cacheGet('stale', T0 + 5000), undefined);
});

// --- history ---------------------------------------------------------------

const coin = (over = {}) => ({
  address: 'AddrOne1111111111111111111111111111111111',
  symbol: 'ONE', name: 'One Coin', fdv: 1_000_000, priceUsd: 0.001, ...over,
});

test('recordPick stores a pick and loadHistory returns it', () => {
  clearHistory();
  recordPick(coin(), 80, 'buy_now', T0);
  const list = loadHistory();
  assert.equal(list.length, 1);
  assert.equal(list[0].symbol, 'ONE');
  assert.equal(list[0].pickedMc, 1_000_000);
  assert.equal(list[0].score, 80);
});

test('re-picking the same coin within six hours does not double-record', () => {
  clearHistory();
  recordPick(coin(), 80, 'buy_now', T0);
  recordPick(coin({ fdv: 3_000_000 }), 90, 'buy_now', T0 + 3600_000);
  const list = loadHistory();
  assert.equal(list.length, 1);
  assert.equal(list[0].pickedMc, 1_000_000, 'original entry price is what we grade against');
});

test('the same coin re-picked much later is a new entry', () => {
  clearHistory();
  recordPick(coin(), 80, 'buy_now', T0);
  recordPick(coin(), 80, 'buy_now', T0 + 7 * 3600_000);
  assert.equal(loadHistory().length, 2);
});

test('a pick with no market cap is ignored rather than stored as junk', () => {
  clearHistory();
  recordPick(coin({ fdv: 0 }), 80, 'buy_now', T0);
  assert.equal(loadHistory().length, 0);
});

test('gradeHistory computes multiples, wins, rugs and the median', () => {
  const history = [
    { address: 'a', symbol: 'A', pickedAt: T0, pickedMc: 100 },
    { address: 'b', symbol: 'B', pickedAt: T0, pickedMc: 100 },
    { address: 'c', symbol: 'C', pickedAt: T0, pickedMc: 100 },
    { address: 'd', symbol: 'D', pickedAt: T0, pickedMc: 100 },
  ];
  const current = new Map([
    ['a', { fdv: 300 }],   // 3x   -> win
    ['b', { fdv: 10 }],    // 0.1x -> rug
    ['c', { fdv: 120 }],   // 1.2x -> neither
    // d missing entirely -> ungraded
  ]);
  const { rows, stats } = gradeHistory(history, current, T0 + 3600_000);

  assert.equal(rows.length, 4);
  assert.equal(stats.graded, 3);
  assert.equal(stats.wins, 1);
  assert.equal(stats.rugs, 1);
  assert.equal(stats.best, 3);
  assert.equal(stats.median, 1.2);
  assert.equal(rows[3].multiple, null, 'a coin with no live data stays ungraded');
  assert.equal(rows[0].changePct, 200);
});

test('gradeHistory tolerates an empty history and an empty price map', () => {
  const { rows, stats } = gradeHistory([], new Map(), T0);
  assert.deepEqual(rows, []);
  assert.equal(stats.graded, 0);
  assert.equal(stats.median, null);
  assert.equal(stats.best, null);
});

test('loadHistory ignores corrupt storage instead of throwing', () => {
  clearHistory();
  globalThis.localStorage.setItem('scp:history', '{"not":"an array"}');
  assert.deepEqual(loadHistory(), []);
  globalThis.localStorage.setItem('scp:history', 'not json at all');
  assert.deepEqual(loadHistory(), []);
});
