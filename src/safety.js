// Contract-level rug checks — the things market data cannot see.
//
// Design rule: safety fails CLOSED on a bad answer and LOUD on no answer.
// A check that returns "this is dangerous" rejects the coin outright. A check
// that cannot run at all never silently passes it — the coin is marked
// unverified, penalised, and the gap is shown on the card.

import { cached } from './cache.js';
import { CONFIG, heliusRpcUrl } from './config.js';
import { fetchHolderConcentration } from './sources.js';

/**
 * Contract facts barely change, so cache them hard. This is what keeps the
 * free public RPCs from rate-limiting us across repeated clicks.
 */
const VET_TTL_MS = 15 * 60 * 1000;

/**
 * Helius first when a key is set — it is a private endpoint, so the mint and
 * freeze checks stop being rate-limited into `unverified`, which costs a coin
 * `CONFIG.safety.unverifiedPenalty` points through no fault of its own. The
 * public RPCs stay as fallbacks so a Helius outage or a spent quota degrades
 * to the old behaviour rather than blinding the safety layer.
 */
const PUBLIC_RPCS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://solana.drpc.org',
];

export function rpcEndpoints() {
  const helius = heliusRpcUrl();
  return helius ? [helius, ...PUBLIC_RPCS] : [...PUBLIC_RPCS];
}

const RUGCHECK = 'https://api.rugcheck.xyz/v1/tokens';

const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** Max transfer-fee (bps) we tolerate on a Token-2022 mint before calling it a trap. */
const MAX_TRANSFER_FEE_BPS = 1000; // 10%

async function withTimeout(promise, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await promise(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Try each public RPC in turn; first one that answers wins. */
async function rpcCall(method, params, timeoutMs = 9000) {
  let lastErr;
  for (const endpoint of rpcEndpoints()) {
    try {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
      const res = await withTimeout((signal) => fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal,
      }), timeoutMs);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || 'rpc error');
      return json.result;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('all RPC endpoints failed');
}

/**
 * Read the mint account: who can still print, who can still freeze, and any
 * Token-2022 transfer fee. This is the highest-signal free check that exists.
 * @returns {Promise<{mintAuthority: string|null, freezeAuthority: string|null,
 *                    transferFeeBps: number|null, program: string}>}
 */
export async function fetchMintAuthorities(mint) {
  const result = await rpcCall('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
  const value = result?.value;
  if (!value) throw new Error('mint account not found');

  const info = value?.data?.parsed?.info;
  if (!info) throw new Error('mint account not parseable');

  let transferFeeBps = null;
  const extensions = info.extensions || [];
  for (const ext of extensions) {
    if (ext?.extension === 'transferFeeConfig') {
      const cfg = ext.state?.newerTransferFee || ext.state?.olderTransferFee;
      const bps = Number(cfg?.transferFeeBasisPoints);
      if (isFinite(bps)) transferFeeBps = Math.max(transferFeeBps ?? 0, bps);
    }
  }

  return {
    mintAuthority: info.mintAuthority ?? null,
    freezeAuthority: info.freezeAuthority ?? null,
    transferFeeBps,
    program: value.owner === TOKEN_2022 ? 'token-2022' : value.owner === SPL_TOKEN ? 'spl-token' : value.owner,
  };
}

/**
 * RugCheck's public summary — free, no key. Covers LP lock state, top-holder
 * concentration and known honeypot patterns, which we cannot compute cheaply.
 * @returns {Promise<{score: number|null, risks: Array<{name,level,description}>}>}
 */
export async function fetchRugcheckSummary(mint) {
  const res = await withTimeout((signal) => fetch(`${RUGCHECK}/${mint}/report/summary`, {
    headers: { accept: 'application/json' },
    signal,
  }), 9000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const risks = Array.isArray(json?.risks) ? json.risks : [];
  const score = isFinite(json?.score_normalised) ? json.score_normalised
    : isFinite(json?.score) ? json.score
    : null;
  return {
    score,
    risks: risks.map((r) => ({
      name: String(r?.name ?? 'unknown risk'),
      level: String(r?.level ?? 'info').toLowerCase(),
      description: String(r?.description ?? ''),
    })),
  };
}

/** Free honeypot tell from data we already have: buyers pile in, nobody exits. */
export function sellSideBlocked(c) {
  return c.buys24h >= 50 && c.sells24h === 0;
}

/**
 * Turn raw check results into a verdict. Pure — unit tested.
 * @param {object} results { mint, mintError, rugcheck, rugcheckError }
 * @returns {{verdict: 'reject'|'pass', rejections: string[], warnings: string[],
 *            unverified: string[], checked: string[]}}
 */
export function evaluateSafety(results = {}, maxShare = CONFIG.filters.maxTop10SharePct) {
  const rejections = [];
  const warnings = [];
  const unverified = [];
  const checked = [];

  const { mint, mintError, rugcheck, rugcheckError } = results;

  if (mint) {
    checked.push('Mint & freeze authority');
    if (mint.mintAuthority) rejections.push('Mint authority is still live — the dev can print unlimited new supply');
    if (mint.freezeAuthority) rejections.push('Freeze authority is still live — your tokens can be frozen so you cannot sell');
    if (mint.transferFeeBps != null && mint.transferFeeBps > MAX_TRANSFER_FEE_BPS) {
      rejections.push(`Token-2022 transfer fee of ${(mint.transferFeeBps / 100).toFixed(1)}% is skimmed off every trade`);
    } else if (mint.transferFeeBps) {
      warnings.push(`Charges a ${(mint.transferFeeBps / 100).toFixed(1)}% transfer fee on every trade`);
    }
  } else {
    unverified.push(`Mint & freeze authority (${mintError || 'check unavailable'})`);
  }

  if (rugcheck) {
    checked.push('RugCheck contract report');
    for (const risk of rugcheck.risks) {
      if (risk.level === 'danger') rejections.push(`RugCheck: ${risk.name}`);
      else if (risk.level === 'warn') warnings.push(`RugCheck: ${risk.name}`);
    }
  } else {
    unverified.push(`RugCheck contract report (${rugcheckError || 'check unavailable'})`);
  }

  // Supply concentration. The threshold lives in CONFIG.filters so the live
  // path and the score-time filter in score.js cannot drift apart.
  const { holders, holdersError } = results;
  if (holders && holders.top10SharePct != null) {
    const share = holders.top10SharePct;
    // Carry the number into the label: "passed" alone tells you nothing about
    // whether the coin scraped through at 29% or is genuinely well spread.
    checked.push(`Top-10 holder concentration (${share.toFixed(0)}% of supply)`);
    if (share > maxShare) {
      rejections.push(`Top 10 wallets hold ${share.toFixed(0)}% of supply — they can end this coin in one transaction`);
    } else if (share > maxShare * 0.6) {
      warnings.push(`Top 10 wallets hold ${share.toFixed(0)}% of supply`);
    }
  } else {
    unverified.push(`Top-10 holder concentration (${holdersError || 'check unavailable'})`);
  }

  return {
    verdict: rejections.length ? 'reject' : 'pass',
    rejections,
    warnings,
    unverified,
    checked,
  };
}

/**
 * Run every contract check for one token. Never throws — a failed check becomes
 * an `unverified` entry rather than a silent pass.
 */
export async function vetToken(address) {
  // Cache each provider separately: a rate-limited RugCheck should not stop us
  // reusing a good mint-authority answer, and vice versa.
  const [mintRes, rugRes, holderRes] = await Promise.allSettled([
    cached(`mint:${address}`, VET_TTL_MS, () => fetchMintAuthorities(address)),
    cached(`rug:${address}`, VET_TTL_MS, () => fetchRugcheckSummary(address)),
    cached(`holders:${address}`, VET_TTL_MS, () => fetchHolderConcentration(address)),
  ]);

  const holders = holderRes.status === 'fulfilled' ? holderRes.value : null;
  return evaluateSafety({
    mint: mintRes.status === 'fulfilled' ? mintRes.value : null,
    mintError: mintRes.status === 'rejected' ? (mintRes.reason?.message || 'error') : null,
    rugcheck: rugRes.status === 'fulfilled' ? rugRes.value : null,
    rugcheckError: rugRes.status === 'rejected' ? (rugRes.reason?.message || 'error') : null,
    holders,
    // fetchHolderConcentration resolves null rather than throwing, so the
    // distinction we can still report is "no key" versus "no usable answer".
    holdersError: holders ? null
      : (holderRes.reason?.message || (heliusRpcUrl() ? 'no usable answer' : 'no Helius key')),
  });
}
