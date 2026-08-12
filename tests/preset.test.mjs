import test from 'node:test';
import assert from 'node:assert/strict';

import { PRESETS, resolvePreset, CONFIG } from '../src/config.js';
import { normalizePair, rankCandidates, scale, logScale } from '../src/score.js';
import * as fx from './fixtures.js';

const norm = (pair) => normalizePair(pair, {}, fx.NOW);

test('resolvePreset falls back to balanced for unknown or missing names', () => {
  for (const bad of [undefined, null, '', 'nonsense', 42]) {
    assert.equal(resolvePreset(bad).name, 'balanced');
  }
});

test('balanced resolves to the shipped defaults', () => {
  const p = resolvePreset('balanced');
  assert.deepEqual(p.filters, CONFIG.filters);
  assert.deepEqual(p.weights, CONFIG.weights);
});

test('every preset is complete and its weights sum to 1', () => {
  for (const [name, preset] of Object.entries(PRESETS)) {
    const r = resolvePreset(name);
    assert.ok(r.label && r.blurb, `${name} needs a label and blurb`);
    const sum = Object.values(r.weights).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${name} weights sum to ${sum}, not 1`);
    // A preset must never drop a signal the engine expects.
    assert.deepEqual(Object.keys(r.weights).sort(), Object.keys(CONFIG.weights).sort(), `${name} weight keys`);
    for (const key of Object.keys(CONFIG.filters)) {
      assert.ok(key in r.filters, `${name} is missing filter ${key}`);
    }
  }
});

test('cautious is strictly stricter than degen on the size filters', () => {
  const safe = resolvePreset('safe').filters;
  const degen = resolvePreset('degen').filters;
  assert.ok(safe.minLiquidityUsd > degen.minLiquidityUsd);
  assert.ok(safe.maxFdvUsd > degen.maxFdvUsd, 'degen hunts smaller caps');
  assert.ok(safe.minTxns24h > degen.minTxns24h);
  assert.ok(safe.minPairAgeMinutes > degen.minPairAgeMinutes);
});

test('a thin micro cap passes degen but fails cautious', () => {
  const micro = norm({
    ...fx.goodRunner,
    liquidity: { usd: 25_000 },
    fdv: 600_000, marketCap: 600_000,
    volume: { m5: 8_000, h1: 60_000, h6: 150_000, h24: 300_000 },
    txns: { m5: { buys: 20, sells: 8 }, h1: { buys: 160, sells: 70 }, h6: { buys: 400, sells: 220 }, h24: { buys: 700, sells: 400 } },
  });
  const inDegen = rankCandidates([micro], resolvePreset('degen'));
  const inSafe = rankCandidates([micro], resolvePreset('safe'));
  assert.equal(inDegen.scored.length, 1, 'degen should accept it');
  assert.equal(inSafe.scored.length, 0, 'cautious should reject it');
  assert.ok(inSafe.rejected[0].reasons.length > 0);
});

test('presets change the ranking, not just the filtering', () => {
  const candidates = [fx.goodRunner, fx.mediocre].map(norm);
  const degen = rankCandidates(candidates, resolvePreset('degen'));
  const safe = rankCandidates(candidates, resolvePreset('safe'));
  // The same coin can score differently under different weightings.
  const degenTop = degen.scored[0];
  const safeTop = safe.scored.find((s) => s.candidate.symbol === degenTop?.candidate.symbol);
  if (degenTop && safeTop) {
    assert.notEqual(degenTop.score, safeTop.score, 'weights should move the score');
  }
});

test('headroom rescales with the preset cap ceiling', () => {
  const coin = norm({ ...fx.goodRunner, fdv: 2_000_000, marketCap: 2_000_000 });
  const degen = rankCandidates([coin], resolvePreset('degen')).scored[0];
  const balanced = rankCandidates([coin], resolvePreset('balanced')).scored[0];
  // $2M is near degen's $4M ceiling but tiny against balanced's $30M one.
  assert.ok(degen.parts.headroom.raw < balanced.parts.headroom.raw);
});

// --- Gamble tier -----------------------------------------------------------

test('gamble caps market cap at $50K and accepts far thinner pools', () => {
  const g = resolvePreset('gamble').filters;
  const d = resolvePreset('degen').filters;
  assert.equal(g.maxFdvUsd, 50_000, 'the whole point of the tier');
  assert.ok(g.minLiquidityUsd < d.minLiquidityUsd);
  assert.ok(g.minVolume24hUsd < d.minVolume24hUsd);
  assert.ok(g.minTxns24h < d.minTxns24h);
  assert.ok(g.maxPairAgeDays < d.maxPairAgeDays, 'brand new only');
  assert.equal(resolvePreset('gamble').danger, true);
  assert.equal(resolvePreset('degen').danger, false);
});

test('a sub-$50K launch passes gamble and fails every other preset', () => {
  const micro = norm(fx.microLaunch);
  assert.equal(rankCandidates([micro], resolvePreset('gamble')).scored.length, 1, 'gamble must accept it');
  for (const name of ['safe', 'balanced', 'degen']) {
    const { scored, rejected } = rankCandidates([micro], resolvePreset(name));
    assert.equal(scored.length, 0, `${name} should reject a $32K coin`);
    assert.ok(rejected[0].reasons.length > 0);
  }
});

test('gamble still rejects anything above its ceiling', () => {
  const tooBig = norm({ ...fx.microLaunch, fdv: 500_000, marketCap: 500_000 });
  const { scored, rejected } = rankCandidates([tooBig], resolvePreset('gamble'));
  assert.equal(scored.length, 0);
  assert.ok(rejected[0].reasons.some((r) => /market cap too large/.test(r)));
});

test('gamble keeps every safety filter — cheap does not mean unchecked', () => {
  const honeypot = norm({
    ...fx.microLaunch,
    txns: { ...fx.microLaunch.txns, h24: { buys: 400, sells: 0 } },
  });
  const impersonator = norm({ ...fx.microLaunch, baseToken: { ...fx.microLaunch.baseToken, symbol: 'BONK' } });
  const g = resolvePreset('gamble');
  assert.ok(rankCandidates([honeypot], g).rejected[0].reasons.some((r) => /honeypot/.test(r)));
  assert.ok(rankCandidates([impersonator], g).rejected[0].reasons.some((r) => /impersonator/.test(r)));
});

test('headroom discriminates inside the gamble tier', () => {
  // With a fixed $50K floor against a $50K ceiling the scale collapsed and
  // every gamble coin scored an identical, meaningless 1.
  const g = resolvePreset('gamble');
  const tiny = rankCandidates([norm({ ...fx.microLaunch, fdv: 4_000, marketCap: 4_000 })], g).scored[0];
  const nearCap = rankCandidates([norm({ ...fx.microLaunch, fdv: 46_000, marketCap: 46_000 })], g).scored[0];
  assert.ok(tiny && nearCap, 'both should pass the filters');
  assert.ok(tiny.parts.headroom.raw > nearCap.parts.headroom.raw + 0.2,
    `a $4K coin must have clearly more headroom than a $46K one (${tiny.parts.headroom.raw} vs ${nearCap.parts.headroom.raw})`);
  assert.ok(nearCap.parts.headroom.raw < 0.2, 'a coin at the ceiling has almost none');
});

test('inside a one-hour window, younger scores higher on freshness', () => {
  // The old fixed 2h ramp scored every sub-hour coin zero and ranked the
  // oldest one highest — exactly backwards for this tier.
  const g = resolvePreset('gamble');
  const at = (mins) => rankCandidates(
    [norm({ ...fx.microLaunch, pairCreatedAt: fx.NOW - mins * 60_000 })], g,
  ).scored[0];

  const young = at(25);
  const middling = at(40);
  const nearlyStale = at(55);
  assert.ok(young && middling && nearlyStale, 'all three should clear the filters');
  assert.equal(young.parts.freshness.raw, 1, '25 minutes old is the sweet spot');
  assert.ok(middling.parts.freshness.raw < young.parts.freshness.raw);
  assert.ok(nearlyStale.parts.freshness.raw < middling.parts.freshness.raw);
  assert.ok(nearlyStale.parts.freshness.raw < 0.25, 'almost an hour old is nearly spent');
});

test('the one-hour window does not disturb the wider presets', () => {
  const balanced = resolvePreset('balanced');
  const fresh = rankCandidates([norm({ ...fx.goodRunner, pairCreatedAt: fx.NOW - 12 * 3600e3 })], balanced).scored[0];
  const older = rankCandidates([norm({ ...fx.goodRunner, pairCreatedAt: fx.NOW - 50 * 3600e3 })], balanced).scored[0];
  assert.equal(fresh.parts.freshness.raw, 1);
  assert.equal(older.parts.freshness.raw, 1, 'a 21-day window still treats both as fresh');
});

test('gamble rejects anything over an hour old', () => {
  const g = resolvePreset('gamble');
  const twoHours = norm({ ...fx.microLaunch, pairCreatedAt: fx.NOW - 120 * 60_000 });
  const { scored, rejected } = rankCandidates([twoHours], g);
  assert.equal(scored.length, 0, 'two hours is not fresh');
  assert.ok(rejected[0].reasons.some((r) => /no longer a fresh launch/.test(r)));

  const tooNew = norm({ ...fx.microLaunch, pairCreatedAt: fx.NOW - 5 * 60_000 });
  assert.ok(rankCandidates([tooNew], g).rejected[0].reasons.some((r) => /sniper/.test(r)),
    'the sniper-window floor still applies');
});

test('scale and logScale survive a degenerate range instead of going constant', () => {
  // This is what silently killed headroom at a $50K ceiling.
  assert.equal(scale(80, 72, 72), 1);
  assert.equal(scale(60, 72, 72), 0);
  assert.equal(logScale(60_000, 50_000, 50_000), 1);
  assert.equal(logScale(10_000, 50_000, 50_000), 0);
  // An inverted range has no meaningful answer; it must still be a finite
  // step rather than a NaN that silently clamps the whole signal to zero.
  assert.equal(scale(5, 10, 5), 1);
  assert.ok(Number.isFinite(scale(5, 10, 5)));
});
