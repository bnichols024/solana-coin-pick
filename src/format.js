// Pure display helpers. No DOM, no network — safe to unit test.
//
// Every one of these can be handed a value straight off a third-party API, so
// they all guard with `numeric()` first. The global isFinite() coerces
// (isFinite(true) === true), which would let a boolean reach .toFixed() and
// throw, so only genuine finite numbers get through.

const numeric = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function usd(n) {
  const v = numeric(n);
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

export function price(n) {
  const v = numeric(n);
  if (v == null || v <= 0) return '—';
  if (v >= 1) return `$${v.toFixed(4)}`;
  // Show 4 significant digits for sub-penny prices without scientific notation.
  const decimals = Math.min(18, Math.max(4, Math.ceil(-Math.log10(v)) + 3));
  const text = v.toFixed(decimals).replace(/0+$/, '');
  return `$${text.endsWith('.') ? `${text}0` : text}`;
}

export function pct(n) {
  const v = numeric(n);
  if (v == null) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(v >= 100 || v <= -100 ? 0 : 1)}%`;
}

export function age(ms) {
  // 0 is a legitimate age (a pick made a second ago), so test for null rather
  // than falsiness.
  const v = numeric(ms);
  if (v == null || v < 0) return 'unknown';
  const mins = v / 60_000;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.round(mins)}m`;
  const hours = mins / 60;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export function count(n) {
  const v = numeric(n);
  if (v == null) return '—';
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

export function shortAddr(a) {
  if (typeof a !== 'string' || !a) return '—';
  return a.length > 12 ? `${a.slice(0, 5)}…${a.slice(-5)}` : a;
}
