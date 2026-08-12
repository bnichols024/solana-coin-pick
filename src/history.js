// Track record. Every pick is recorded with the market cap at the time, so the
// app can be graded against reality instead of asking you to take its word for
// it. Stored locally — nothing leaves the browser.
//
// This is deliberately unflattering by design: if the picks are bad, the table
// says so.

const KEY = 'scp:history';
const MAX_ENTRIES = 50;

function store() {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    s.setItem('scp:__h', '1');
    s.removeItem('scp:__h');
    return s;
  } catch {
    return null;
  }
}

/** @returns {Array<object>} newest first; always an array, never throws. */
export function loadHistory() {
  const s = store();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s.getItem(KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p) => p && typeof p.address === 'string' && p.pickedMc > 0);
  } catch {
    return [];
  }
}

function saveHistory(list) {
  const s = store();
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)));
  } catch {
    // Full — drop the oldest half and retry once.
    try { s.setItem(KEY, JSON.stringify(list.slice(0, Math.floor(MAX_ENTRIES / 2)))); } catch { /* give up */ }
  }
}

/**
 * Record a pick. Re-picking the same coin inside the window updates nothing —
 * the original entry price is what we grade against.
 */
export function recordPick(candidate, score, entryState, now = Date.now()) {
  if (!candidate?.address || !(candidate.fdv > 0)) return loadHistory();
  const list = loadHistory();

  const recent = list.find((p) => p.address === candidate.address && now - p.pickedAt < 6 * 3600_000);
  if (recent) return list;

  list.unshift({
    address: candidate.address,
    symbol: candidate.symbol,
    name: candidate.name,
    pickedAt: now,
    pickedMc: candidate.fdv,
    pickedPrice: candidate.priceUsd,
    // Stored so the peak lookup still works once DexScreener stops returning
    // the token — which is exactly what happens to the ones that rugged.
    pairAddress: candidate.pairAddress || '',
    score,
    entryState,
  });
  saveHistory(list);
  return list;
}

/**
 * Merge newly observed peak prices into storage. Peaks only ever rise, so this
 * takes the max — which means the data accumulates across visits instead of
 * being re-fetched (and re-rate-limited) every time the page opens.
 * @param {Map<string, number>} peaks address -> peak price
 */
export function updatePeaks(peaks, alsoPools = new Map()) {
  if (!peaks.size && !alsoPools.size) return loadHistory();
  const list = loadHistory();
  let changed = false;
  for (const entry of list) {
    const seen = peaks.get(entry.address);
    if (seen > 0 && !(entry.peakPrice >= seen)) { entry.peakPrice = seen; changed = true; }
    const pool = alsoPools.get(entry.address);
    if (pool && !entry.pairAddress) { entry.pairAddress = pool; changed = true; }
  }
  if (changed) saveHistory(list);
  return list;
}

/**
 * Grade recorded picks against their current market cap.
 * @param {Array} history
 * @param {Map<string, object>} current address -> { fdv, priceUsd } (missing = unknown)
 * @param {Map<string, number>} peaks address -> highest price since the pick
 * @returns {{rows: Array, stats: {graded:number, wins:number, rugs:number, best:number, median:number}}}
 */
export function gradeHistory(history, current, now = Date.now(), peaks = new Map()) {
  const rows = history.map((p) => {
    const live = current.get(p.address);
    const nowMc = live && live.fdv > 0 ? live.fdv : null;
    const multiple = nowMc != null && p.pickedMc > 0 ? nowMc / p.pickedMc : null;

    // Peak is carried as a price (from OHLCV) and converted with the price we
    // recorded at pick time, so it stays comparable to the market-cap columns.
    // Prefer a freshly fetched peak, fall back to whatever we learned before.
    const peakPrice = Math.max(peaks.get(p.address) || 0, p.peakPrice || 0) || null;
    const peakMultiple = peakPrice > 0 && p.pickedPrice > 0
      ? Math.max(peakPrice / p.pickedPrice, multiple ?? 0)
      : null;

    return {
      ...p,
      nowMc,
      multiple,
      peakMultiple,
      peakMc: peakMultiple != null && p.pickedMc > 0 ? p.pickedMc * peakMultiple : null,
      changePct: multiple != null ? (multiple - 1) * 100 : null,
      ageMs: now - p.pickedAt,
    };
  });

  const graded = rows.filter((r) => r.multiple != null);
  const multiples = graded.map((r) => r.multiple).sort((a, b) => a - b);
  const median = multiples.length
    ? (multiples.length % 2
      ? multiples[(multiples.length - 1) / 2]
      : (multiples[multiples.length / 2 - 1] + multiples[multiples.length / 2]) / 2)
    : null;

  return {
    rows,
    stats: {
      total: rows.length,
      graded: graded.length,
      wins: graded.filter((r) => r.multiple >= 1.5).length,
      rugs: graded.filter((r) => r.multiple <= 0.25).length,
      best: multiples.length ? multiples[multiples.length - 1] : null,
      median,
      // The diagnostic split: did picks run before dying, or never run at all?
      everRan: graded.filter((r) => r.peakMultiple >= 1.5).length,
      medianPeak: (() => {
        const peaked = graded.map((r) => r.peakMultiple).filter((m) => m != null).sort((a, b) => a - b);
        if (!peaked.length) return null;
        const mid = peaked.length / 2;
        return peaked.length % 2 ? peaked[(peaked.length - 1) / 2] : (peaked[mid - 1] + peaked[mid]) / 2;
      })(),
    },
  };
}

/**
 * Does a higher score actually predict a better outcome? Buckets graded picks
 * by the score they were given and reports the median multiple of each.
 *
 * This is the app marking its own homework in public. With a handful of picks
 * it means nothing, which is why it stays hidden until there are enough.
 */
export function calibration(rows, minGraded = 8) {
  const graded = rows.filter((r) => r.multiple != null);
  if (graded.length < minGraded) {
    return { ready: false, needed: minGraded - graded.length, buckets: [], verdict: null };
  }

  const bands = [
    { label: '70+', min: 70, max: Infinity },
    { label: '55–70', min: 55, max: 70 },
    { label: 'under 55', min: -Infinity, max: 55 },
  ];

  const median = (nums) => {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    const mid = s.length / 2;
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[mid - 1] + s[mid]) / 2;
  };

  const buckets = bands.map((b) => {
    const inBand = graded.filter((r) => Number(r.score) >= b.min && Number(r.score) < b.max);
    return {
      label: b.label,
      n: inBand.length,
      median: median(inBand.map((r) => r.multiple)),
    };
  }).filter((b) => b.n > 0);

  // Absolute performance comes first. Ranking one losing band above another
  // losing band is not the model working, and an earlier version of this said
  // "holding up" while every band was down 60%.
  const ranked = buckets.filter((b) => b.median != null);
  const overall = median(graded.map((r) => r.multiple));
  let verdict = 'not enough spread to tell';

  if (overall != null && overall < 0.8) {
    const worstBand = ranked.length >= 2 && ranked[0].median < ranked[ranked.length - 1].median
      ? ' Higher scores are doing no better than lower ones.'
      : '';
    verdict = `The median pick is down ${((1 - overall) * 100).toFixed(0)}% — the model is losing money regardless of score.${worstBand}`;
  } else if (ranked.length >= 2) {
    const top = ranked[0];
    const rest = ranked.slice(1);
    if (rest.every((b) => top.median >= b.median)) {
      verdict = 'higher scores are doing better — the model is holding up';
    } else if (rest.every((b) => top.median < b.median)) {
      verdict = 'higher scores are doing worse — treat the score with suspicion';
    } else {
      verdict = 'mixed — no clear relationship between score and outcome yet';
    }
  }

  return { ready: true, needed: 0, buckets, verdict, overall };
}

export function clearHistory() {
  const s = store();
  if (!s) return;
  try { s.removeItem(KEY); } catch { /* ignore */ }
}
