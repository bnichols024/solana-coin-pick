import test from 'node:test';
import assert from 'node:assert/strict';

import { PRESETS, resolvePreset, CONFIG } from '../src/config.js';
import { normalizePair, rankCandidates, scale, logScale, headroomScore, freshnessScore } from '../src/score.js';
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
  const coin = norm({ ...fx.goodRunner, fdv: 1_000_000, marketCap: 1_000_000 });
  const degen = rankCandidates([coin], resolvePreset('degen')).scored[0];
  const balanced = rankCandidates([coin], resolvePreset('balanced')).scored[0];
  assert.ok(degen && balanced, 'both presets should accept a $1M coin');
  // $1M is close to degen's $1.5M ceiling but well under balanced's $3M one.
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
  const at = (h) => rankCandidates([norm({ ...fx.goodRunner, pairCreatedAt: fx.NOW - h * 3600e3 })], balanced).scored[0];
  const fresh = at(12);
  const older = at(50);
  assert.ok(fresh && older, 'both are inside balanced\'s three-day window');
  // The sweet spot scales to the window rather than to gamble's hour: on a
  // three-day window it runs to 36h, so 12h is still perfect and 50h decays.
  assert.equal(fresh.parts.freshness.raw, 1);
  assert.ok(older.parts.freshness.raw < 1, 'past the sweet spot it decays, not steps');
  assert.ok(older.parts.freshness.raw > 0, 'but a two-day-old coin is not scored zero');
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

// --- v4: no preset may flatten a scale-dependent signal --------------------
// CLAUDE.md records this failing twice: a preset with a much narrower range
// silently turns headroom or freshness into a constant, and the model then
// ranks on the remaining signals with no warning. scale()/logScale() step
// instead of dividing by zero, which converts the bug from NaN to constant —
// so it has to be checked numerically, per preset, not reasoned about.

test('every preset keeps headroom and freshness discriminating across its own range', () => {
  for (const name of Object.keys(PRESETS)) {
    const { filters } = resolvePreset(name);
    const maxHours = filters.maxPairAgeDays * 24;

    const headrooms = [0.02, 0.2, 0.5, 0.95].map((f) =>
      headroomScore({ fdv: filters.maxFdvUsd * f }, filters));
    assert.ok(headrooms[0] - headrooms[3] > 0.4,
      `${name}: headroom is nearly flat across its cap range (${headrooms.join(', ')})`);
    for (let i = 1; i < headrooms.length; i++) {
      assert.ok(headrooms[i] <= headrooms[i - 1], `${name}: headroom must fall as cap rises`);
    }

    // Sample across the ages this preset actually admits: below
    // minPairAgeMinutes the coin is rejected outright, so scoring it zero there
    // is correct and would mask a genuinely flat curve.
    const minHours = filters.minPairAgeMinutes / 60;
    const fresh = [0, 0.3, 0.75, 1].map((f) =>
      freshnessScore({ ageMs: (minHours + (maxHours - minHours) * f) * 3_600_000 }, filters));
    assert.ok(Math.max(...fresh) - Math.min(...fresh) > 0.4,
      `${name}: freshness is nearly flat across its age window (${fresh.join(', ')})`);
    // The curve ramps in, plateaus, then decays, so the youngest legal coin is
    // not necessarily the highest. What must never happen — and did, in the
    // Gamble tier — is the *oldest* allowed coin scoring best.
    assert.ok(fresh[3] < Math.max(...fresh),
      `${name}: the oldest allowed coin scores highest on freshness (${fresh.join(', ')})`);
  }
});

test('v4 rejects the shape of pick the track record is full of', () => {
  // The screenshot that prompted v4: caps in the hundreds of thousands to
  // millions, picked after a large daily move, peaking 1.05x and then bleeding
  // 80–99%. Under v3's tuning every one of these was scoreable.
  const v3 = {
    filters: {
      ...resolvePreset('balanced').filters,
      maxFdvUsd: 30_000_000,
      maxPairAgeDays: 21,
      latenessGraceHours: undefined,
      maxChange24h: undefined,
      maxChange6h: undefined,
    },
    weights: resolvePreset('balanced').weights,
  };
  const v4 = resolvePreset('balanced');

  const lateBigCap = norm({
    ...fx.goodRunner,
    fdv: 2_820_000,
    marketCap: 2_820_000,
    pairCreatedAt: fx.NOW - 30 * 3600e3,
    priceChange: { m5: 1, h1: 6, h6: 55, h24: 240 },
  });

  assert.equal(rankCandidates([lateBigCap], v3).scored.length, 1, 'v3 happily scored it');
  const after = rankCandidates([lateBigCap], v4);
  assert.equal(after.scored.length, 0, 'v4 must not score it at all');
  assert.ok(after.rejected[0].reasons.some((r) => /entry has passed/.test(r)));

  // ...without closing the field: a small, early, still-moving coin survives.
  assert.equal(rankCandidates([norm(fx.goodRunner)], v4).scored.length, 1);
});
