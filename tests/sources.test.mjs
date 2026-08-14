// Exercises the network layer with a stubbed fetch: batching, deepest-pool
// selection, chain filtering, per-source failure isolation and the diagnostics
// that make a changed API shape visible.

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = undefined;

const { discoverCandidates, hydratePairs, fetchCurrentMarketCaps, fetchJupiterVerified, fetchHolderConcentration } =
  await import('../src/sources.js');

const realFetch = globalThis.fetch;
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

/** Install a fetch stub; returns the list of URLs requested. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    const res = await handler(String(url), opts);
    if (!res) throw new Error('connection refused');
    return res;
  };
  return calls;
}

test.afterEach(() => { globalThis.fetch = realFetch; });

const pair = (addr, over = {}) => ({
  chainId: 'solana',
  baseToken: { address: addr, symbol: addr.slice(0, 4), name: addr },
  liquidity: { usd: 100_000 },
  fdv: 1_000_000,
  priceUsd: '0.01',
  ...over,
});

test('hydrate batches addresses 30 at a time', async () => {
  const addresses = Array.from({ length: 65 }, (_, i) => `addr${i}`);
  const calls = stubFetch(async (url) => {
    const wanted = decodeURIComponent(url.split('/tokens/')[1]).split(',');
    return ok({ pairs: wanted.map((a) => pair(a)) });
  });

  const out = await hydratePairs(addresses);
  assert.equal(calls.length, 3, '65 addresses is three batches of at most 30');
  assert.equal(decodeURIComponent(calls[0].split('/tokens/')[1]).split(',').length, 30);
  assert.equal(decodeURIComponent(calls[2].split('/tokens/')[1]).split(',').length, 5);
  assert.equal(out.size, 65);
});

test('hydrate keeps the deepest pool when a token has several', async () => {
  stubFetch(async () => ok({
    pairs: [
      pair('tok', { liquidity: { usd: 10_000 }, dexId: 'shallow' }),
      pair('tok', { liquidity: { usd: 900_000 }, dexId: 'deep' }),
      pair('tok', { liquidity: { usd: 50_000 }, dexId: 'middle' }),
    ],
  }));
  const out = await hydratePairs(['tok']);
  assert.equal(out.size, 1);
  assert.equal(out.get('tok').dexId, 'deep');
});

test('hydrate ignores pairs from other chains', async () => {
  stubFetch(async () => ok({
    pairs: [pair('sol1'), { ...pair('eth1'), chainId: 'ethereum' }, { ...pair('base1'), chainId: 'base' }],
  }));
  const out = await hydratePairs(['sol1', 'eth1', 'base1']);
  assert.deepEqual([...out.keys()], ['sol1']);
});

test('a transient batch failure is retried and recovers', async () => {
  let firstAttempt = true;
  const calls = stubFetch(async (url) => {
    if (firstAttempt) { firstAttempt = false; return null; }  // one blip
    const wanted = decodeURIComponent(url.split('/tokens/')[1]).split(',');
    return ok({ pairs: wanted.map((a) => pair(a)) });
  });
  const out = await hydratePairs(Array.from({ length: 30 }, (_, i) => `a${i}`));
  assert.equal(calls.length, 2, 'the failed request is retried once');
  assert.equal(out.size, 30, 'the retry recovers the whole batch');
});

test('a batch that fails every attempt is dropped, never fabricated', async () => {
  const dead = new Set(['a0']);  // whichever batch contains a0 always fails
  stubFetch(async (url) => {
    const wanted = decodeURIComponent(url.split('/tokens/')[1]).split(',');
    if (wanted.some((a) => dead.has(a))) return null;
    return ok({ pairs: wanted.map((a) => pair(a)) });
  });
  const addresses = Array.from({ length: 60 }, (_, i) => `a${i}`);
  const out = await hydratePairs(addresses);
  assert.equal(out.size, 30, 'only the surviving batch is returned');
  assert.equal(out.has('a0'), false, 'nothing is invented for the dead batch');
  assert.equal(out.has('a30'), true);
});

test('hydrate tolerates a response with no pairs array', async () => {
  stubFetch(async () => ok({ unexpected: 'shape' }));
  const out = await hydratePairs(['a']);
  assert.equal(out.size, 0);
});

test('discovery reports per-source counts and isolates failures', async () => {
  stubFetch(async (url) => {
    if (url.includes('token-boosts/latest')) {
      return ok([
        { chainId: 'solana', tokenAddress: 'sol-a', totalAmount: 500 },
        { chainId: 'ethereum', tokenAddress: 'eth-a', totalAmount: 900 },
      ]);
    }
    if (url.includes('token-boosts/top')) return ok([{ chainId: 'solana', tokenAddress: 'sol-b', totalAmount: 100 }]);
    if (url.includes('token-profiles')) return null;                       // hard failure
    if (url.includes('new_pools')) return ok({ data: [] });                // responds, empty
    if (url.includes('trending_pools')) {
      return ok({ data: [{ relationships: { base_token: { data: { id: 'solana_sol-a' } } } }] });
    }
    return ok({});
  });

  const { seeds, failures, diagnostics } = await discoverCandidates();

  assert.deepEqual([...seeds.keys()].sort(), ['sol-a', 'sol-b'], 'non-Solana rows are dropped');
  assert.equal(seeds.get('sol-a').boostAmount, 500);
  assert.deepEqual(seeds.get('sol-a').sources, ['boosts-latest', 'gecko-trending'],
    'corroborating sources accumulate');

  const byName = Object.fromEntries(diagnostics.map((d) => [d.name, d]));
  assert.equal(byName['DexScreener boosts (latest)'].count, 1);
  assert.equal(byName['DexScreener profiles'].ok, false);
  assert.equal(byName['GeckoTerminal new pools'].count, 0);
  // Both a failure and a silent zero must be surfaced.
  assert.ok(failures.some((f) => f.includes('profiles')));
  assert.ok(failures.some((f) => f.includes('returned nothing')));
});

test('discovery treats a non-array response as zero rows, not a crash', async () => {
  stubFetch(async () => ok({ message: 'rate limited' }));
  const { seeds, diagnostics } = await discoverCandidates();
  assert.equal(seeds.size, 0);
  assert.ok(diagnostics.every((d) => d.count === 0));
});

test('discovery keeps the largest boost amount seen for a token', async () => {
  stubFetch(async (url) => {
    if (url.includes('token-boosts/latest')) return ok([{ chainId: 'solana', tokenAddress: 'x', totalAmount: 50 }]);
    if (url.includes('token-boosts/top')) return ok([{ chainId: 'solana', tokenAddress: 'x', totalAmount: 5000 }]);
    return ok([]);
  });
  const { seeds } = await discoverCandidates();
  assert.equal(seeds.get('x').boostAmount, 5000);
});

test('current market caps return the price-change window for the entry maths', async () => {
  stubFetch(async () => ok({
    pairs: [pair('tok', {
      fdv: 2_500_000,
      priceUsd: '0.05',
      priceChange: { m5: 1, h1: 12, h6: 30, h24: 80 },
      volume: { h1: 50_000, h6: 200_000 },
    })],
  }));
  const out = await fetchCurrentMarketCaps(['tok']);
  const row = out.get('tok');
  assert.equal(row.fdv, 2_500_000);
  assert.equal(row.priceUsd, 0.05);
  assert.equal(row.chg1h, 12);
  assert.equal(row.chg6h, 30);
  assert.equal(row.vol1, 50_000);
});

test('current market caps never throw on a dead endpoint', async () => {
  stubFetch(async () => null);
  const out = await fetchCurrentMarketCaps(['tok']);
  assert.equal(out.size, 0);
});

test('the Jupiter list failing is silent and yields an empty set', async () => {
  stubFetch(async () => null);
  const set = await fetchJupiterVerified();
  assert.ok(set instanceof Set);
  assert.equal(set.size, 0);
});

test('an HTTP error status is treated as a failure, not as data', async () => {
  stubFetch(async () => ({ ok: false, status: 429, json: async () => ({}) }));
  const out = await hydratePairs(['a']);
  assert.equal(out.size, 0);
  const { seeds } = await discoverCandidates();
  assert.equal(seeds.size, 0);
});

// --- Helius holder concentration -------------------------------------------
// The one fact free market data cannot give us: how much of the supply sits in
// a handful of wallets that can end the coin in a single transaction.

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const rpcMethod = (opts) => { try { return JSON.parse(opts?.body || '{}').method; } catch { return null; } };

/**
 * @param holders [uiAmount, isWallet][] — the largest token accounts and
 *                whether each is controlled by a plain wallet or a program.
 */
const heliusStub = (supply, holders) => async (url, opts) => {
  if (!url.includes('helius')) return null;
  switch (rpcMethod(opts)) {
    case 'getTokenSupply':
      return ok({ result: { value: { uiAmountString: String(supply) } } });
    case 'getTokenLargestAccounts':
      return ok({ result: { value: holders.map(([amount], i) =>
        ({ address: `TA${i}`, uiAmountString: String(amount) })) } });
    case 'getMultipleAccounts':
      return JSON.parse(opts.body).params[1].encoding === 'jsonParsed'
        ? ok({ result: { value: holders.map((_, i) => ({ data: { parsed: { info: { owner: `OWNER${i}` } } } })) } })
        : ok({ result: { value: holders.map(([, isWallet]) =>
          ({ owner: isWallet ? SYSTEM_PROGRAM : 'SomeAmmProgram', executable: false })) } });
    default:
      return null;
  }
};

test('holder concentration is the share held by real wallets, pool excluded', async () => {
  stubFetch(heliusStub(1000, [[600, false], [200, true], [50, true]]));
  const r = await fetchHolderConcentration('mint1');
  // 600 sits in the AMM vault and is not a holding; 250 of 1000 is.
  assert.equal(Math.round(r.top10SharePct), 25);
  assert.equal(r.countedHolders, 2);
  assert.equal(r.excluded, 1, 'the program-owned account is excluded');
});

test('only the ten largest wallets count toward the share', async () => {
  const twelve = Array.from({ length: 12 }, () => [10, true]);
  stubFetch(heliusStub(1000, twelve));
  const r = await fetchHolderConcentration('mint1');
  assert.equal(Math.round(r.top10SharePct), 10, '10 x 10 of 1000, not 12 x 10');
});

test('an owner account that does not exist on chain is never a holder', async () => {
  // A PDA that has never been funded returns null from getMultipleAccounts.
  stubFetch(async (url, opts) => {
    if (rpcMethod(opts) === 'getMultipleAccounts'
      && JSON.parse(opts.body).params[1].encoding === 'base64') {
      return ok({ result: { value: [null] } });
    }
    return heliusStub(1000, [[900, true]])(url, opts);
  });
  const r = await fetchHolderConcentration('mint1');
  assert.equal(r, null, 'with nothing countable there is no answer to give');
});

test('a Helius failure returns null rather than throwing', async () => {
  stubFetch(async () => null);
  assert.equal(await fetchHolderConcentration('mint1'), null);

  stubFetch(async () => ({ ok: false, status: 429, json: async () => ({}) }));
  assert.equal(await fetchHolderConcentration('mint1'), null);

  stubFetch(async () => ok({ error: { message: 'rate limited' } }));
  assert.equal(await fetchHolderConcentration('mint1'), null);
});

test('a zero or missing supply is unknown, not a zero share', async () => {
  stubFetch(heliusStub(0, [[10, true]]));
  assert.equal(await fetchHolderConcentration('mint1'), null);
});

test('no address means no request at all', async () => {
  const calls = stubFetch(async () => ok({}));
  assert.equal(await fetchHolderConcentration(''), null);
  assert.equal(calls.length, 0);
});
