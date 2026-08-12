// Network-facing half of safety.js: the RPC fallback chain, mint-account
// parsing (including Token-2022 extensions), RugCheck parsing, and the
// guarantee that a failed check becomes "unverified" rather than "safe".

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = undefined; // exercise the in-memory cache path

const { fetchMintAuthorities, fetchRugcheckSummary, vetToken, sellSideBlocked } =
  await import('../src/safety.js');
const { cacheClear } = await import('../src/cache.js');

const realFetch = globalThis.fetch;
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    const res = await handler(String(url), opts);
    if (!res) throw new Error('unreachable');
    return res;
  };
  return calls;
}

const mintAccount = (info, owner = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') =>
  ok({ jsonrpc: '2.0', id: 1, result: { value: { owner, data: { parsed: { info } } } } });

test.beforeEach(() => cacheClear());
test.afterEach(() => { globalThis.fetch = realFetch; });

test('reads mint and freeze authority from a plain SPL mint', async () => {
  stubFetch(async () => mintAccount({ mintAuthority: 'Dev111', freezeAuthority: null, decimals: 6, supply: '1' }));
  const info = await fetchMintAuthorities('mint1');
  assert.equal(info.mintAuthority, 'Dev111');
  assert.equal(info.freezeAuthority, null);
  assert.equal(info.program, 'spl-token');
  assert.equal(info.transferFeeBps, null);
});

test('falls through to the next RPC when the first is down', async () => {
  let attempt = 0;
  const calls = stubFetch(async () => {
    attempt++;
    if (attempt === 1) return null;                       // endpoint one dead
    return mintAccount({ mintAuthority: null, freezeAuthority: null });
  });
  const info = await fetchMintAuthorities('mint1');
  assert.equal(calls.length, 2, 'second endpoint is tried');
  assert.notEqual(calls[0], calls[1], 'a different endpoint is used');
  assert.equal(info.mintAuthority, null);
});

test('throws only after every RPC endpoint has failed', async () => {
  const calls = stubFetch(async () => null);
  await assert.rejects(() => fetchMintAuthorities('mint1'));
  assert.equal(calls.length, 3, 'all three endpoints are attempted');
});

test('a JSON-RPC error payload is a failure, not a null authority', async () => {
  stubFetch(async () => ok({ jsonrpc: '2.0', id: 1, error: { message: 'rate limited' } }));
  await assert.rejects(() => fetchMintAuthorities('mint1'), /rate limited/);
});

test('an unparseable or missing mint account is a failure', async () => {
  stubFetch(async () => ok({ jsonrpc: '2.0', id: 1, result: { value: null } }));
  await assert.rejects(() => fetchMintAuthorities('mint1'), /not found/);

  cacheClear();
  stubFetch(async () => ok({ jsonrpc: '2.0', id: 1, result: { value: { owner: 'x', data: 'base64gunk' } } }));
  await assert.rejects(() => fetchMintAuthorities('mint2'), /not parseable/);
});

test('reads a Token-2022 transfer fee from the extension list', async () => {
  stubFetch(async () => mintAccount({
    mintAuthority: null,
    freezeAuthority: null,
    extensions: [
      { extension: 'transferFeeConfig', state: { newerTransferFee: { transferFeeBasisPoints: 2500 }, olderTransferFee: { transferFeeBasisPoints: 100 } } },
    ],
  }, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'));
  const info = await fetchMintAuthorities('mint2022');
  assert.equal(info.transferFeeBps, 2500);
  assert.equal(info.program, 'token-2022');
});

test('unrelated Token-2022 extensions do not invent a fee', async () => {
  stubFetch(async () => mintAccount({
    mintAuthority: null, freezeAuthority: null,
    extensions: [{ extension: 'metadataPointer', state: {} }, { extension: 'tokenMetadata', state: {} }],
  }, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'));
  const info = await fetchMintAuthorities('mint2022b');
  assert.equal(info.transferFeeBps, null);
});

test('RugCheck risks are normalised and the score is read from either field', async () => {
  stubFetch(async () => ok({
    score_normalised: 62,
    risks: [{ name: 'Large Amount of LP Unlocked', level: 'DANGER', description: 'd' }, { name: 'Low liquidity', level: 'warn' }],
  }));
  const r = await fetchRugcheckSummary('mint1');
  assert.equal(r.score, 62);
  assert.equal(r.risks[0].level, 'danger', 'level is lowercased for comparison');
  assert.equal(r.risks[1].name, 'Low liquidity');

  cacheClear();
  stubFetch(async () => ok({ score: 12, risks: null }));
  const r2 = await fetchRugcheckSummary('mint2');
  assert.equal(r2.score, 12);
  assert.deepEqual(r2.risks, [], 'a null risks field is an empty list, not a crash');
});

test('vetToken merges both providers into one verdict', async () => {
  stubFetch(async (url) => {
    if (url.includes('rugcheck')) return ok({ score: 5, risks: [] });
    return mintAccount({ mintAuthority: null, freezeAuthority: null });
  });
  const v = await vetToken('good-mint');
  assert.equal(v.verdict, 'pass');
  assert.equal(v.checked.length, 2);
  assert.equal(v.unverified.length, 0);
});

test('one provider down leaves the other counted and the gap reported', async () => {
  stubFetch(async (url) => {
    if (url.includes('rugcheck')) return null;
    return mintAccount({ mintAuthority: null, freezeAuthority: null });
  });
  const v = await vetToken('half-mint');
  assert.equal(v.verdict, 'pass');
  assert.deepEqual(v.checked, ['Mint & freeze authority']);
  assert.equal(v.unverified.length, 1);
  assert.match(v.unverified[0], /RugCheck/);
});

test('both providers down never yields a clean bill of health', async () => {
  stubFetch(async () => null);
  const v = await vetToken('dark-mint');
  assert.equal(v.checked.length, 0);
  assert.equal(v.unverified.length, 2);
  assert.equal(v.rejections.length, 0, 'unknown is not the same as dangerous');
});

test('a live mint authority rejects even when RugCheck is happy', async () => {
  stubFetch(async (url) => {
    if (url.includes('rugcheck')) return ok({ score: 1, risks: [] });
    return mintAccount({ mintAuthority: 'Dev111', freezeAuthority: null });
  });
  const v = await vetToken('minty');
  assert.equal(v.verdict, 'reject');
  assert.match(v.rejections[0], /print unlimited/);
});

test('results are cached, so a repeated vet makes no new requests', async () => {
  const calls = stubFetch(async (url) => {
    if (url.includes('rugcheck')) return ok({ score: 5, risks: [] });
    return mintAccount({ mintAuthority: null, freezeAuthority: null });
  });
  await vetToken('cached-mint');
  const afterFirst = calls.length;
  await vetToken('cached-mint');
  assert.equal(calls.length, afterFirst, 'second vet is served from cache');
});

test('sellSideBlocked needs a real sample before calling honeypot', () => {
  assert.equal(sellSideBlocked({ buys24h: 4000, sells24h: 0 }), true);
  assert.equal(sellSideBlocked({ buys24h: 10, sells24h: 0 }), false, 'ten buys is not evidence');
  assert.equal(sellSideBlocked({ buys24h: 4000, sells24h: 1 }), false);
});
