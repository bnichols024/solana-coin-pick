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

// --- calibration -----------------------------------------------------------

const { calibration } = await import('../src/history.js');

const graded = (score, multiple) => ({ score, multiple, address: `a${score}${multiple}` });

test('calibration stays hidden until there is enough data to mean anything', () => {
  const few = Array.from({ length: 5 }, (_, i) => graded(80, 1 + i));
  const cal = calibration(few);
  assert.equal(cal.ready, false);
  assert.equal(cal.needed, 3);
  assert.deepEqual(cal.buckets, []);
});

test('calibration ignores ungraded rows when counting', () => {
  const rows = [...Array.from({ length: 6 }, () => graded(80, 2)), { score: 80, multiple: null }, { score: 80, multiple: null }];
  assert.equal(calibration(rows).ready, false, 'only graded picks count toward the threshold');
});

test('calibration reports the median multiple per score band', () => {
  const rows = [
    graded(90, 3), graded(80, 5), graded(75, 1),          // 70+ -> median 3
    graded(60, 2), graded(58, 1), graded(56, 1.5),        // 55-70 -> median 1.5
    graded(40, 0.5), graded(30, 0.1), graded(20, 0.3),    // under 55 -> median 0.3
  ];
  const cal = calibration(rows);
  assert.equal(cal.ready, true);
  const byLabel = Object.fromEntries(cal.buckets.map((b) => [b.label, b]));
  assert.equal(byLabel['70+'].median, 3);
  assert.equal(byLabel['70+'].n, 3);
  assert.equal(byLabel['55–70'].median, 1.5);
  assert.equal(byLabel['under 55'].median, 0.3);
});

test('calibration says so when the model is holding up', () => {
  const rows = [
    graded(90, 4), graded(85, 3), graded(80, 5),
    graded(60, 1.2), graded(58, 1.1), graded(56, 1.3),
    graded(40, 0.4), graded(30, 0.2), graded(20, 0.5),
  ];
  assert.match(calibration(rows).verdict, /holding up/);
});

test('calibration says so when high scores are doing worse', () => {
  const rows = [
    graded(90, 0.2), graded(85, 0.1), graded(80, 0.3),
    graded(60, 2), graded(58, 3), graded(56, 2.5),
    graded(40, 1.8), graded(30, 1.9), graded(20, 2.1),
  ];
  assert.match(calibration(rows).verdict, /suspicion/, 'the app must be willing to say it is wrong');
});

test('calibration drops empty bands rather than showing dashes', () => {
  const rows = Array.from({ length: 9 }, (_, i) => graded(90 - i * 0.1, 2));
  const cal = calibration(rows);
  assert.equal(cal.buckets.length, 1, 'only the populated band appears');
  assert.equal(cal.buckets[0].label, '70+');
});

// --- peak tracking ---------------------------------------------------------
// The diagnostic that separates "found a runner, missed the exit" from
// "picked something that only ever went down". They need opposite fixes.

test('a pick that ran then died is distinguished from one that never ran', () => {
  const history = [
    { address: 'ran', symbol: 'RAN', pickedAt: T0, pickedMc: 100_000, pickedPrice: 0.001 },
    { address: 'dead', symbol: 'DEAD', pickedAt: T0, pickedMc: 100_000, pickedPrice: 0.001 },
  ];
  const current = new Map([
    ['ran', { fdv: 10_000 }],   // now -90%...
    ['dead', { fdv: 10_000 }],  // ...identical on the "now" column
  ]);
  const peaks = new Map([
    ['ran', 0.005],   // peaked at 5x the pick price
    ['dead', 0.0011], // never went anywhere
  ]);

  const { rows, stats } = gradeHistory(history, current, T0 + 3600_000, peaks);
  assert.equal(rows[0].multiple, 0.1);
  assert.equal(rows[1].multiple, 0.1, 'both look identical on result alone');
  assert.equal(rows[0].peakMultiple, 5, 'but one of them was a 5x');
  assert.ok(Math.abs(rows[1].peakMultiple - 1.1) < 1e-9);
  assert.equal(rows[0].peakMc, 500_000);
  assert.equal(stats.everRan, 1, 'exactly one ever ran');
});

test('peak is never below the current result', () => {
  // A coin still at its high has no OHLCV peak above spot; the peak must not
  // read as lower than where it is now.
  const history = [{ address: 'up', symbol: 'UP', pickedAt: T0, pickedMc: 100, pickedPrice: 1 }];
  const current = new Map([['up', { fdv: 300 }]]);
  const { rows } = gradeHistory(history, current, T0, new Map([['up', 1.2]]));
  assert.equal(rows[0].peakMultiple, 3, 'falls back to the live multiple when it is higher');
});

test('a missing peak leaves the row ungraded rather than claiming 1x', () => {
  const history = [{ address: 'x', symbol: 'X', pickedAt: T0, pickedMc: 100, pickedPrice: 1 }];
  const { rows, stats } = gradeHistory(history, new Map([['x', { fdv: 50 }]]), T0, new Map());
  assert.equal(rows[0].peakMultiple, null);
  assert.equal(rows[0].peakMc, null);
  assert.equal(stats.medianPeak, null);
});

test('a pick with no recorded price cannot fake a peak', () => {
  const history = [{ address: 'x', symbol: 'X', pickedAt: T0, pickedMc: 100, pickedPrice: 0 }];
  const { rows } = gradeHistory(history, new Map([['x', { fdv: 50 }]]), T0, new Map([['x', 9]]));
  assert.equal(rows[0].peakMultiple, null);
});

// --- calibration honesty ---------------------------------------------------

test('calibration refuses to call a losing model healthy', () => {
  // The real failure this caught: both bands down ~61%, ranked 0.39 above
  // 0.38, and the panel reported "the model is holding up".
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => graded(60 + i, 0.39)),
    ...Array.from({ length: 5 }, (_, i) => graded(40 + i, 0.38)),
  ];
  const cal = calibration(rows);
  assert.ok(!/holding up/.test(cal.verdict), `must not claim success: "${cal.verdict}"`);
  assert.match(cal.verdict, /losing money/);
  assert.match(cal.verdict, /down \d+%/, 'states the actual damage as a number');
});

test('calibration still reports a genuinely healthy model as healthy', () => {
  const rows = [
    ...Array.from({ length: 5 }, () => graded(80, 3)),
    ...Array.from({ length: 5 }, () => graded(40, 1.1)),
  ];
  assert.match(calibration(rows).verdict, /holding up/);
});
