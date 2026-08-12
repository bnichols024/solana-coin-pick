import test from 'node:test';
import assert from 'node:assert/strict';

import { PRESETS, resolvePreset, CONFIG } from '../src/config.js';
import { normalizePair, rankCandidates } from '../src/score.js';
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
