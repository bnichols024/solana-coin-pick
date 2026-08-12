// Entry timing. Picking the right coin and picking the right moment are two
// different problems — a good coin bought at the top of a vertical candle still
// loses money. Pure functions over a normalized candidate, so it unit tests.
//
// Method: reconstruct where the market cap was 1h / 6h / 24h ago from the price
// changes we already have, treat the move from the recent low to now as "the
// leg", and quote Fibonacci retracements of that leg as the entry zone. Every
// number shown to the user is derived, never invented.

/** Market cap `changePct` ago. Null when the maths would blow up. */
export function capBefore(mcNow, changePct) {
  if (!(mcNow > 0) || !isFinite(changePct)) return null;
  const factor = 1 + changePct / 100;
  if (factor <= 0.01) return null; // -99%+ — the ratio is meaningless
  return mcNow / factor;
}

const RETRACE = { shallow: 0.236, mid: 0.382, deep: 0.618 };

/**
 * @param {object} c normalized candidate (see score.js)
 * @returns {{
 *   state: 'buy_now'|'wait_shallow'|'wait_pullback'|'falling'|'stalled'|'unknown',
 *   verdict: string, reason: string,
 *   zoneLow: number|null, zoneHigh: number|null,
 *   maxChase: number|null, invalidation: number|null,
 *   discountPct: number|null
 * }}
 */
export function assessEntry(c) {
  const mcNow = c.fdv;
  if (!(mcNow > 0)) {
    return {
      state: 'unknown',
      verdict: 'Entry unclear',
      reason: 'No reliable market cap for this pair, so there is no honest level to quote.',
      zoneLow: null, zoneHigh: null, maxChase: null, invalidation: null, discountPct: null,
    };
  }

  const mc1h = capBefore(mcNow, c.chg1h);
  const mc6h = capBefore(mcNow, c.chg6h);
  const priors = [mc1h, mc6h].filter((v) => v != null && v > 0);
  const legLow = priors.length ? Math.min(...priors, mcNow) : mcNow;
  const leg = Math.max(mcNow - legLow, 0);

  // When both prior caps are unreconstructable (a -99%+ window makes the ratio
  // meaningless) there is no leg to retrace, so fall back to a flat discount
  // rather than emitting a null level into the UI.
  const level = (ratio) => (leg > 0 ? mcNow - ratio * leg : mcNow * (1 - ratio * 0.5));

  const parabolic = c.chg5m >= 8 || c.chg1h >= 60;
  const stretched = c.chg1h >= 30 && c.chg1h > c.chg6h;   // the whole 6h move happened this hour
  const falling = c.chg1h <= -5;
  const hourlyVsAverage = c.vol6 > 0 ? c.vol1 / (c.vol6 / 6) : 1;
  const stalled = Math.abs(c.chg1h) < 3 && hourlyVsAverage < 0.7;

  const maxChase = mcNow * 1.12;
  const invalidation = leg > 0 ? legLow * 0.9 : mcNow * 0.75;

  const withDiscount = (out) => ({
    ...out,
    discountPct: out.zoneHigh != null ? ((out.zoneHigh - mcNow) / mcNow) * 100 : null,
  });

  if (falling) {
    // A falling knife has no reliable retracement — the leg is pointing the
    // wrong way. Quote a level to watch, not a level to buy.
    const watch = mc6h && mc6h < mcNow ? mc6h : mcNow * 0.8;
    return withDiscount({
      state: 'falling',
      verdict: 'Do not buy yet — it is still bleeding',
      reason: `Down ${c.chg1h.toFixed(1)}% on the hour. Catching this before it bases is how you end up averaging down into a rug.`,
      zoneLow: watch * 0.85,
      zoneHigh: watch,
      maxChase,
      invalidation: watch * 0.7,
    });
  }

  if (parabolic) {
    return withDiscount({
      state: 'wait_pullback',
      verdict: 'Wait for the pullback — this is vertical right now',
      reason: `Up ${c.chg1h.toFixed(0)}% in the last hour${c.chg5m >= 8 ? ` and ${c.chg5m.toFixed(1)}% in the last five minutes` : ''}. Buying a candle like this means you are the exit liquidity if it stalls.`,
      zoneLow: level(RETRACE.deep),
      zoneHigh: level(RETRACE.mid),
      maxChase,
      invalidation,
    });
  }

  if (stretched) {
    return withDiscount({
      state: 'wait_shallow',
      verdict: 'Close — wait for a small dip',
      reason: `Most of the six-hour move happened in the last hour (${c.chg1h.toFixed(0)}% vs ${c.chg6h.toFixed(0)}%). A shallow retrace here is normal and gives you a better basis.`,
      zoneLow: level(RETRACE.mid),
      zoneHigh: level(RETRACE.shallow),
      maxChase,
      invalidation,
    });
  }

  if (stalled) {
    return withDiscount({
      state: 'stalled',
      verdict: 'Entry is fine, but momentum has gone quiet',
      reason: `Flat on the hour with volume running at ${(hourlyVsAverage * 100).toFixed(0)}% of its six-hour average. No urgency — either it wakes up or your money is better elsewhere.`,
      zoneLow: level(RETRACE.shallow) ?? mcNow * 0.95,
      zoneHigh: mcNow,
      maxChase: mcNow * 1.05,
      invalidation,
    });
  }

  return withDiscount({
    state: 'buy_now',
    verdict: 'Good entry now',
    reason: `Rising ${c.chg1h.toFixed(1)}% on the hour without going vertical, and buyers still lead sellers. This is the part of the move you want to be early in, not the blow-off.`,
    zoneLow: level(RETRACE.shallow) ?? mcNow * 0.95,
    zoneHigh: mcNow,
    maxChase,
    invalidation,
  });
}

/** Short label for the runners-up table. */
export function entryLabel(state) {
  return {
    buy_now: 'Buy now',
    wait_shallow: 'Small dip',
    wait_pullback: 'Wait',
    falling: 'Falling',
    stalled: 'Quiet',
    unknown: '—',
  }[state] || '—';
}
