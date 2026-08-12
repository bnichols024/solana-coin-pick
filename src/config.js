// Central tuning + optional paid-provider keys.
// Everything here is free/keyless by default. Paste a key into `paid` to light
// up the v2 signals in sources.js — no other change required.

export const CONFIG = {
  // --- hard filters -------------------------------------------------------
  filters: {
    minLiquidityUsd: 20_000,      // below this you cannot exit your own position
    maxLiquidityUsd: 2_000_000,   // above this a 10x in a day is not happening
    minVolume24hUsd: 50_000,      // no real flow = no move
    minVolumeToLiquidity: 1.0,    // 24h volume must at least turn the pool once
    maxFdvUsd: 30_000_000,        // 100x from here would be a top-20 coin
    minPairAgeMinutes: 45,        // sniper/rug window
    maxPairAgeDays: 21,           // past this it is no longer a fresh runner
    minTxns24h: 300,
    minAvgTradeUsd: 5,            // filters obvious wash/bot micro-txn spam
    maxAvgTradeUsd: 25_000,       // a handful of whales, not a real crowd
    blowOffChange24h: 400,        // % — already ran this hard...
    blowOffChange1h: 0,           // ...and is now red on the hour = too late
    honeypotMinBuys: 50,          // this many buyers and zero sellers = trap
    honeypotBuySellRatio: 15,     // buys/sells this lopsided is a sell tax or trap
    corpseChange24h: -60,         // down this hard = the rug already happened
    corpseLiquidityUsd: 60_000,
  },

  // --- contract vetting (src/safety.js) -----------------------------------
  safety: {
    maxVetted: 10,       // contract-check this many top-ranked coins per click
    vetConcurrency: 3,   // parallel vets — keep the free RPCs happy
    unverifiedPenalty: 8, // points deducted per check we could not complete
  },

  // --- scoring weights (must sum to 1) ------------------------------------
  weights: {
    momentum: 0.25,   // is the curve steepening right now
    buyPressure: 0.20,
    velocity: 0.15,   // 1h volume vs liquidity
    attention: 0.15,  // someone is spending real money on promotion
    headroom: 0.15,   // small FDV = room to run
    freshness: 0.10,
  },

  // --- fetch behaviour ----------------------------------------------------
  fetch: {
    timeoutMs: 12_000,
    retries: 1,
    batchSize: 30,          // DexScreener allows 30 addresses per tokens call
    maxBatches: 8,          // caps a click at ~240 hydrated tokens
    interBatchDelayMs: 120, // stay well inside the 300 req/min limit
  },

  // --- v2 / paid providers (all optional, empty = disabled) ---------------
  paid: {
    birdeyeApiKey: '',   // richer OHLCV + holder counts
    heliusApiKey: '',    // top-10 holder concentration, mint/freeze authority
    rugcheckApiKey: '',  // contract risk report
    xBearerToken: '',    // social mention velocity
  },
};

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
      maxFdvUsd: 15_000_000,
      minVolume24hUsd: 200_000,
      minTxns24h: 600,
      minPairAgeMinutes: 180,
    },
    weights: { momentum: 0.20, buyPressure: 0.22, velocity: 0.15, attention: 0.15, headroom: 0.10, freshness: 0.18 },
  },
  balanced: {
    label: 'Balanced',
    blurb: 'The default. Small caps with real flow and a live bid.',
    filters: {},
    weights: {},
  },
  degen: {
    label: 'Degen',
    blurb: 'Micro caps and fresh launches. Highest ceiling, highest chance of zero.',
    filters: {
      minLiquidityUsd: 15_000,
      maxFdvUsd: 4_000_000,
      minVolume24hUsd: 40_000,
      minTxns24h: 200,
      minPairAgeMinutes: 60,
    },
    weights: { momentum: 0.30, buyPressure: 0.18, velocity: 0.17, attention: 0.10, headroom: 0.20, freshness: 0.05 },
  },
};

/** Resolve a preset name into concrete filters and weights. */
export function resolvePreset(name) {
  const preset = PRESETS[name] || PRESETS.balanced;
  return {
    name: PRESETS[name] ? name : 'balanced',
    label: preset.label,
    blurb: preset.blurb,
    filters: { ...CONFIG.filters, ...preset.filters },
    weights: Object.keys(preset.weights).length ? preset.weights : CONFIG.weights,
  };
}

export const SCORE_LABELS = {
  momentum: 'Momentum acceleration',
  buyPressure: 'Buy pressure',
  velocity: 'Volume velocity',
  attention: 'Paid attention',
  headroom: 'Upside headroom',
  freshness: 'Freshness',
};
