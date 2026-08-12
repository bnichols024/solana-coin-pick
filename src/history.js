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
    score,
    entryState,
  });
  saveHistory(list);
  return list;
}

/**
 * Grade recorded picks against their current market cap.
 * @param {Array} history
 * @param {Map<string, object>} current address -> { fdv, priceUsd } (missing = unknown)
 * @returns {{rows: Array, stats: {graded:number, wins:number, rugs:number, best:number, median:number}}}
 */
export function gradeHistory(history, current, now = Date.now()) {
  const rows = history.map((p) => {
    const live = current.get(p.address);
    const nowMc = live && live.fdv > 0 ? live.fdv : null;
    const multiple = nowMc != null && p.pickedMc > 0 ? nowMc / p.pickedMc : null;
    return {
      ...p,
      nowMc,
      multiple,
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
    },
  };
}

export function clearHistory() {
  const s = store();
  if (!s) return;
  try { s.removeItem(KEY); } catch { /* ignore */ }
}
