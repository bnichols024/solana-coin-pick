// The scoring engine. Pure functions over normalized candidates — no DOM, no
// network — so `node --test tests/` can exercise every rule against fixtures.

import { CONFIG } from './config.js';

const clamp01 = (n) => (isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Linear 0..1 scale of `v` between `lo` and `hi`. */
export function scale(v, lo, hi) {
  if (!isFinite(v)) return 0;
  return clamp01((v - lo) / (hi - lo));
}

/** Logarithmic 0..1 scale — for quantities that span orders of magnitude. */
export function logScale(v, lo, hi) {
  if (!isFinite(v) || v <= 0) return 0;
  const a = Math.log10(Math.max(v, lo));
  return clamp01((a - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)));
}

// Note: the global isFinite() coerces, so isFinite(true) and isFinite([]) are
// both true and a naive guard would let a boolean through as a "number" that
// later explodes on .toFixed(). Only real numbers and numeric strings pass.
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/**
 * Flatten a DexScreener pair (plus any extra signals we gathered) into the flat
 * shape the filters and scorer work on.
 * @param {object} pair  a DexScreener pair object
 * @param {object} extra { boostAmount, hasProfile, sources, jupiterVerified }
 * @param {number} now   epoch ms (injectable so tests are deterministic)
 */
export function normalizePair(pair, extra = {}, now = Date.now()) {
  const liquidity = num(pair?.liquidity?.usd) ?? 0;
  const fdv = num(pair?.fdv) ?? num(pair?.marketCap) ?? 0;
  const txns = pair?.txns || {};
  const buys24 = num(txns?.h24?.buys) ?? 0;
  const sells24 = num(txns?.h24?.sells) ?? 0;
  const vol24 = num(pair?.volume?.h24) ?? 0;
  const txns24 = buys24 + sells24;

  return {
    address: pair?.baseToken?.address || '',
    symbol: pair?.baseToken?.symbol || '???',
    name: pair?.baseToken?.name || 'Unknown',
    pairAddress: pair?.pairAddress || '',
    dexId: pair?.dexId || '',
    url: pair?.url || '',
    icon: extra.icon || pair?.info?.imageUrl || '',
    priceUsd: num(pair?.priceUsd) ?? 0,
    liquidity,
    fdv,
    marketCap: num(pair?.marketCap) ?? fdv,
    vol24,
    vol6: num(pair?.volume?.h6) ?? 0,
    vol1: num(pair?.volume?.h1) ?? 0,
    vol5m: num(pair?.volume?.m5) ?? 0,
    chg5m: num(pair?.priceChange?.m5) ?? 0,
    chg1h: num(pair?.priceChange?.h1) ?? 0,
    chg6h: num(pair?.priceChange?.h6) ?? 0,
    chg24h: num(pair?.priceChange?.h24) ?? 0,
    buys1h: num(txns?.h1?.buys) ?? 0,
    sells1h: num(txns?.h1?.sells) ?? 0,
    buys6h: num(txns?.h6?.buys) ?? 0,
    sells6h: num(txns?.h6?.sells) ?? 0,
    buys24h: buys24,
    sells24h: sells24,
    txns24,
    avgTradeUsd: txns24 > 0 ? vol24 / txns24 : 0,
    ageMs: pair?.pairCreatedAt ? now - pair.pairCreatedAt : null,
    boostAmount: num(extra.boostAmount) ?? num(pair?.boosts?.active) ?? 0,
    hasProfile: !!extra.hasProfile,
    jupiterVerified: !!extra.jupiterVerified,
    socials: pair?.info?.socials?.length || 0,
    sources: extra.sources || [],
  };
}

/**
 * Tickers that already belong to something large. A brand-new $200K pair using
 * one of these is impersonating it — a well-worn way to farm buys from people
 * who do not check the contract address.
 */
const CLAIMED_TICKERS = new Set([
  'SOL', 'BTC', 'ETH', 'USDC', 'USDT', 'BNB', 'XRP', 'ADA', 'DOGE', 'TRX',
  'AVAX', 'LINK', 'DOT', 'MATIC', 'SHIB', 'LTC', 'BCH', 'UNI', 'ATOM', 'XLM',
  'JUP', 'JTO', 'PYTH', 'RAY', 'BONK', 'WIF', 'PEPE', 'POPCAT', 'MEW', 'WEN',
  'ORCA', 'MSOL', 'JITOSOL', 'WBTC', 'WETH', 'USDS', 'PUMP',
]);

/** A token is impersonating when it wears a claimed ticker at a tiny cap. */
export function impersonatesKnownToken(c, maxLegitFdv = 50_000_000) {
  const sym = String(c.symbol || '').trim().toUpperCase();
  if (!CLAIMED_TICKERS.has(sym)) return false;
  // The real one is worth far more than anything that clears our size filters,
  // so any candidate wearing the ticker at this size is not the real one.
  return c.fdv > 0 && c.fdv < maxLegitFdv;
}

/**
 * Hard disqualifiers. Returns an array of human-readable reasons; empty means
 * the candidate is tradeable enough to score.
 */
export function rejectReasons(c, f = CONFIG.filters) {
  const out = [];
  const ageMin = c.ageMs == null ? null : c.ageMs / 60_000;

  if (!c.address) out.push('no token address');
  if (!(c.priceUsd > 0)) out.push('no price');
  if (c.liquidity < f.minLiquidityUsd) out.push(`liquidity under $${f.minLiquidityUsd / 1000}K`);
  if (c.liquidity > f.maxLiquidityUsd) out.push('liquidity too deep to move fast');
  if (c.vol24 < f.minVolume24hUsd) out.push('24h volume too thin');
  if (c.liquidity > 0 && c.vol24 / c.liquidity < f.minVolumeToLiquidity) out.push('pool barely turning over');
  if (c.fdv > f.maxFdvUsd) out.push('market cap too large for a 10x day');
  if (!(c.fdv > 0)) out.push('no market cap data');
  if (ageMin == null) out.push('unknown pair age');
  else if (ageMin < f.minPairAgeMinutes) out.push('too new — sniper/rug window');
  else if (ageMin > f.maxPairAgeDays * 1440) out.push('no longer a fresh launch');
  if (c.txns24 < f.minTxns24h) out.push('too few trades');
  if (c.avgTradeUsd < f.minAvgTradeUsd) out.push('micro-trade spam (likely wash volume)');
  if (c.avgTradeUsd > f.maxAvgTradeUsd) out.push('a few whales, not a crowd');
  if (c.chg24h > f.blowOffChange24h && c.chg1h < f.blowOffChange1h) out.push('blow-off top — already ran and rolling over');

  // Honeypot tells, straight from the trade counts — no extra API needed.
  if (c.buys24h >= f.honeypotMinBuys && c.sells24h === 0) {
    out.push('nobody has ever sold it — almost certainly a honeypot');
  } else if (c.sells24h > 0 && c.buys24h / c.sells24h > f.honeypotBuySellRatio && c.buys24h >= f.honeypotMinBuys) {
    out.push('buyers vastly outnumber sellers — likely a sell tax or trap');
  }

  // A pool that already collapsed is not an entry, it is a corpse.
  if (c.chg24h < f.corpseChange24h && c.liquidity < f.corpseLiquidityUsd) {
    out.push('already collapsed — the rug has happened');
  }

  if (impersonatesKnownToken(c)) {
    out.push(`"${c.symbol}" is an established ticker — this is an impersonator`);
  }

  return out;
}

// --- individual signals, each returning 0..1 -------------------------------

export function momentumScore(c) {
  // Convert every window to a %/hour rate so they are comparable.
  const r5 = c.chg5m * 12;
  const r1 = c.chg1h;
  const r6 = c.chg6h / 6;
  const base = scale(r1, 0, 40);            // is it moving now
  const accel = scale(r1 - r6, 0, 20);      // is the last hour beating the trend
  const burst = scale(r5 - r1, -10, 15);    // is the last 5m beating the hour
  return clamp01(0.45 * base + 0.35 * accel + 0.20 * burst);
}

export function buyPressureScore(c) {
  const ratio = (b, s) => (b + s >= 20 ? b / (b + s) : null);
  const r1 = ratio(c.buys1h, c.sells1h);
  const r6 = ratio(c.buys6h, c.sells6h);
  const s1 = r1 == null ? 0.35 : scale(r1, 0.5, 0.75);
  const s6 = r6 == null ? 0.35 : scale(r6, 0.5, 0.7);
  return clamp01(0.6 * s1 + 0.4 * s6);
}

export function velocityScore(c) {
  if (!(c.liquidity > 0)) return 0;
  const hourly = c.vol1 / c.liquidity;         // pool turns per hour
  const recent = (c.vol5m * 12) / c.liquidity; // annualised-to-hour burst rate
  return clamp01(0.65 * scale(hourly, 0.02, 0.5) + 0.35 * scale(recent, 0.02, 0.8));
}

export function attentionScore(c) {
  const boost = logScale(c.boostAmount, 10, 1000);
  const profile = c.hasProfile ? 0.25 : 0;
  const socials = Math.min(c.socials, 3) / 3 * 0.15;
  const verified = c.jupiterVerified ? 0.1 : 0;
  const multiSource = Math.min(Math.max(c.sources.length - 1, 0), 2) / 2 * 0.15;
  return clamp01(0.5 * boost + profile + socials + verified + multiSource);
}

export function headroomScore(c) {
  // Smaller FDV = more room. $50K is maximum headroom, $30M is none.
  return clamp01(1 - logScale(c.fdv, 50_000, CONFIG.filters.maxFdvUsd));
}

export function freshnessScore(c) {
  if (c.ageMs == null) return 0;
  const h = c.ageMs / 3_600_000;
  if (h < 2) return scale(h, 0.75, 2);        // ramping into the sweet spot
  if (h <= 72) return 1;                       // the sweet spot
  return clamp01(1 - scale(h, 72, 21 * 24));   // decaying out of it
}

const SIGNALS = {
  momentum: momentumScore,
  buyPressure: buyPressureScore,
  velocity: velocityScore,
  attention: attentionScore,
  headroom: headroomScore,
  freshness: freshnessScore,
};

/** Risk deductions applied after the weighted sum (each in 0..1 of total). */
export function penalties(c) {
  const out = [];
  if (c.liquidity > 0 && c.fdv / c.liquidity > 100) out.push({ label: 'Very thin float vs market cap', value: 0.15 });
  if (c.liquidity < 30_000) out.push({ label: 'Shallow liquidity — high slippage', value: 0.08 });
  if (c.chg1h < 0) out.push({ label: 'Negative on the hour', value: 0.12 });
  if (c.sells1h > c.buys1h * 1.5 && c.buys1h + c.sells1h >= 20) out.push({ label: 'Sellers outnumbering buyers', value: 0.1 });
  return out;
}

/** Full score for one candidate: 0..100 plus the per-signal breakdown. */
export function scoreCandidate(c, weights = CONFIG.weights) {
  const parts = {};
  let total = 0;
  for (const [key, fn] of Object.entries(SIGNALS)) {
    const raw = clamp01(fn(c));
    const weight = weights[key] ?? 0;
    parts[key] = { raw, weight, weighted: raw * weight };
    total += raw * weight;
  }
  const pens = penalties(c);
  const deduction = pens.reduce((s, p) => s + p.value, 0);
  const final = clamp01(total - deduction) * 100;
  return { score: Math.round(final * 10) / 10, parts, penalties: pens, deduction };
}

/**
 * Realistic upside band, honestly stated: a 100x needs a tiny cap AND a top
 * score. Everything else gets a soberer range.
 */
export function upsideBand(c, score) {
  if (score >= 70 && c.fdv < 750_000) return { band: '10x – 100x', note: 'micro cap with a live bid — the lottery-ticket tier' };
  if (score >= 60 && c.fdv < 3_000_000) return { band: '5x – 20x', note: 'small cap with real momentum' };
  if (score >= 50) return { band: '2x – 10x', note: 'credible runner, less explosive' };
  if (score >= 35) return { band: '1.5x – 5x', note: 'momentum is there but thinner' };
  return { band: '< 3x', note: 'weak field — nothing is screaming today' };
}

/**
 * Rank a list of normalized candidates.
 * @returns {{winner: object|null, runnersUp: object[], scored: object[], rejected: object[]}}
 */
export function rankCandidates(candidates) {
  const scored = [];
  const rejected = [];

  for (const c of candidates) {
    const reasons = rejectReasons(c);
    if (reasons.length) {
      rejected.push({ candidate: c, reasons });
      continue;
    }
    const result = scoreCandidate(c);
    scored.push({ candidate: c, ...result, upside: upsideBand(c, result.score) });
  }

  scored.sort((a, b) => b.score - a.score || b.candidate.vol1 - a.candidate.vol1);
  return {
    winner: scored[0] || null,
    runnersUp: scored.slice(1, 6),
    scored,
    rejected,
  };
}
