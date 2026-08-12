// Contract-level rug checks — the things market data cannot see.
//
// Design rule: safety fails CLOSED on a bad answer and LOUD on no answer.
// A check that returns "this is dangerous" rejects the coin outright. A check
// that cannot run at all never silently passes it — the coin is marked
// unverified, penalised, and the gap is shown on the card.

import { cached } from './cache.js';

/**
 * Contract facts barely change, so cache them hard. This is what keeps the
 * free public RPCs from rate-limiting us across repeated clicks.
 */
const VET_TTL_MS = 15 * 60 * 1000;

const RPC_ENDPOINTS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://solana.drpc.org',
];

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
  for (const endpoint of RPC_ENDPOINTS) {
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
export function evaluateSafety(results = {}) {
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
  const [mintRes, rugRes] = await Promise.allSettled([
    cached(`mint:${address}`, VET_TTL_MS, () => fetchMintAuthorities(address)),
    cached(`rug:${address}`, VET_TTL_MS, () => fetchRugcheckSummary(address)),
  ]);

  return evaluateSafety({
    mint: mintRes.status === 'fulfilled' ? mintRes.value : null,
    mintError: mintRes.status === 'rejected' ? (mintRes.reason?.message || 'error') : null,
    rugcheck: rugRes.status === 'fulfilled' ? rugRes.value : null,
    rugcheckError: rugRes.status === 'rejected' ? (rugRes.reason?.message || 'error') : null,
  });
}
