// The scoring engine. Pure functions over normalized candidates — no DOM, no
// network — so `node --test tests/` can exercise every rule against fixtures.

import { CONFIG } from './config.js';

const clamp01 = (n) => (isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Linear 0..1 scale of `v` between `lo` and `hi`. */
export function scale(v, lo, hi) {
  if (!isFinite(v)) return 0;
  // A degenerate range would divide by zero and clamp to 0, silently turning
  // the signal into a constant. Treat it as a step instead.
  if (hi <= lo) return v >= hi ? 1 : 0;
  return clamp01((v - lo) / (hi - lo));
}

/** Logarithmic 0..1 scale — for quantities that span orders of magnitude. */
export function logScale(v, lo, hi) {
  if (!isFinite(v) || v <= 0) return 0;
  if (hi <= lo) return v >= hi ? 1 : 0;
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
  // Size first: for an oversized coin "market cap too large" is a far more
  // useful headline than whatever else it also trips, and the audit panel
  // groups rejections by the first reason listed.
  if (c.fdv > f.maxFdvUsd) out.push('market cap too large for this profile');
  if (!(c.fdv > 0)) out.push('no market cap data');
  if (c.liquidity < f.minLiquidityUsd) out.push(`liquidity under $${f.minLiquidityUsd / 1000}K`);
  if (c.liquidity > f.maxLiquidityUsd) out.push('liquidity too deep to move fast');
  if (c.vol24 < f.minVolume24hUsd) out.push('24h volume too thin');
  if (c.liquidity > 0 && c.vol24 / c.liquidity < f.minVolumeToLiquidity) out.push('pool barely turning over');
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

/**
 * Early-move score: reward a coin that is *starting* to move, discount one that
 * has already moved.
 *
 * The previous version rose monotonically with the 1h change, so the most
 * vertical candle on the board always won. Measured against the live track
 * record that was buying tops — every pick peaked under 1.6x and the median
 * fell 36%. On meme coins a vertical hour is the exit signal, not the entry.
 */
export function momentumScore(c) {
  const r1 = c.chg1h;
  const r6 = c.chg6h / 6;   // %/hour, so the windows are comparable

  const rising = scale(r1, 1, 15);        // moving, but not dramatically
  const accel = scale(r1 - r6, 0, 15);    // accelerating off its own base

  // Late in two different ways: this hour is already vertical, or the run
  // started hours ago and we are looking at the tail of it.
  const lateness = Math.max(scale(r1, 25, 80), scale(c.chg24h, 100, 400));

  // Multiplicative, not additive: a flat coin must score ~0. Adding a
  // "not late" term would hand every dead coin most of the points.
  return clamp01((0.55 * rising + 0.45 * accel) * (1 - 0.85 * lateness));
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

/**
 * Corroboration, not promotion.
 *
 * Boost spend used to be half this score, on the theory that money behind a
 * coin is a good sign. It is at least as often money spent by someone trying to
 * exit into new buyers, and the coins we bought on it peaked under 1.6x before
 * dying. It is no longer scored — `boostAmount` is still carried and shown, so
 * you can see who is paying for attention without the model paying for it too.
 */
export function attentionScore(c) {
  const profile = c.hasProfile ? 0.35 : 0;
  const socials = Math.min(c.socials, 3) / 3 * 0.2;
  const verified = c.jupiterVerified ? 0.15 : 0;
  const multiSource = Math.min(Math.max(c.sources.length - 1, 0), 2) / 2 * 0.3;
  return clamp01(profile + socials + verified + multiSource);
}

export function headroomScore(c, filters = CONFIG.filters) {
  // Smaller FDV = more room; the active cap ceiling is none. The floor sits a
  // long way under the ceiling so the scale never collapses — with a $50K
  // ceiling a fixed $50K floor would score every coin identically.
  const floor = Math.min(50_000, filters.maxFdvUsd / 20);
  return clamp01(1 - logScale(c.fdv, floor, filters.maxFdvUsd));
}

export function freshnessScore(c, filters = CONFIG.filters) {
  if (c.ageMs == null) return 0;
  const maxHours = filters.maxPairAgeDays * 24;
  const h = c.ageMs / 3_600_000;

  // Both boundaries scale to the allowed window. On a three-week window a
  // minutes-old pair is unproven and should ramp up; on a one-hour window
  // newest is the entire point, and a fixed 2h ramp would score every
  // candidate zero while ranking the oldest one highest.
  const rampEnd = Math.min(2, maxHours * 0.25);
  const sweetEnd = Math.min(72, maxHours / 2);

  if (h < rampEnd) return scale(h, rampEnd * 0.375, rampEnd);  // ramping in
  if (h <= sweetEnd) return 1;                                 // sweet spot
  return clamp01(1 - scale(h, sweetEnd, maxHours));            // decaying out
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
export function scoreCandidate(c, weights = CONFIG.weights, filters = CONFIG.filters) {
  const parts = {};
  let total = 0;
  for (const [key, fn] of Object.entries(SIGNALS)) {
    const raw = clamp01(fn(c, filters));
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
export function rankCandidates(candidates, tuning = {}) {
  const filters = tuning.filters || CONFIG.filters;
  const weights = tuning.weights || CONFIG.weights;
  const scored = [];
  const rejected = [];

  for (const c of candidates) {
    const reasons = rejectReasons(c, filters);
    if (reasons.length) {
      rejected.push({ candidate: c, reasons });
      continue;
    }
    const result = scoreCandidate(c, weights, filters);
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
