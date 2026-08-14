// Central tuning + optional paid-provider keys.
// Everything here is free/keyless by default. Paste a key into `paid` to light
// up the v2 signals in sources.js — no other change required.

export const CONFIG = {
  // Bumped whenever the scoring model changes in a way that should be judged
  // separately. Every pick is stamped with it, so a new model's results are
  // never averaged in with the old one's. Rows with no stamp are v1.
  modelVersion: 4,

  // --- hard filters -------------------------------------------------------
  filters: {
    minLiquidityUsd: 20_000,      // below this you cannot exit your own position
    maxLiquidityUsd: 2_000_000,   // above this a 10x in a day is not happening
    minVolume24hUsd: 50_000,      // no real flow = no move
    minVolumeToLiquidity: 1.0,    // 24h volume must at least turn the pool once
    // v4: was $30M. Every v1–v3 pick above ~$500K peaked between 1.04x and
    // 1.08x — they never moved at all. A cap this size cannot produce the
    // outcome this app exists to find, so it is no longer allowed to be picked.
    maxFdvUsd: 3_000_000,
    minPairAgeMinutes: 45,        // sniper/rug window
    maxPairAgeDays: 3,            // v4: was 21. Three weeks is not a fresh runner.
    minTxns24h: 300,
    minAvgTradeUsd: 5,            // filters obvious wash/bot micro-txn spam
    maxAvgTradeUsd: 25_000,       // a handful of whales, not a real crowd
    blowOffChange24h: 400,        // % — already ran this hard...
    blowOffChange1h: 0,           // ...and is now red on the hour = too late
    honeypotMinBuys: 50,          // this many buyers and zero sellers = trap
    honeypotBuySellRatio: 15,     // buys/sells this lopsided is a sell tax or trap
    corpseChange24h: -60,         // down this hard = the rug already happened
    corpseLiquidityUsd: 60_000,

    // --- v4: lateness as a hard filter, not a weight ---------------------
    // v2 and v3 only *discounted* a finished move inside momentumScore, so a
    // coin up 250% on the day still cleared every filter and lost a fraction
    // of one weighted signal. It then peaked 1.05x and bled 90%. These are
    // outright rejections.
    //
    // The grace window is the same idea momentumScore already uses: for a coin
    // 30 minutes old, that percentage *is its whole life* and there was no
    // earlier entry to have missed. Past the window it means the entry passed.
    latenessGraceHours: 6,
    maxChange24h: 150,            // % — already up this much today = too late
    maxChange6h: 100,             // % — the move happened in the last six hours

    // Top-10 non-pool wallets holding more than this share of supply is a
    // handful of people who can end the coin in one transaction. Requires a
    // Helius key; when the check cannot run the filter is skipped, never passed.
    maxTop10SharePct: 30,
  },

  // --- contract vetting (src/safety.js) -----------------------------------
  safety: {
    maxVetted: 10,       // contract-check this many top-ranked coins per click
    vetConcurrency: 3,   // parallel vets — keep the free RPCs happy
    unverifiedPenalty: 8, // points deducted per check we could not complete
  },

  // --- scoring weights (must sum to 1) ------------------------------------
  // Shifted away from the two "already pumping" signals (momentum, velocity)
  // toward headroom and buy pressure, after the v1 track record showed every
  // pick peaking under 1.6x. Attention is nearly zeroed — see attentionScore.
  weights: {
    momentum: 0.25,   // early move: starting, not finished
    buyPressure: 0.25,
    velocity: 0.10,   // 1h volume vs liquidity — also a lagging tell
    attention: 0.03,  // corroboration only, no longer promotion spend
    headroom: 0.22,   // small FDV = room to run
    freshness: 0.15,
  },

  // --- fetch behaviour ----------------------------------------------------
  fetch: {
    timeoutMs: 12_000,
    retries: 1,
    batchSize: 30,          // DexScreener allows 30 addresses per tokens call
    maxBatches: 12,         // caps a click at ~360 hydrated tokens
    interBatchDelayMs: 120, // stay well inside the 300 req/min limit
  },

  // --- v2 / paid providers (all optional, empty = disabled) ---------------
  paid: {
    birdeyeApiKey: '',   // richer OHLCV + holder counts
    // Free-tier key, deliberately committed: this is a keyless static site and
    // there is nowhere else to put it. It ships in the repo and in browser
    // network traffic, so anyone can spend the quota — the blast radius is rate
    // limits, not funds. Rotating it is a one-line change.
    heliusApiKey: 'ccf61431-4de9-4302-ba9b-fc417b77e9f7',
    rugcheckApiKey: '',  // contract risk report
    xBearerToken: '',    // social mention velocity
  },
};

/**
 * Helius RPC endpoint, or null when no key is set. Defined once here so
 * sources.js and safety.js cannot drift on the host — the CSP lists exactly one
 * and a second spelling would be blocked at runtime with no server-side warning.
 */
export function heliusRpcUrl() {
  const key = CONFIG.paid.heliusApiKey;
  return key ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}` : null;
}

/** Pair-age filters are expressed in days; this keeps short windows readable. */
const minutes = (m) => m / 1440;

/**
 * Risk presets. Same engine, different appetite — these override the defaults
 * above rather than replacing them, so a preset only states what it changes.
 */
export const PRESETS = {
  safe: {
    label: 'Cautious',
    blurb: 'Deeper liquidity, more established pairs. Fewer 100x shots, far fewer zeros.',
    filters: {
      minLiquidityUsd: 60_000,
      maxFdvUsd: 8_000_000,
      minVolume24hUsd: 200_000,
      minTxns24h: 600,
      minPairAgeMinutes: 180,
      maxPairAgeDays: 7,
      // The most conservative tier is also the least willing to chase.
      maxChange24h: 100,
    },
    weights: { momentum: 0.20, buyPressure: 0.27, velocity: 0.10, attention: 0.05, headroom: 0.18, freshness: 0.20 },
  },
  balanced: {
    label: 'Balanced',
    blurb: 'The default. Small caps with real flow and a live bid.',
    filters: {},
    weights: {},
  },
  degen: {
    label: 'Degen',
    blurb: 'Micro caps and fresh launches. High ceiling, high chance of zero.',
    filters: {
      minLiquidityUsd: 15_000,
      maxFdvUsd: 1_500_000,
      minVolume24hUsd: 40_000,
      minTxns24h: 200,
      minPairAgeMinutes: 60,
      // At one day this crosses the `maxPairAgeDays <= 1` test in app.js that
      // puts gecko-new seeds first in the hydration queue. That is intended:
      // Degen is now a fresh-launch tier and needs the leading feed.
      maxPairAgeDays: 1,
      maxChange24h: 250,
      maxChange6h: 150,
    },
    weights: { momentum: 0.28, buyPressure: 0.22, velocity: 0.10, attention: 0.03, headroom: 0.27, freshness: 0.10 },
  },
  gamble: {
    label: 'Gamble',
    blurb: 'Sub-$50K coins launched in the last hour. Lottery tickets — expect most of these to go to zero.',
    danger: true,
    filters: {
      // Everything here is an order of magnitude below the other presets,
      // because a $50K coin cannot clear floors written for a $1M one.
      maxFdvUsd: 50_000,
      maxLiquidityUsd: 150_000,  // more liquidity than cap is a data anomaly
      minLiquidityUsd: 3_000,    // under this you cannot get out at any price
      minVolumeToLiquidity: 0.5,
      minPairAgeMinutes: 15,     // still past the worst of the sniper window
      maxPairAgeDays: minutes(60),
      // DexScreener's volume and trade counts are 24-hour totals, but nothing
      // here is more than an hour old, so these are really "in its whole life"
      // numbers. The absolute bar has to drop to stay equivalent.
      minVolume24hUsd: 4_000,
      minTxns24h: 25,
      minAvgTradeUsd: 1,
      maxAvgTradeUsd: 3_000,     // at this size a $3K trade is one whale
      corpseLiquidityUsd: 25_000,
      // Nothing in this tier is older than an hour, so it is always inside the
      // six-hour grace window and these ceilings never actually fire. They are
      // stated anyway so the tier does not silently inherit a stricter number
      // if the age window is ever widened.
      maxChange24h: 400,
      maxChange6h: 400,
    },
    // Attention barely exists down here — nobody buys promotion for a $30K
    // coin — so that weight moves to momentum, headroom and freshness.
    weights: { momentum: 0.27, buyPressure: 0.23, velocity: 0.10, attention: 0.02, headroom: 0.20, freshness: 0.18 },
  },
};

/** Resolve a preset name into concrete filters and weights. */
export function resolvePreset(name) {
  const preset = PRESETS[name] || PRESETS.balanced;
  return {
    name: PRESETS[name] ? name : 'balanced',
    label: preset.label,
    blurb: preset.blurb,
    danger: !!preset.danger,
    filters: { ...CONFIG.filters, ...preset.filters },
    weights: Object.keys(preset.weights).length ? preset.weights : CONFIG.weights,
  };
}

export const SCORE_LABELS = {
  momentum: 'Early move',
  buyPressure: 'Buy pressure',
  velocity: 'Volume velocity',
  attention: 'Corroboration',
  headroom: 'Upside headroom',
  freshness: 'Freshness',
};
