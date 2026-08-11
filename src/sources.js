// Free, keyless data sources. Every source is independently fail-soft: if one
// is down or rate-limited we record it and score on whatever else came back.

import { CONFIG } from './config.js';

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

  const tasks = [
    {
      name: 'DexScreener boosts (latest)',
      run: async () => {
        const rows = await getJson(`${DEX}/token-boosts/latest/v1`);
        for (const r of rows || []) {
          if (!isSolana(r.chainId)) continue;
          add(r.tokenAddress, 'boosts-latest', { boostAmount: r.totalAmount || r.amount || 0, icon: r.icon });
        }
      },
    },
    {
      name: 'DexScreener boosts (top)',
      run: async () => {
        const rows = await getJson(`${DEX}/token-boosts/top/v1`);
        for (const r of rows || []) {
          if (!isSolana(r.chainId)) continue;
          add(r.tokenAddress, 'boosts-top', { boostAmount: r.totalAmount || r.amount || 0, icon: r.icon });
        }
      },
    },
    {
      name: 'DexScreener profiles',
      run: async () => {
        const rows = await getJson(`${DEX}/token-profiles/latest/v1`);
        for (const r of rows || []) {
          if (!isSolana(r.chainId)) continue;
          add(r.tokenAddress, 'profiles', { hasProfile: true, icon: r.icon });
        }
      },
    },
    {
      name: 'GeckoTerminal new pools',
      run: async () => {
        for (const page of [1, 2]) {
          const body = await getJson(`${GECKO}/networks/solana/new_pools?page=${page}`);
          for (const row of body?.data || []) {
            const id = row?.relationships?.base_token?.data?.id || '';
            add(id.replace(/^solana_/, ''), 'gecko-new');
          }
        }
      },
    },
    {
      name: 'GeckoTerminal trending pools',
      run: async () => {
        const body = await getJson(`${GECKO}/networks/solana/trending_pools?duration=1h`);
        for (const row of body?.data || []) {
          const id = row?.relationships?.base_token?.data?.id || '';
          add(id.replace(/^solana_/, ''), 'gecko-trending');
        }
      },
    },
  ];

  const results = await Promise.allSettled(tasks.map((t) => t.run()));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      failures.push(tasks[i].name);
      log(`⚠ ${tasks[i].name} unavailable (${r.reason?.message || 'error'}) — continuing without it`);
    } else {
      log(`✓ ${tasks[i].name}`);
    }
  });

  return { seeds, failures };
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

export async function fetchHolderConcentration(_address) {
  if (!CONFIG.paid.heliusApiKey) return null;
  // Helius `getTokenLargestAccounts` -> top-10 share of supply. A top-10 share
  // above ~30% is a rug waiting to happen and should become a hard filter.
  return null;
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
