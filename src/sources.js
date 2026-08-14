// Free, keyless data sources. Every source is independently fail-soft: if one
// is down or rate-limited we record it and score on whatever else came back.

import { CONFIG, heliusRpcUrl } from './config.js';

const DEX = 'https://api.dexscreener.com';
const GECKO = 'https://api.geckoterminal.com/api/v2';
const JUP = 'https://lite-api.jup.ag';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { timeoutMs, retries } = CONFIG.fetch) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

const isSolana = (chain) => String(chain || '').toLowerCase() === 'solana';

/**
 * Collect Solana token addresses from every discovery endpoint we can reach.
 * @param {(msg: string) => void} log
 * @returns {Promise<{seeds: Map<string, object>, failures: string[]}>}
 */
export async function discoverCandidates(log = () => {}) {
  const seeds = new Map(); // address -> { boostAmount, hasProfile, icon, sources[] }
  const failures = [];

  const add = (address, source, patch = {}) => {
    if (!address) return;
    const cur = seeds.get(address) || { boostAmount: 0, hasProfile: false, icon: '', sources: [] };
    cur.boostAmount = Math.max(cur.boostAmount, patch.boostAmount || 0);
    cur.hasProfile = cur.hasProfile || !!patch.hasProfile;
    cur.icon = cur.icon || patch.icon || '';
    if (!cur.sources.includes(source)) cur.sources.push(source);
    seeds.set(address, cur);
  };

  // Every list endpoint gets the same treatment: a non-array response counts as
  // zero rows rather than throwing, so an API changing shape degrades to "that
  // source found nothing" instead of taking the whole scan down.
  const rowsOf = (v) => (Array.isArray(v) ? v : Array.isArray(v?.data) ? v.data : []);

  const tasks = [
    {
      name: 'DexScreener boosts (latest)',
      run: async () => {
        let n = 0;
        for (const r of rowsOf(await getJson(`${DEX}/token-boosts/latest/v1`))) {
          if (!isSolana(r?.chainId)) continue;
          add(r.tokenAddress, 'boosts-latest', { boostAmount: r.totalAmount || r.amount || 0, icon: r.icon });
          n++;
        }
        return n;
      },
    },
    {
      name: 'DexScreener boosts (top)',
      run: async () => {
        let n = 0;
        for (const r of rowsOf(await getJson(`${DEX}/token-boosts/top/v1`))) {
          if (!isSolana(r?.chainId)) continue;
          add(r.tokenAddress, 'boosts-top', { boostAmount: r.totalAmount || r.amount || 0, icon: r.icon });
          n++;
        }
        return n;
      },
    },
    {
      name: 'DexScreener profiles',
      run: async () => {
        let n = 0;
        for (const r of rowsOf(await getJson(`${DEX}/token-profiles/latest/v1`))) {
          if (!isSolana(r?.chainId)) continue;
          add(r.tokenAddress, 'profiles', { hasProfile: true, icon: r.icon });
          n++;
        }
        return n;
      },
    },
    {
      name: 'GeckoTerminal new pools',
      run: async () => {
        let n = 0;
        // Three pages rather than two: on a one-hour window this is the only
        // feed that will have anything, and Solana launches fast.
        for (const page of [1, 2, 3]) {
          const body = await getJson(`${GECKO}/networks/solana/new_pools?page=${page}`);
          for (const row of rowsOf(body)) {
            const id = row?.relationships?.base_token?.data?.id || '';
            if (!id) continue;
            add(id.replace(/^solana_/, ''), 'gecko-new');
            n++;
          }
        }
        return n;
      },
    },
    {
      name: 'GeckoTerminal trending pools',
      run: async () => {
        let n = 0;
        for (const row of rowsOf(await getJson(`${GECKO}/networks/solana/trending_pools?duration=1h`))) {
          const id = row?.relationships?.base_token?.data?.id || '';
          if (!id) continue;
          add(id.replace(/^solana_/, ''), 'gecko-trending');
          n++;
        }
        return n;
      },
    },
  ];

  const results = await Promise.allSettled(tasks.map((t) => t.run()));
  const diagnostics = results.map((r, i) => ({
    name: tasks[i].name,
    ok: r.status === 'fulfilled',
    count: r.status === 'fulfilled' ? r.value : 0,
    error: r.status === 'rejected' ? (r.reason?.message || 'error') : null,
  }));

  for (const d of diagnostics) {
    if (!d.ok) {
      failures.push(d.name);
      log(`⚠ ${d.name} unavailable (${d.error}) — continuing without it`);
    } else if (d.count === 0) {
      // Reached it, got nothing: either a quiet market or a changed response
      // shape. Worth surfacing rather than hiding behind a tick.
      failures.push(`${d.name} (returned nothing)`);
      log(`⚠ ${d.name} responded but returned 0 Solana tokens`);
    } else {
      log(`✓ ${d.name} — ${d.count} tokens`);
    }
  }

  return { seeds, failures, diagnostics };
}

/**
 * Fetch full pair metrics for the seed addresses, 30 at a time, and keep each
 * token's deepest pool.
 * @returns {Promise<Map<string, object>>} address -> best pair
 */
export async function hydratePairs(addresses, log = () => {}) {
  const best = new Map();
  const { batchSize, maxBatches, interBatchDelayMs } = CONFIG.fetch;
  const batches = [];
  for (let i = 0; i < addresses.length && batches.length < maxBatches; i += batchSize) {
    batches.push(addresses.slice(i, i + batchSize));
  }

  for (const [i, batch] of batches.entries()) {
    log(`Loading market data ${i + 1}/${batches.length}…`);
    try {
      const body = await getJson(`${DEX}/latest/dex/tokens/${batch.join(',')}`);
      for (const pair of body?.pairs || []) {
        if (!isSolana(pair?.chainId)) continue;
        const addr = pair?.baseToken?.address;
        if (!addr) continue;
        const prev = best.get(addr);
        const liq = pair?.liquidity?.usd || 0;
        if (!prev || liq > (prev.liquidity?.usd || 0)) best.set(addr, pair);
      }
    } catch (err) {
      log(`⚠ market data batch ${i + 1} failed (${err.message}) — skipping those tokens`);
    }
    if (i < batches.length - 1) await sleep(interBatchDelayMs);
  }

  return best;
}

/**
 * Current market cap / price for an arbitrary address list — used to grade past
 * picks. Returns whatever it could get; missing entries just stay ungraded.
 * @returns {Promise<Map<string, {fdv: number, priceUsd: number}>>}
 */
export async function fetchCurrentMarketCaps(addresses) {
  const out = new Map();
  const { batchSize } = CONFIG.fetch;
  for (let i = 0; i < addresses.length; i += batchSize) {
    const batch = addresses.slice(i, i + batchSize);
    try {
      const body = await getJson(`${DEX}/latest/dex/tokens/${batch.join(',')}`);
      for (const pair of body?.pairs || []) {
        const addr = pair?.baseToken?.address;
        if (!addr || !isSolana(pair?.chainId)) continue;
        const fdv = Number(pair?.fdv ?? pair?.marketCap) || 0;
        const prev = out.get(addr);
        // Keep the deepest pool's view, same rule as hydration.
        const liq = Number(pair?.liquidity?.usd) || 0;
        if (!prev || liq > prev._liq) {
          out.set(addr, {
            fdv,
            priceUsd: Number(pair?.priceUsd) || 0,
            // Needed to pull OHLCV history for the track record.
            pairAddress: pair?.pairAddress || '',
            liquidity: liq,
            // The entry maths reconstructs past market caps from these, so a
            // refresh must move them together with the cap or the two disagree.
            chg5m: Number(pair?.priceChange?.m5) || 0,
            chg1h: Number(pair?.priceChange?.h1) || 0,
            chg6h: Number(pair?.priceChange?.h6) || 0,
            chg24h: Number(pair?.priceChange?.h24) || 0,
            vol1: Number(pair?.volume?.h1) || 0,
            vol6: Number(pair?.volume?.h6) || 0,
            _liq: liq,
          });
        }
      }
    } catch {
      // Ungraded rows are honest; a failed grade must not break the page.
    }
  }
  return out;
}

/**
 * Highest price a pool traded at since `sinceMs`, from GeckoTerminal's free
 * OHLCV history.
 *
 * This exists to answer the only question that matters when picks are losing:
 * did the coin ever run before it died? A pick that went 5x and came back is a
 * missing exit signal; one that only ever went down is a bad pick. "Market cap
 * now" cannot tell those apart and they need opposite fixes.
 *
 * @returns {Promise<{peak: number|null, reason: string|null}>} reason names the
 *   failure so a missing column can be explained instead of shrugged at.
 */
export async function fetchPeakSince(poolAddress, sinceMs, now = Date.now()) {
  if (!poolAddress || !(sinceMs > 0)) return { peak: null, reason: 'no pool address' };
  const ageHours = (now - sinceMs) / 3_600_000;
  // Hourly candles are too coarse for a pick made minutes ago.
  const timeframe = ageHours <= 6 ? 'minute?aggregate=5&limit=200' : 'hour?aggregate=1&limit=168';

  try {
    // No retry: these run one per tracked pick, and retrying a rate-limited
    // call just doubles the load that caused the rate limit.
    const body = await getJson(
      `${GECKO}/networks/solana/pools/${poolAddress}/ohlcv/${timeframe}`,
      { timeoutMs: CONFIG.fetch.timeoutMs, retries: 0 },
    );
    const candles = body?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(candles) || !candles.length) return { peak: null, reason: 'no price history' };

    const sinceSec = sinceMs / 1000;
    let peak = null;
    for (const candle of candles) {
      // [timestamp, open, high, low, close, volume]
      if (!Array.isArray(candle) || candle.length < 3) continue;
      const ts = Number(candle[0]);
      const high = Number(candle[2]);
      if (!Number.isFinite(ts) || !Number.isFinite(high)) continue;
      if (ts < sinceSec) continue;             // before we picked it — not ours
      if (peak == null || high > peak) peak = high;
    }
    return { peak, reason: peak == null ? 'no candles since the pick' : null };
  } catch (err) {
    // Ungraded is honest; never break the table over it.
    return { peak: null, reason: err?.message === 'HTTP 429' ? 'rate limited' : (err?.message || 'unavailable') };
  }
}

/** Best-effort Jupiter verified set. Failure is silent — it is a bonus only. */
export async function fetchJupiterVerified() {
  try {
    const rows = await getJson(`${JUP}/tokens/v2/tag?query=verified`, { timeoutMs: 8000, retries: 0 });
    const set = new Set();
    for (const r of rows || []) if (r?.id) set.add(r.id);
    return set;
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// v2 / paid providers. Each returns null while its key is empty, so the caller
// can merge the result unconditionally. Wire the bodies up when a key exists.
// ---------------------------------------------------------------------------

/** Accounts owned by this program are ordinary wallets; anything else is a PDA. */
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

async function heliusRpc(method, params, timeoutMs = 9000) {
  const url = heliusRpcUrl();
  if (!url) throw new Error('no Helius key');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || 'rpc error');
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

const amountOf = (v) => {
  const n = Number(v?.uiAmountString ?? v?.uiAmount);
  return Number.isFinite(n) ? n : 0;
};

/**
 * What share of supply the ten largest *wallets* hold.
 *
 * The subtlety is that the single largest token account is almost always the
 * AMM's own liquidity vault, which is not a holder in any meaningful sense —
 * counting it would reject every healthy coin on the board. Rather than
 * maintaining a list of AMM program addresses that goes stale, this asks the
 * chain a general question: a real holder's wallet is owned by the System
 * Program, while a pool vault, bonding curve or staking account is owned by
 * (or is) a program. Anything not plainly a wallet is excluded.
 *
 * Never throws. Returns null when the answer could not be obtained, which the
 * caller must treat as "unknown" and never as "fine" — an absent check is not
 * a pass.
 *
 * @returns {Promise<{top10SharePct: number, countedHolders: number, excluded: number}|null>}
 */
export async function fetchHolderConcentration(address) {
  if (!CONFIG.paid.heliusApiKey || !address) return null;
  try {
    const [supplyRes, largest] = await Promise.all([
      heliusRpc('getTokenSupply', [address]),
      heliusRpc('getTokenLargestAccounts', [address]),
    ]);

    const supply = amountOf(supplyRes?.value);
    const accounts = (largest?.value || []).filter((a) => a?.address);
    if (!(supply > 0) || !accounts.length) return null;

    // token account -> the address that controls it
    const parsed = await heliusRpc('getMultipleAccounts',
      [accounts.map((a) => a.address), { encoding: 'jsonParsed' }]);
    const owners = (parsed?.value || []).map((v) => v?.data?.parsed?.info?.owner || null);
    if (owners.length !== accounts.length) return null;

    // ...and whether each of those is a plain wallet or a program-controlled account.
    const unique = [...new Set(owners.filter(Boolean))];
    const ownerInfo = unique.length
      ? await heliusRpc('getMultipleAccounts', [unique, { encoding: 'base64' }])
      : { value: [] };
    const isWallet = new Map();
    unique.forEach((owner, i) => {
      const acct = ownerInfo?.value?.[i];
      // A missing account is a PDA that has never been funded — never a holder.
      isWallet.set(owner, !!acct && acct.owner === SYSTEM_PROGRAM && !acct.executable);
    });

    const held = [];
    let excluded = 0;
    accounts.forEach((a, i) => {
      const owner = owners[i];
      if (!owner || !isWallet.get(owner)) { excluded += 1; return; }
      held.push(amountOf(a));
    });
    if (!held.length) return null;

    held.sort((x, y) => y - x);
    const top10 = held.slice(0, 10).reduce((s, n) => s + n, 0);
    return {
      top10SharePct: (top10 / supply) * 100,
      countedHolders: held.length,
      excluded,
    };
  } catch {
    // Fail soft and silent: this is an enrichment, and a rate-limited Helius
    // must not take a scan down.
    return null;
  }
}

export async function fetchRugcheckScore(_address) {
  if (!CONFIG.paid.rugcheckApiKey) return null;
  // RugCheck report -> mint/freeze authority, LP burn %, honeypot detection.
  return null;
}

export async function fetchSocialVelocity(_symbol) {
  if (!CONFIG.paid.xBearerToken) return null;
  // X recent-search counts bucketed by hour -> mentions/hour acceleration,
  // the single strongest leading indicator we cannot get for free.
  return null;
}

export async function fetchBirdeyeOhlcv(_address) {
  if (!CONFIG.paid.birdeyeApiKey) return null;
  // Birdeye 1m OHLCV -> true acceleration + real holder counts.
  return null;
}
