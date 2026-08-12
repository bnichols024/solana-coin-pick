// Property tests. The scoring model runs on live, adversarial, occasionally
// malformed data, so instead of a handful of hand-picked cases these throw
// thousands of random and hostile inputs at it and assert the invariants that
// must hold for every one of them.

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePair, rejectReasons, scoreCandidate, rankCandidates } from '../src/score.js';
import { assessEntry } from '../src/entry.js';
import { usd, price, pct, age, count } from '../src/format.js';

/** Deterministic PRNG so a failure is reproducible from the seed. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const NOW = 1_760_000_000_000;

/** Random but structurally valid pair. */
function randomPair(r) {
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  return {
    chainId: 'solana',
    dexId: pick(['raydium', 'orca', 'meteora']),
    baseToken: { address: `Addr${Math.floor(r() * 1e9)}`, name: 'Rand', symbol: `R${Math.floor(r() * 1000)}` },
    priceUsd: String(r() * 10),
    priceChange: {
      m5: (r() - 0.4) * 100,
      h1: (r() - 0.4) * 400,
      h6: (r() - 0.4) * 800,
      h24: (r() - 0.4) * 3000,
    },
    volume: { m5: r() * 1e5, h1: r() * 1e6, h6: r() * 5e6, h24: r() * 2e7 },
    txns: {
      m5: { buys: Math.floor(r() * 200), sells: Math.floor(r() * 200) },
      h1: { buys: Math.floor(r() * 2000), sells: Math.floor(r() * 2000) },
      h6: { buys: Math.floor(r() * 8000), sells: Math.floor(r() * 8000) },
      h24: { buys: Math.floor(r() * 30000), sells: Math.floor(r() * 30000) },
    },
    liquidity: { usd: r() * 3e6 },
    fdv: r() * 5e7,
    marketCap: r() * 5e7,
    pairCreatedAt: NOW - Math.floor(r() * 30 * 86400e3),
  };
}

/** Deliberately hostile values that a real API might one day emit. */
const NASTY = [null, undefined, NaN, Infinity, -Infinity, 0, -1, '', 'abc', '1e999', {}, [], true];

test('scores every random candidate to a finite 0..100 with no NaN anywhere', () => {
  const r = rng(20260812);
  for (let i = 0; i < 3000; i++) {
    const c = normalizePair(randomPair(r), {}, NOW);
    const result = scoreCandidate(c);
    assert.ok(Number.isFinite(result.score), `non-finite score at iteration ${i}`);
    assert.ok(result.score >= 0 && result.score <= 100, `score ${result.score} out of range at ${i}`);
    for (const [key, part] of Object.entries(result.parts)) {
      assert.ok(Number.isFinite(part.raw), `${key} raw not finite at ${i}`);
      assert.ok(part.raw >= 0 && part.raw <= 1, `${key} raw ${part.raw} out of 0..1 at ${i}`);
    }
    assert.ok(Array.isArray(rejectReasons(c)));
  }
});

test('entry assessment is always internally consistent for random candidates', () => {
  const r = rng(777);
  for (let i = 0; i < 3000; i++) {
    const c = normalizePair(randomPair(r), {}, NOW);
    const e = assessEntry(c);
    assert.ok(typeof e.state === 'string' && e.state.length > 0, `bad state at ${i}`);
    assert.ok(typeof e.verdict === 'string' && e.verdict.length > 0, `bad verdict at ${i}`);
    if (e.state === 'unknown') { assert.equal(e.zoneLow, null); continue; }

    assert.ok(Number.isFinite(e.zoneLow), `zoneLow not finite at ${i}`);
    assert.ok(Number.isFinite(e.zoneHigh), `zoneHigh not finite at ${i}`);
    assert.ok(e.zoneLow <= e.zoneHigh, `zone inverted at ${i}: ${e.zoneLow} > ${e.zoneHigh}`);
    assert.ok(e.zoneLow >= 0, `negative entry level at ${i}`);
    assert.ok(e.maxChase > 0 && Number.isFinite(e.maxChase), `bad chase limit at ${i}`);
    assert.ok(e.invalidation >= 0 && e.invalidation < e.maxChase, `invalidation above chase limit at ${i}`);
    // Never advise entering above the current market cap.
    assert.ok(e.zoneHigh <= c.fdv * 1.0001, `entry zone above current cap at ${i}`);
  }
});

test('survives hostile values in every numeric field without throwing', () => {
  let checked = 0;
  for (const bad of NASTY) {
    const pairs = [
      { chainId: 'solana', baseToken: { address: 'A', symbol: 'X' }, priceUsd: bad, liquidity: { usd: bad }, fdv: bad },
      { chainId: 'solana', baseToken: { address: 'A', symbol: 'X' }, priceChange: { m5: bad, h1: bad, h6: bad, h24: bad }, fdv: 1e6, liquidity: { usd: 1e5 } },
      { chainId: 'solana', baseToken: { address: 'A', symbol: 'X' }, txns: { h1: { buys: bad, sells: bad }, h24: { buys: bad, sells: bad } }, fdv: 1e6 },
      { chainId: 'solana', baseToken: { address: 'A', symbol: 'X' }, volume: { h1: bad, h6: bad, h24: bad }, fdv: 1e6 },
      { chainId: 'solana', baseToken: { address: 'A', symbol: 'X' }, pairCreatedAt: bad, fdv: 1e6 },
    ];
    for (const p of pairs) {
      const c = normalizePair(p, {}, NOW);
      const s = scoreCandidate(c);
      assert.ok(Number.isFinite(s.score), `NaN score from ${String(bad)}`);
      assert.ok(Array.isArray(rejectReasons(c)));
      const e = assessEntry(c);
      assert.ok(typeof e.verdict === 'string');
      checked++;
    }
  }
  assert.equal(checked, NASTY.length * 5);
});

test('normalizePair never returns NaN in a numeric field', () => {
  const r = rng(31337);
  const numericKeys = ['priceUsd', 'liquidity', 'fdv', 'marketCap', 'vol24', 'vol6', 'vol1',
    'chg5m', 'chg1h', 'chg6h', 'chg24h', 'buys1h', 'sells1h', 'txns24', 'avgTradeUsd'];
  for (let i = 0; i < 500; i++) {
    const c = normalizePair(randomPair(r), {}, NOW);
    for (const k of numericKeys) {
      assert.ok(!Number.isNaN(c[k]), `${k} is NaN at ${i}`);
      assert.ok(typeof c[k] === 'number', `${k} is not a number at ${i}`);
    }
  }
});

test('ranking is a total order: the winner always has the top score', () => {
  const r = rng(999);
  for (let round = 0; round < 200; round++) {
    const candidates = Array.from({ length: 25 }, () => normalizePair(randomPair(r), {}, NOW));
    const { winner, scored, rejected } = rankCandidates(candidates);
    assert.equal(scored.length + rejected.length, candidates.length, 'every candidate is accounted for');
    if (!winner) continue;
    for (const s of scored) {
      assert.ok(winner.score >= s.score, `winner ${winner.score} below ${s.score}`);
    }
    for (let i = 1; i < scored.length; i++) {
      assert.ok(scored[i - 1].score >= scored[i].score, 'scored list is not descending');
    }
  }
});

test('improving one signal never lowers the score, all else equal', () => {
  const base = {
    chainId: 'solana',
    baseToken: { address: 'A', name: 'A', symbol: 'AAA' },
    priceUsd: '0.001',
    priceChange: { m5: 1, h1: 10, h6: 30, h24: 60 },
    volume: { m5: 5_000, h1: 60_000, h6: 300_000, h24: 900_000 },
    txns: {
      m5: { buys: 30, sells: 30 }, h1: { buys: 400, sells: 400 },
      h6: { buys: 1500, sells: 1500 }, h24: { buys: 4000, sells: 4000 },
    },
    liquidity: { usd: 150_000 }, fdv: 2_000_000, marketCap: 2_000_000,
    pairCreatedAt: NOW - 12 * 3600e3,
  };
  const scoreOf = (over) => scoreCandidate(normalizePair({ ...base, ...over }, {}, NOW)).score;
  const baseline = scoreOf({});

  // More buyers, faster momentum, more volume and a smaller cap must each help.
  assert.ok(scoreOf({ txns: { ...base.txns, h1: { buys: 800, sells: 200 }, h6: { buys: 2500, sells: 500 } } }) > baseline, 'buy pressure');
  assert.ok(scoreOf({ priceChange: { m5: 3, h1: 25, h6: 30, h24: 60 } }) > baseline, 'momentum');
  assert.ok(scoreOf({ volume: { ...base.volume, h1: 300_000 } }) > baseline, 'velocity');
  assert.ok(scoreOf({ fdv: 300_000, marketCap: 300_000 }) > baseline, 'headroom');
  assert.ok(scoreOf({}) === baseline, 'scoring is deterministic');
});

test('formatters never throw and never emit NaN or undefined', () => {
  const inputs = [...NASTY, 1e21, -1e21, 1e-12, 0.5, 12345.6789];
  for (const v of inputs) {
    for (const [name, fn] of Object.entries({ usd, price, pct, age, count })) {
      const out = fn(v);
      assert.equal(typeof out, 'string', `${name}(${String(v)}) is not a string`);
      assert.ok(!/NaN|undefined|Infinity/.test(out), `${name}(${String(v)}) produced "${out}"`);
    }
  }
});
