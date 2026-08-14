import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePair, rejectReasons, rankCandidates, scoreCandidate, impersonatesKnownToken,
  momentumScore, buyPressureScore, attentionScore, headroomScore, freshnessScore, scale, logScale,
} from '../src/score.js';
import { usd, price, pct, age } from '../src/format.js';
import { evaluateSafety, sellSideBlocked } from '../src/safety.js';
import { assessEntry, capBefore, entryLabel } from '../src/entry.js';
import { resolvePreset } from '../src/config.js';
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
const cleanHolders = { top10SharePct: 8, countedHolders: 10, excluded: 1 };

test('a clean contract passes with every check recorded', () => {
  const r = evaluateSafety({ mint: cleanMint, rugcheck: cleanRug, holders: cleanHolders });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.rejections.length, 0);
  assert.equal(r.unverified.length, 0);
  assert.equal(r.checked.length, 3);
});

test('holder concentration rejects above the threshold and warns approaching it', () => {
  const share = (top10SharePct) =>
    evaluateSafety({ mint: cleanMint, rugcheck: cleanRug, holders: { top10SharePct } }, 30);

  assert.equal(share(45).verdict, 'reject');
  assert.match(share(45).rejections[0], /one transaction/);
  assert.equal(share(24).verdict, 'pass');
  assert.equal(share(24).warnings.length, 1, 'approaching the line is worth saying');
  assert.equal(share(8).verdict, 'pass');
  assert.equal(share(8).warnings.length, 0);
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
  const r = evaluateSafety({ mint: null, mintError: 'HTTP 429', rugcheck: cleanRug, holders: cleanHolders });
  assert.equal(r.verdict, 'pass');           // not proof of danger...
  assert.equal(r.unverified.length, 1);      // ...but never invisible
  assert.match(r.unverified[0], /HTTP 429/);
  assert.equal(r.checked.length, 2);
});

test('an unreadable holder count is unverified, not a clean spread', () => {
  const r = evaluateSafety({ mint: cleanMint, rugcheck: cleanRug, holders: null, holdersError: 'no usable answer' });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.rejections.length, 0);
  assert.equal(r.unverified.length, 1);
  assert.match(r.unverified[0], /Top-10 holder concentration \(no usable answer\)/);
});

test('total safety outage yields an unverified entry per check, no false all-clear', () => {
  const r = evaluateSafety({
    mint: null, mintError: 'offline', rugcheck: null, rugcheckError: 'offline', holders: null, holdersError: 'offline',
  });
  assert.equal(r.checked.length, 0);
  assert.equal(r.unverified.length, 3);
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

test('a tiny coin wearing a famous ticker is rejected as an impersonator', () => {
  for (const symbol of ['SOL', 'usdc', 'Bonk', 'JUP']) {
    const fake = norm({ ...fx.goodRunner, baseToken: { ...fx.goodRunner.baseToken, symbol } });
    assert.ok(impersonatesKnownToken(fake), `${symbol} should be flagged`);
    assert.ok(rejectReasons(fake).some((r) => /impersonator/.test(r)), `${symbol} should be rejected`);
  }
});

test('an ordinary meme ticker is not mistaken for an impersonator', () => {
  for (const symbol of ['GOODDOG', 'FLOKI2', 'MOONCAT', '']) {
    const ok = norm({ ...fx.goodRunner, baseToken: { ...fx.goodRunner.baseToken, symbol } });
    assert.equal(impersonatesKnownToken(ok), false, `${symbol} should not be flagged`);
  }
});

test('the real large-cap token is not flagged as its own impersonator', () => {
  const real = norm({ ...fx.goodRunner, baseToken: { ...fx.goodRunner.baseToken, symbol: 'BONK' }, fdv: 900_000_000 });
  assert.equal(impersonatesKnownToken(real), false);
});

test('the healthy runner survives the new rug filters', () => {
  assert.deepEqual(rejectReasons(norm(fx.goodRunner)), []);
});

// --- entry timing ----------------------------------------------------------

const withChange = (over) => norm({ ...fx.goodRunner, ...over });

test('capBefore reconstructs a prior market cap and refuses impossible ones', () => {
  assert.equal(capBefore(200, 100), 100);        // doubled -> was half
  assert.equal(capBefore(75, -25), 100);         // down a quarter -> was 100
  assert.equal(capBefore(100, -99.9), null);     // ratio is meaningless
  assert.equal(capBefore(0, 50), null);
});

test('a vertical candle says wait, with a target below the current cap', () => {
  const e = assessEntry(withChange({ priceChange: { m5: 12, h1: 80, h6: 95, h24: 150 } }));
  assert.equal(e.state, 'wait_pullback');
  assert.match(e.verdict, /Wait for the pullback/);
  assert.ok(e.zoneHigh < fx.goodRunner.fdv, 'target must be below current cap');
  assert.ok(e.zoneLow < e.zoneHigh, 'zone must be low..high');
  assert.ok(e.discountPct < 0);
});

test('a steady climb says buy now and never quotes a target above current', () => {
  const e = assessEntry(withChange({ priceChange: { m5: 1, h1: 12, h6: 40, h24: 90 } }));
  assert.equal(e.state, 'buy_now');
  assert.ok(e.zoneHigh <= fx.goodRunner.fdv);
  assert.ok(e.maxChase > fx.goodRunner.fdv, 'chase limit sits above current');
});

test('a hot last hour asks for a shallow dip, shallower than a parabolic one', () => {
  const stretched = assessEntry(withChange({ priceChange: { m5: 2, h1: 40, h6: 35, h24: 90 } }));
  const parabolic = assessEntry(withChange({ priceChange: { m5: 12, h1: 80, h6: 95, h24: 150 } }));
  assert.equal(stretched.state, 'wait_shallow');
  assert.ok(stretched.discountPct > parabolic.discountPct,
    'a stretched coin should need a smaller discount than a parabolic one');
});

test('a bleeding coin is a hard wait, not a dip buy', () => {
  const e = assessEntry(withChange({ priceChange: { m5: -3, h1: -14, h6: 20, h24: 60 } }));
  assert.equal(e.state, 'falling');
  assert.match(e.verdict, /Do not buy yet/);
  assert.ok(e.zoneHigh < fx.goodRunner.fdv);
  assert.ok(e.invalidation < e.zoneLow);
});

test('a quiet coin is flagged as stalled rather than urgent', () => {
  const e = assessEntry(withChange({
    priceChange: { m5: 0, h1: 0.5, h6: 30, h24: 80 },
    volume: { m5: 100, h1: 5_000, h6: 700_000, h24: 1_400_000 },
  }));
  assert.equal(e.state, 'stalled');
  assert.match(e.reason, /six-hour average/);
});

test('entry levels stay ordered and finite for every state', () => {
  const cases = [
    { m5: 12, h1: 80, h6: 95, h24: 150 },
    { m5: 1, h1: 12, h6: 40, h24: 90 },
    { m5: 2, h1: 40, h6: 35, h24: 90 },
    { m5: -3, h1: -14, h6: 20, h24: 60 },
    { m5: 0, h1: 0, h6: 0, h24: 0 },
  ];
  for (const priceChange of cases) {
    const e = assessEntry(withChange({ priceChange }));
    assert.ok(Number.isFinite(e.zoneLow) && Number.isFinite(e.zoneHigh), JSON.stringify(priceChange));
    assert.ok(e.zoneLow <= e.zoneHigh);
    assert.ok(e.invalidation < e.maxChase);
    assert.ok(typeof entryLabel(e.state) === 'string' && entryLabel(e.state) !== '—');
  }
});

test('missing market cap yields an honest "unclear" rather than a fake level', () => {
  const e = assessEntry(norm({ ...fx.goodRunner, fdv: 0, marketCap: 0 }));
  assert.equal(e.state, 'unknown');
  assert.equal(e.zoneLow, null);
  assert.equal(e.maxChase, null);
});

test('formatters handle nulls and sub-penny prices', () => {
  assert.equal(usd(null), '—');
  assert.equal(usd(1_500_000), '$1.50M');
  assert.equal(usd(2_500), '$2.5K');
  assert.equal(pct(12.34), '+12.3%');
  assert.equal(pct(-5), '-5.0%');
  assert.equal(age(90 * 60_000), '1.5h');
  // 0 is a real age (a pick made a second ago), not missing data.
  assert.equal(age(0), 'just now');
  assert.equal(age(30_000), 'just now');
  assert.equal(age(null), 'unknown');
  assert.equal(age(undefined), 'unknown');
  assert.equal(age(-5), 'unknown');
  assert.ok(price(0.00042).startsWith('$0.000'));
  assert.ok(!price(0.00042).includes('e'));
});

// --- v2 model: buy the start of a move, not the end ------------------------
// Fitted to the v1 track record, where every pick peaked under 1.6x because the
// score rose monotonically with the 1h change and so always chose the most
// vertical candle on the board.

const withChg = (m5, h1, h6, h24) => norm({ ...fx.goodRunner, priceChange: { m5, h1, h6, h24 } });

test('an early accelerating move outscores a vertical one', () => {
  const early = momentumScore(withChg(1, 12, 12, 20));
  const vertical = momentumScore(withChg(10, 75, 90, 150));
  assert.ok(early > vertical, `early ${early.toFixed(3)} should beat vertical ${vertical.toFixed(3)}`);
  assert.ok(vertical < 0.35, 'a vertical hour must be heavily discounted');
});

test('a coin that ran hours ago is discounted even if it is still ticking up', () => {
  const late = momentumScore(withChg(1, 8, 60, 300));   // +300% on the day already
  const fresh = momentumScore(withChg(1, 8, 8, 15));    // same hour, no history
  assert.ok(fresh > late * 2, `fresh ${fresh.toFixed(3)} vs late ${late.toFixed(3)}`);
  assert.ok(late < 0.2);
});

test('a flat or falling coin still scores zero', () => {
  // The trap in this shape: an additive "not late" term hands every dead coin
  // most of the points, because being dead is not being late.
  assert.equal(momentumScore(withChg(0, 0, 0, 0)), 0);
  assert.equal(momentumScore(withChg(-2, -5, -10, -20)), 0);
});

test('the momentum curve peaks in the middle, not at the extreme', () => {
  const samples = [2, 6, 12, 18, 25, 40, 60, 90].map((h1) => momentumScore(withChg(1, h1, h1 * 0.7, h1 * 2)));
  const peakAt = samples.indexOf(Math.max(...samples));
  assert.ok(peakAt > 0 && peakAt < samples.length - 1,
    `peak should be interior, got index ${peakAt} of ${JSON.stringify(samples.map((s) => +s.toFixed(2)))}`);
  assert.ok(samples[samples.length - 1] < samples[peakAt] / 2, 'the extreme end must fall well below the peak');
});

test('boost spend no longer moves the score at all', () => {
  const base = { hasProfile: true, socials: 2, jupiterVerified: false, sources: ['a', 'b'] };
  const unboosted = attentionScore({ ...base, boostAmount: 0 });
  const heavilyBoosted = attentionScore({ ...base, boostAmount: 5000 });
  assert.equal(unboosted, heavilyBoosted, 'promotion spend is not evidence of anything good');
});

test('corroboration still counts for something', () => {
  const alone = attentionScore({ hasProfile: false, socials: 0, jupiterVerified: false, sources: ['a'] });
  const corroborated = attentionScore({ hasProfile: true, socials: 3, jupiterVerified: true, sources: ['a', 'b', 'c'] });
  assert.ok(corroborated > alone);
  assert.ok(corroborated <= 1 && alone >= 0);
});

test('a whole-model comparison: the early coin now beats the pumping one', () => {
  // Same liquidity, volume and trade profile; only the price action differs.
  const pumping = norm({ ...fx.goodRunner, priceChange: { m5: 12, h1: 70, h6: 120, h24: 260 } });
  const starting = norm({ ...fx.goodRunner, priceChange: { m5: 1.5, h1: 11, h6: 10, h24: 18 } });
  const { scored, rejected } = rankCandidates([pumping, starting], resolvePreset('balanced'));

  // v2 merely ranked the early coin above the pumping one. v4 goes further:
  // at ten hours old and up 260% on the day, the pumping coin is past the
  // grace window and is thrown out of the field entirely.
  assert.equal(scored.length, 1, 'the finished move should not be scored at all');
  assert.equal(scored[0].candidate.symbol, starting.symbol);
  assert.ok(rejected.some((r) => r.candidate.symbol === pumping.symbol
    && r.reasons.some((x) => /entry has passed/.test(x))));
});

test('a mature coin that has already run is rejected, not merely discounted', () => {
  const late = (chg) => norm({ ...fx.goodRunner, priceChange: chg });
  const f = resolvePreset('balanced');

  // Up 200% on the day at ten hours old: the entry passed hours ago.
  assert.ok(rankCandidates([late({ m5: 2, h1: 8, h6: 40, h24: 200 })], f)
    .rejected[0].reasons.some((r) => /entry has passed/.test(r)));

  // Up 140% but 130% of it in the last six hours: same story, shorter window.
  assert.ok(rankCandidates([late({ m5: 2, h1: 8, h6: 130, h24: 140 })], f)
    .rejected[0].reasons.some((r) => /move already happened/.test(r)));

  // The v3 fixture itself still clears both ceilings, so this did not just
  // close the field.
  assert.equal(rankCandidates([norm(fx.goodRunner)], f).scored.length, 1);
});

test('inside the grace window the same numbers are not late', () => {
  const chg = { m5: 6, h1: 40, h6: 200, h24: 200 };
  const at = (ageHours) => rankCandidates(
    [norm({ ...fx.goodRunner, pairCreatedAt: fx.NOW - ageHours * 3_600_000, priceChange: chg })],
    resolvePreset('balanced'),
  );
  // Two hours old: that 200% is the coin's entire life, there was no earlier
  // entry to have missed.
  assert.equal(at(2).scored.length, 1, 'a young launch is not late for its own move');
  assert.equal(at(9).scored.length, 0, 'the same numbers on a nine-hour-old coin are');
});

test('an unknown pair age counts as mature, so it cannot be a loophole', () => {
  // Age is already a hard reject on its own; this pins the lateness rule's own
  // default, matching momentumScore, so a missing timestamp never buys a pass.
  const noAge = norm({ ...fx.goodRunner, pairCreatedAt: undefined, priceChange: { m5: 2, h1: 8, h6: 40, h24: 200 } });
  const reasons = rejectReasons(noAge, resolvePreset('balanced').filters);
  assert.ok(reasons.some((r) => /entry has passed/.test(r)));
});

test('supply concentration rejects, and an absent reading never passes a coin', () => {
  const f = resolvePreset('balanced').filters;
  const withShare = (top10SharePct) => normalizePair(fx.goodRunner, { top10SharePct }, fx.NOW);

  assert.ok(rejectReasons(withShare(45), f).some((r) => /top 10 wallets hold 45%/.test(r)));
  assert.equal(rejectReasons(withShare(12), f).length, 0, 'a well-spread coin is fine');

  // The check could not run. That must skip the rule, not clear it — and it
  // must not be confused with a reading of zero.
  const unknown = withShare(undefined);
  assert.equal(unknown.top10SharePct, null);
  assert.equal(rejectReasons(unknown, f).length, 0);
});

// --- v3: "late" depends on how much history a coin has ---------------------
// v2 scored a 25-minute-old coin up 200% identically to a three-day-old coin up
// 200%, because lateness read the price windows without knowing the coin's age.
// For the young one that 200% *is* its whole life — there was no earlier entry.

const aged = (ageHours, chg) => norm({
  ...fx.goodRunner,
  pairCreatedAt: fx.NOW - ageHours * 3_600_000,
  priceChange: chg,
});

test('a young parabolic launch is no longer treated as late', () => {
  const young = aged(0.42, { m5: 14, h1: 90, h6: 220, h24: 220 });
  assert.ok(momentumScore(young) > 0.8,
    `a 25-minute-old coin still ripping should score high, got ${momentumScore(young).toFixed(3)}`);
});

test('but a young launch whose move is rolling over still is', () => {
  // Same coin, same totals — only the last five minutes differ.
  const ripping = aged(0.42, { m5: 14, h1: 90, h6: 220, h24: 220 });
  const fading = aged(0.42, { m5: 1, h1: 90, h6: 220, h24: 220 });
  assert.ok(momentumScore(fading) < momentumScore(ripping));
  assert.ok(momentumScore(fading) < 0.4,
    `a fading young coin must stay discounted, got ${momentumScore(fading).toFixed(3)}`);
});

test('the v2 discount on genuinely late mature coins does not regress', () => {
  const mature = aged(72, { m5: 14, h1: 90, h6: 200, h24: 200 });
  assert.ok(momentumScore(mature) < 0.2,
    `three days old and up 200% is still late, got ${momentumScore(mature).toFixed(3)}`);
  const maturedVertical = aged(72, { m5: 10, h1: 75, h6: 90, h24: 150 });
  assert.ok(momentumScore(maturedVertical) < 0.35);
});

test('an unknown age is treated as mature, not as a free pass', () => {
  // Missing pairCreatedAt must not become a loophole that scores every
  // extended coin as if it were minutes old.
  const noAge = norm({ ...fx.goodRunner, pairCreatedAt: undefined, priceChange: { m5: 14, h1: 90, h6: 220, h24: 220 } });
  assert.equal(noAge.ageMs, null);
  assert.ok(momentumScore(noAge) < 0.2);
});

test('a dead young coin still scores zero', () => {
  assert.equal(momentumScore(aged(0.3, { m5: 0, h1: 0, h6: 0, h24: 0 })), 0);
  assert.equal(momentumScore(aged(0.3, { m5: -3, h1: -10, h6: -10, h24: -10 })), 0);
});

test('maturity blends smoothly rather than snapping at a threshold', () => {
  const chg = { m5: 14, h1: 90, h6: 220, h24: 220 };
  const scores = [0.25, 1, 2, 4, 6, 12].map((h) => momentumScore(aged(h, chg)));
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i] <= scores[i - 1] + 1e-9,
      `score should fall as the same coin gets older: ${JSON.stringify(scores.map((s) => +s.toFixed(3)))}`);
  }
  assert.ok(scores[0] - scores[scores.length - 1] > 0.5, 'and the spread should be meaningful');
});

test('the Gamble tier now ranks a live parabolic launch above a sedate one', () => {
  // The defect that prompted v3: the lottery-ticket tier ranked the lottery
  // ticket 23 points below the boring coin.
  const mk = (chg) => norm({
    chainId: 'solana', baseToken: { address: 'A', symbol: 'FROGGO', name: 'F' }, priceUsd: '0.00004',
    priceChange: chg,
    volume: { m5: 9000, h1: 40000, h6: 40000, h24: 40000 },
    txns: { m5: { buys: 80, sells: 20 }, h1: { buys: 300, sells: 90 }, h6: { buys: 300, sells: 90 }, h24: { buys: 300, sells: 90 } },
    liquidity: { usd: 14000 }, fdv: 38000, marketCap: 38000,
    pairCreatedAt: fx.NOW - 25 * 60_000,
  });
  const parabolic = mk({ m5: 14, h1: 90, h6: 220, h24: 220 });
  const sedate = mk({ m5: 3, h1: 22, h6: 30, h24: 30 });
  const { scored } = rankCandidates([sedate, parabolic], resolvePreset('gamble'));
  assert.equal(scored.length, 2);
  assert.equal(scored[0].candidate.symbol, 'FROGGO');
  assert.ok(scored[0].parts.momentum.raw > 0.8, 'the parabolic one should now lead on momentum');
});
