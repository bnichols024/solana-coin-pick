// Winner selection: contract-vet the shortlist in rank order and choose the
// best coin that survives. Kept out of app.js so it can be tested without a DOM
// — `vetFn` is injected.

import { CONFIG } from './config.js';

/**
 * @param {Array} scored ranked entries, highest score first
 * @param {(address: string) => Promise<object>} vetFn
 * @param {(msg: string) => void} logFn
 * @param {object} cfg CONFIG.safety shape
 */
export async function vetShortlist(scored, vetFn, logFn = () => {}, cfg = CONFIG.safety) {
  const { maxVetted, vetConcurrency, unverifiedPenalty } = cfg;
  const shortlist = scored.slice(0, maxVetted);
  const vetted = new Map();
  const rejectedForSafety = [];
  const passes = [];
  let foundFullyVerified = false;

  for (let i = 0; i < shortlist.length && !foundFullyVerified; i += vetConcurrency) {
    const batch = shortlist.slice(i, i + vetConcurrency);
    logFn(`Checking contracts: ${batch.map((e) => e.candidate.symbol).join(', ')}…`);

    const results = await Promise.all(batch.map(async (e) => {
      try {
        return await vetFn(e.candidate.address);
      } catch (err) {
        // vetToken should never throw, but if it does the coin is unverified,
        // not silently safe.
        return {
          verdict: 'pass',
          rejections: [],
          warnings: [],
          unverified: [`contract checks crashed (${err?.message || 'error'})`],
          checked: [],
        };
      }
    }));

    batch.forEach((entry, j) => {
      const safety = results[j];
      vetted.set(entry, safety);
      if (safety.verdict === 'reject') { rejectedForSafety.push({ entry, safety }); return; }
      // A coin we could not fully check is worse than one we could. Deducting
      // here means a slightly lower-scoring but fully-verified coin wins.
      passes.push({ entry, safety, effective: entry.score - unverifiedPenalty * safety.unverified.length });
      if (!safety.unverified.length) foundFullyVerified = true;
    });
  }

  // Stopping at the first fully verified pass is safe: the shortlist is in
  // descending score order and the penalty only ever subtracts, so nothing
  // further down can beat a clean coin whose effective score is its full score.
  passes.sort((a, b) => b.effective - a.effective);
  return { vetted, safeWinner: passes[0] || null, rejectedForSafety, passes };
}
