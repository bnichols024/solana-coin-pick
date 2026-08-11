// Pure display helpers. No DOM, no network — safe to unit test.

export function usd(n) {
  if (n == null || !isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export function price(n) {
  if (n == null || !isFinite(n) || n <= 0) return '—';
  if (n >= 1) return `$${n.toFixed(4)}`;
  // Show 4 significant digits for sub-penny prices without scientific notation.
  const decimals = Math.min(18, Math.max(4, Math.ceil(-Math.log10(n)) + 3));
  return `$${n.toFixed(decimals).replace(/0+$/, '')}`;
}

export function pct(n) {
  if (n == null || !isFinite(n)) return '—';
  const s = n > 0 ? '+' : '';
  return `${s}${n.toFixed(n >= 100 || n <= -100 ? 0 : 1)}%`;
}

export function age(ms) {
  if (!ms || !isFinite(ms)) return 'unknown';
  const mins = ms / 60_000;
  if (mins < 60) return `${Math.round(mins)}m`;
  const hours = mins / 60;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export function count(n) {
  if (n == null || !isFinite(n)) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export function shortAddr(a) {
  return a && a.length > 12 ? `${a.slice(0, 5)}…${a.slice(-5)}` : (a || '—');
}
