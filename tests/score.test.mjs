import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePair, rejectReasons, rankCandidates, scoreCandidate,
  momentumScore, buyPressureScore, headroomScore, freshnessScore, scale, logScale,
} from '../src/score.js';
import { usd, price, pct, age } from '../src/format.js';
import { evaluateSafety, sellSideBlocked } from '../src/safety.js';
import * as fx from './fixtures.js';

const norm = (pair, extra = {}) => normalizePair(pair, extra, fx.NOW);

test('normalizePair flattens strings and nested metrics', () => {
  const c = norm(fx.goodRunner, { boostAmount: 500, hasProfile: true, sources: ['boosts-top'] });
  assert.equal(c.symbol, 'GOODDOG');
  assert.equal(c.priceUsd, 0.00042);       // string -> number
  assert.equal(c.liquidity, 180_000);
  assert.equal(c.txns24, 8000);
  assert.equal(c.ageMs, 10 * 3_600_000);
  assert.equal(c.boostAmount, 500);
  assert.equal(c.socials, 2);
  assert.equal(c.avgTradeUsd, 1_400_000 / 8000);
});

test('a healthy runner passes every hard filter', () => {
  assert.deepEqual(rejectReasons(norm(fx.goodRunner)), []);
});

test('hard filters reject each class of bad candidate', () => {
  const cases = [
    [fx.thinLiquidity, /liquidity under/],
    [fx.tooNew, /sniper\/rug window/],
    [fx.tooBig, /market cap too large/],
    [fx.blowOffTop, /blow-off top/],
    [fx.washTrading, /wash volume/],
    [fx.deadPool, /volume too thin/],
  ];
  for (const [pair, pattern] of cases) {
    const reasons = rejectReasons(norm(pair));
    assert.ok(reasons.length > 0, `${pair.baseToken.symbol} should be rejected`);
    assert.ok(reasons.some((r) => pattern.test(r)), `${pair.baseToken.symbol}: ${reasons.join('; ')}`);
  }
});

test('scores stay inside 0..100 and rank strong above weak', () => {
  const good = scoreCandidate(norm(fx.goodRunner, { boostAmount: 500, hasProfile: true, sources: ['a', 'b'] }));
  const mid = scoreCandidate(norm(fx.mediocre));
  assert.ok(good.score >= 0 && good.score <= 100);
  assert.ok(mid.score >= 0 && mid.score <= 100);
  assert.ok(good.score > mid.score, `${good.score} should beat ${mid.score}`);
  assert.equal(Object.keys(good.parts).length, 6);
});

test('rankCandidates picks the winner and partitions the rejects', () => {
  const pairs = [fx.mediocre, fx.goodRunner, fx.thinLiquidity, fx.tooNew, fx.deadPool, fx.blowOffTop];
  const { winner, runnersUp, rejected } = rankCandidates(pairs.map((p) => norm(p)));
  assert.equal(winner.candidate.symbol, 'GOODDOG');
  assert.equal(runnersUp[0].candidate.symbol, 'MIDCAT');
  assert.equal(rejected.length, 4);
  assert.ok(rejected.every((r) => r.reasons.length > 0));
});

test('rankCandidates returns no winner when the whole field is junk', () => {
  const { winner, scored } = rankCandidates([fx.thinLiquidity, fx.deadPool].map((p) => norm(p)));
  assert.equal(winner, null);
  assert.equal(scored.length, 0);
});

test('momentum rewards acceleration over a stale pump', () => {
  const accelerating = norm({ ...fx.goodRunner, priceChange: { m5: 5, h1: 35, h6: 40, h24: 60 } });
  const stale = norm({ ...fx.goodRunner, priceChange: { m5: 0, h1: 1, h6: 120, h24: 300 } });
  assert.ok(momentumScore(accelerating) > momentumScore(stale));
});

test('buy pressure needs a real sample, not three trades', () => {
  const heavyBuying = norm({ ...fx.goodRunner, txns: { ...fx.goodRunner.txns, h1: { buys: 900, sells: 100 } } });
  const tiny = norm({ ...fx.goodRunner, txns: { ...fx.goodRunner.txns, h1: { buys: 5, sells: 0 } } });
  assert.ok(buyPressureScore(heavyBuying) > buyPressureScore(tiny));
});

test('headroom falls as market cap rises', () => {
  const small = norm({ ...fx.goodRunner, fdv: 200_000 });
  const large = norm({ ...fx.goodRunner, fdv: 25_000_000 });
  assert.ok(headroomScore(small) > headroomScore(large));
  assert.ok(headroomScore(large) < 0.15);
});

test('freshness peaks in the 2-72h window', () => {
  const mk = (h) => norm({ ...fx.goodRunner, pairCreatedAt: fx.NOW - h * 3_600_000 });
  assert.equal(freshnessScore(mk(24)), 1);
  assert.ok(freshnessScore(mk(1)) < 1);
  assert.ok(freshnessScore(mk(200)) < 1);
  assert.ok(freshnessScore(mk(24)) > freshnessScore(mk(200)));
});

test('penalties bite on a red hour', () => {
  const red = norm({ ...fx.goodRunner, priceChange: { m5: -1, h1: -5, h6: 10, h24: 50 } });
  const result = scoreCandidate(red);
  assert.ok(result.penalties.some((p) => /Negative on the hour/.test(p.label)));
  assert.ok(result.deduction > 0);
});

test('scale and logScale clamp to 0..1', () => {
  assert.equal(scale(-100, 0, 10), 0);
  assert.equal(scale(999, 0, 10), 1);
  assert.equal(scale(5, 0, 10), 0.5);
  assert.equal(logScale(0, 10, 1000), 0);
  assert.equal(logScale(1e9, 10, 1000), 1);
  assert.equal(logScale(100, 10, 1000), 0.5);
});

test('missing or garbage data degrades to zero, never NaN', () => {
  const c = norm({ chainId: 'solana', baseToken: {} });
  const result = scoreCandidate(c);
  assert.ok(Number.isFinite(result.score));
  assert.ok(rejectReasons(c).length > 0);
});

// --- contract safety -------------------------------------------------------

const cleanMint = { mintAuthority: null, freezeAuthority: null, transferFeeBps: null, program: 'spl-token' };
const cleanRug = { score: 5, risks: [] };

test('a clean contract passes with both checks recorded', () => {
  const r = evaluateSafety({ mint: cleanMint, rugcheck: cleanRug });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.rejections.length, 0);
  assert.equal(r.unverified.length, 0);
  assert.equal(r.checked.length, 2);
});

test('live mint or freeze authority is an outright rejection', () => {
  const minted = evaluateSafety({ mint: { ...cleanMint, mintAuthority: 'Dev111' }, rugcheck: cleanRug });
  assert.equal(minted.verdict, 'reject');
  assert.match(minted.rejections[0], /print unlimited/);

  const frozen = evaluateSafety({ mint: { ...cleanMint, freezeAuthority: 'Dev111' }, rugcheck: cleanRug });
  assert.equal(frozen.verdict, 'reject');
  assert.match(frozen.rejections[0], /frozen/);
});

test('an extortionate Token-2022 transfer fee is rejected, a small one only warns', () => {
  const gouging = evaluateSafety({ mint: { ...cleanMint, transferFeeBps: 3000 }, rugcheck: cleanRug });
  assert.equal(gouging.verdict, 'reject');
  assert.match(gouging.rejections[0], /30\.0%/);

  const mild = evaluateSafety({ mint: { ...cleanMint, transferFeeBps: 200 }, rugcheck: cleanRug });
  assert.equal(mild.verdict, 'pass');
  assert.equal(mild.warnings.length, 1);
});

test('RugCheck danger rejects, warn only warns', () => {
  const danger = evaluateSafety({
    mint: cleanMint,
    rugcheck: { score: 90, risks: [{ name: 'Large Amount of LP Unlocked', level: 'danger', description: '' }] },
  });
  assert.equal(danger.verdict, 'reject');
  assert.match(danger.rejections[0], /LP Unlocked/);

  const warn = evaluateSafety({
    mint: cleanMint,
    rugcheck: { score: 40, risks: [{ name: 'Top 10 holders high ownership', level: 'warn', description: '' }] },
  });
  assert.equal(warn.verdict, 'pass');
  assert.equal(warn.warnings.length, 1);
});

test('a check that could not run is reported, never silently passed', () => {
  const r = evaluateSafety({ mint: null, mintError: 'HTTP 429', rugcheck: cleanRug });
  assert.equal(r.verdict, 'pass');           // not proof of danger...
  assert.equal(r.unverified.length, 1);      // ...but never invisible
  assert.match(r.unverified[0], /HTTP 429/);
  assert.equal(r.checked.length, 1);
});

test('total safety outage yields two unverified entries, no false all-clear', () => {
  const r = evaluateSafety({ mint: null, mintError: 'offline', rugcheck: null, rugcheckError: 'offline' });
  assert.equal(r.checked.length, 0);
  assert.equal(r.unverified.length, 2);
  assert.equal(r.rejections.length, 0);
});

test('honeypot and corpse patterns are filtered from market data alone', () => {
  const honeypot = norm({
    ...fx.goodRunner,
    txns: { ...fx.goodRunner.txns, h24: { buys: 4000, sells: 0 } },
  });
  assert.ok(sellSideBlocked(honeypot));
  assert.ok(rejectReasons(honeypot).some((r) => /honeypot/.test(r)));

  const sellTax = norm({
    ...fx.goodRunner,
    txns: { ...fx.goodRunner.txns, h24: { buys: 4000, sells: 100 } },
  });
  assert.ok(rejectReasons(sellTax).some((r) => /sell tax or trap/.test(r)));

  const corpse = norm({
    ...fx.goodRunner,
    priceChange: { m5: 1, h1: 5, h6: -50, h24: -85 },
    liquidity: { usd: 40_000 },
  });
  assert.ok(rejectReasons(corpse).some((r) => /already collapsed/.test(r)));
});

test('the healthy runner survives the new rug filters', () => {
  assert.deepEqual(rejectReasons(norm(fx.goodRunner)), []);
});

test('formatters handle nulls and sub-penny prices', () => {
  assert.equal(usd(null), '—');
  assert.equal(usd(1_500_000), '$1.50M');
  assert.equal(usd(2_500), '$2.5K');
  assert.equal(pct(12.34), '+12.3%');
  assert.equal(pct(-5), '-5.0%');
  assert.equal(age(90 * 60_000), '1.5h');
  assert.ok(price(0.00042).startsWith('$0.000'));
  assert.ok(!price(0.00042).includes('e'));
});
