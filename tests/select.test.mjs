import test from 'node:test';
import assert from 'node:assert/strict';

import { vetShortlist } from '../src/select.js';

const CFG = { maxVetted: 10, vetConcurrency: 3, unverifiedPenalty: 8 };

const entry = (symbol, score) => ({ candidate: { symbol, address: `addr-${symbol}` }, score });
const pass = (unverified = []) => ({ verdict: 'pass', rejections: [], warnings: [], unverified, checked: ['a', 'b'].slice(unverified.length) });
const reject = (why) => ({ verdict: 'reject', rejections: [why], warnings: [], unverified: [], checked: ['a', 'b'] });

test('picks the top coin when it passes cleanly', async () => {
  const scored = [entry('A', 90), entry('B', 80), entry('C', 70)];
  const { safeWinner } = await vetShortlist(scored, async () => pass(), () => {}, CFG);
  assert.equal(safeWinner.entry.candidate.symbol, 'A');
});

test('skips rejected coins and takes the next survivor', async () => {
  const scored = [entry('A', 90), entry('B', 80), entry('C', 70)];
  const verdicts = { 'addr-A': reject('mint authority'), 'addr-B': reject('LP unlocked'), 'addr-C': pass() };
  const { safeWinner, rejectedForSafety } = await vetShortlist(scored, async (a) => verdicts[a], () => {}, CFG);
  assert.equal(safeWinner.entry.candidate.symbol, 'C');
  assert.equal(rejectedForSafety.length, 2);
});

test('a fully verified coin outranks a higher-scoring partly verified one', async () => {
  const scored = [entry('A', 84), entry('B', 80)];  // 84 - 8 = 76 < 80
  const verdicts = { 'addr-A': pass(['rugcheck offline']), 'addr-B': pass() };
  const { safeWinner } = await vetShortlist(scored, async (a) => verdicts[a], () => {}, CFG);
  assert.equal(safeWinner.entry.candidate.symbol, 'B');
  assert.equal(safeWinner.effective, 80);
});

test('a partly verified coin still wins when its lead exceeds the penalty', async () => {
  const scored = [entry('A', 95), entry('B', 80)];  // 95 - 8 = 87 > 80
  const verdicts = { 'addr-A': pass(['rugcheck offline']), 'addr-B': pass() };
  const { safeWinner } = await vetShortlist(scored, async (a) => verdicts[a], () => {}, CFG);
  assert.equal(safeWinner.entry.candidate.symbol, 'A');
});

test('stops early once a clean coin is found, sparing the free APIs', async () => {
  const scored = Array.from({ length: 10 }, (_, i) => entry(`T${i}`, 90 - i));
  const seen = [];
  await vetShortlist(scored, async (a) => { seen.push(a); return pass(); }, () => {}, CFG);
  // First batch of three contains a clean pass, so batches 2-4 never run.
  assert.equal(seen.length, 3);
});

test('keeps going while every result is only partly verified', async () => {
  const scored = Array.from({ length: 9 }, (_, i) => entry(`T${i}`, 90 - i));
  const seen = [];
  await vetShortlist(scored, async (a) => { seen.push(a); return pass(['rpc rate limited']); }, () => {}, CFG);
  assert.equal(seen.length, 9, 'no clean coin means the whole shortlist gets checked');
});

test('respects maxVetted', async () => {
  const scored = Array.from({ length: 30 }, (_, i) => entry(`T${i}`, 90 - i));
  const seen = [];
  await vetShortlist(scored, async (a) => { seen.push(a); return reject('nope'); }, () => {}, CFG);
  assert.equal(seen.length, CFG.maxVetted);
});

test('returns no winner when the whole shortlist is rejected', async () => {
  const scored = [entry('A', 90), entry('B', 80)];
  const { safeWinner, rejectedForSafety } = await vetShortlist(scored, async () => reject('rug'), () => {}, CFG);
  assert.equal(safeWinner, null);
  assert.equal(rejectedForSafety.length, 2);
});

test('a crashing vet marks the coin unverified rather than safe', async () => {
  const scored = [entry('A', 90)];
  const { safeWinner, vetted } = await vetShortlist(scored, async () => { throw new Error('boom'); }, () => {}, CFG);
  const safety = vetted.get(scored[0]);
  assert.equal(safety.unverified.length, 1);
  assert.match(safety.unverified[0], /crashed/);
  assert.equal(safety.checked.length, 0);
  assert.equal(safeWinner.effective, 82, 'penalty still applies to a crashed check');
});

test('an empty shortlist is handled without error', async () => {
  const { safeWinner, vetted } = await vetShortlist([], async () => pass(), () => {}, CFG);
  assert.equal(safeWinner, null);
  assert.equal(vetted.size, 0);
});
