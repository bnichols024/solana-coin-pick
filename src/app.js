// Orchestration + rendering. Fetch -> normalize -> filter -> score -> show.

import { CONFIG, SCORE_LABELS, resolvePreset } from './config.js';
import { discoverCandidates, hydratePairs, fetchJupiterVerified, fetchCurrentMarketCaps } from './sources.js';
import { loadHistory, recordPick, gradeHistory, clearHistory, calibration } from './history.js';
import { normalizePair, rankCandidates } from './score.js';
import { vetToken } from './safety.js';
import { vetShortlist } from './select.js';
import { assessEntry, entryLabel } from './entry.js';
import { usd, price, pct, age, count, shortAddr } from './format.js';

const $ = (id) => document.getElementById(id);
const btn = $('generate');
const logEl = $('log');
const resultEl = $('result');
const runnersEl = $('runners');

function log(msg, kind = '') {
  logEl.hidden = false;
  const line = document.createElement('div');
  if (kind) line.className = kind;
  line.textContent = msg;
  logEl.append(line);
  logEl.scrollTop = logEl.scrollHeight;
}

/** Escape anything that came off the wire before it touches innerHTML. */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/**
 * URLs come from third-party APIs and end up in href/src. Escaping quotes is
 * not enough — `javascript:` and `data:` URLs survive it — so anything that is
 * not plain https is replaced with the caller's fallback.
 */
function safeUrl(raw, fallback = '') {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    // No base URL on purpose: a relative or junk string must fail here rather
    // than silently resolving against our own origin.
    const u = new URL(raw.trim());
    return u.protocol === 'https:' ? u.href : fallback;
  } catch {
    return fallback;
  }
}

// --- risk preset -----------------------------------------------------------

const PRESET_KEY = 'scp:preset';
let activePreset = resolvePreset(
  (() => { try { return globalThis.localStorage?.getItem(PRESET_KEY); } catch { return null; } })(),
);

function applyPreset(name) {
  activePreset = resolvePreset(name);
  for (const el of document.querySelectorAll('.preset')) {
    const on = el.dataset.preset === activePreset.name;
    el.classList.toggle('is-active', on);
    el.setAttribute('aria-checked', String(on));
  }
  const blurb = $('preset-blurb');
  blurb.textContent = activePreset.blurb;
  blurb.classList.toggle('is-danger', activePreset.danger);
  try { globalThis.localStorage?.setItem(PRESET_KEY, activePreset.name); } catch { /* fine */ }
}

for (const el of document.querySelectorAll('.preset')) {
  el.addEventListener('click', () => applyPreset(el.dataset.preset));
}
applyPreset(activePreset.name);

btn.addEventListener('click', run);

async function run() {
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.querySelector('.cta-label').textContent = 'Scanning the chain…';
  logEl.hidden = false;
  logEl.textContent = '';
  resultEl.hidden = true;
  runnersEl.hidden = true;
  $('rejected').hidden = true;
  stopLiveRefresh();

  const started = performance.now();
  try {
    log('Scanning free Solana market feeds…');
    const [{ seeds, failures }, verified] = await Promise.all([
      discoverCandidates((m) => log(m, m.startsWith('⚠') ? 'warn' : 'ok')),
      fetchJupiterVerified(),
    ]);

    if (!seeds.size) {
      showNotice('Could not reach any data source',
        'Every free feed failed to respond. Check your connection (or an ad-blocker blocking api.dexscreener.com) and try again.');
      return;
    }
    log(`Found ${seeds.size} candidate tokens.`);

    // Deepest-boosted and most-corroborated seeds first, so the batch cap
    // spends its budget on the most promising addresses.
    const addresses = [...seeds.entries()]
      .sort((a, b) => (b[1].sources.length - a[1].sources.length) || (b[1].boostAmount - a[1].boostAmount))
      .map(([addr]) => addr);

    const pairs = await hydratePairs(addresses, (m) => log(m, m.startsWith('⚠') ? 'warn' : ''));
    if (!pairs.size) {
      showNotice('No market data came back',
        `Found ${seeds.size} candidate tokens, but the price/liquidity feed did not respond, so there was nothing to score. This is a data outage, not a verdict on the market — try again shortly.`);
      return;
    }
    log(`Loaded live market data for ${pairs.size} tokens.`);

    const now = Date.now();
    const candidates = [...pairs.entries()].map(([addr, pair]) => {
      const seed = seeds.get(addr) || {};
      return normalizePair(pair, {
        boostAmount: seed.boostAmount,
        hasProfile: seed.hasProfile,
        icon: seed.icon,
        sources: seed.sources,
        jupiterVerified: verified.has(addr),
      }, now);
    });

    log(`Filtering on the ${activePreset.label} profile — rugs, dead pools, blow-off tops…`);
    const { winner, scored, rejected } = rankCandidates(candidates, activePreset);
    log(`${rejected.length} rejected · ${scored.length} tradeable.`, 'ok');

    if (!winner) {
      showNotice('No coin clears the bar right now',
        `All ${rejected.length} candidates in view failed the safety and liquidity filters — too thin, too big, too new, or already blown off. That is a real answer: a bad field is worth sitting out. Try again in an hour.`);
      renderRejected(rejected);
      return;
    }

    // Market shape got us a shortlist. Now check the contracts themselves —
    // mint authority, freeze authority, LP lock, honeypot patterns — and take
    // the highest-ranked coin that actually survives.
    log('Running contract rug checks on the shortlist…');
    const { vetted, safeWinner, rejectedForSafety } = await vetShortlist(scored, vetToken, log);

    if (rejectedForSafety.length) {
      log(`${rejectedForSafety.length} rejected by contract checks: ${
        rejectedForSafety.map((v) => v.entry.candidate.symbol).join(', ')}`, 'warn');
    }

    if (!safeWinner) {
      showNotice('Everything on the shortlist failed its rug check',
        `The top ${vetted.length} coins by momentum all failed contract vetting — live mint or freeze authority, unlocked liquidity, or honeypot patterns. Refusing to hand you a rug is the correct output here. Try again later.`);
      renderRunnersUp(scored.slice(0, 6), vetted);
      renderRejected(rejected, rejectedForSafety);
      return;
    }

    log(`Winner: ${safeWinner.entry.candidate.symbol} — score ${safeWinner.entry.score}/100, contract checks passed`, 'ok');
    if (failures.length) log(`Note: scored without ${failures.join(', ')}.`, 'warn');
    renderWinner(safeWinner.entry, safeWinner.safety);
    renderRunnersUp(scored.filter((e) => e !== safeWinner.entry).slice(0, 5), vetted);
    renderRejected(rejected, rejectedForSafety);
    startLiveRefresh(safeWinner.entry, safeWinner.safety);
    log(`Done in ${((performance.now() - started) / 1000).toFixed(1)}s.`);

    // Record it so the track record can grade this call later.
    try {
      recordPick(safeWinner.entry.candidate, safeWinner.entry.score, assessEntry(safeWinner.entry.candidate).state);
      // Refresh so previously graded rows keep their grades — rendering from an
      // empty price map would blank them out.
      renderHistory().catch(() => {});
    } catch (err) {
      console.warn('could not record pick', err);
    }
  } catch (err) {
    console.error(err);
    showNotice('Scan failed', esc(err?.message || 'Unknown error') + ' — try again in a moment.');
  } finally {
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
    btn.querySelector('.cta-label').textContent = 'Scan Again';
  }
}

function showNotice(title, body) {
  resultEl.hidden = false;
  resultEl.innerHTML = `<div class="notice"><strong>${esc(title)}</strong>${esc(body)}</div>`;
}

function chg(v) {
  return `<span class="${v >= 0 ? 'up' : 'down'}">${pct(v)}</span>`;
}

function renderSafety(safety) {
  if (!safety) return '';
  const rows = [];
  for (const name of safety.checked) {
    rows.push(`<li class="pass">${esc(name)} — passed</li>`);
  }
  for (const w of safety.warnings) {
    rows.push(`<li class="warn">${esc(w)}</li>`);
  }
  for (const u of safety.unverified) {
    rows.push(`<li class="unknown">Could not verify: ${esc(u)}</li>`);
  }
  let banner = '';
  if (safety.unverified.length && !safety.checked.length) {
    banner = `<p class="safety-gap danger">⛔ <strong>No contract checks could run.</strong> This coin is completely unvetted — the rug filters that would normally reject it were offline, so it was picked on price action alone. Run it through RugCheck yourself before you touch it.</p>`;
  } else if (safety.unverified.length) {
    banner = `<p class="safety-gap">⚠ ${safety.unverified.length} of ${
      safety.unverified.length + safety.checked.length
    } contract checks could not run, so this pick is only partly vetted. Verify on RugCheck before buying.</p>`;
  }
  return `<h3 class="section">Contract safety</h3><ul class="safety">${rows.join('')}</ul>${banner}`;
}

function renderEntryTiming(c) {
  const e = assessEntry(c);
  const waiting = e.state === 'wait_pullback' || e.state === 'wait_shallow' || e.state === 'falling';
  const zone = e.zoneLow != null && e.zoneHigh != null
    ? `${usd(e.zoneLow)} – ${usd(e.zoneHigh)}`
    : '—';
  const discount = e.discountPct != null && e.discountPct < -0.5
    ? ` <span class="muted">(${e.discountPct.toFixed(0)}% below current)</span>`
    : '';

  return `
    <div class="entry entry-${esc(e.state)}">
      <div class="entry-head">
        <span class="entry-dot"></span>
        <strong>${esc(e.verdict)}</strong>
      </div>
      <p class="entry-reason">${esc(e.reason)}</p>
      <div class="entry-levels">
        <div>
          <span class="entry-k">${waiting ? 'Target entry market cap' : 'Entry zone'}</span>
          <span class="entry-v">${zone}${discount}</span>
        </div>
        <div>
          <span class="entry-k">Do not chase above</span>
          <span class="entry-v">${usd(e.maxChase)}</span>
        </div>
        <div>
          <span class="entry-k">Thesis dead below</span>
          <span class="entry-v">${usd(e.invalidation)}</span>
        </div>
      </div>
    </div>`;
}

function renderWinner(entry, safety, { live = false } = {}) {
  const c = entry.candidate;
  const bars = Object.entries(entry.parts).map(([key, p]) => `
    <div class="bar-row">
      <span>${esc(SCORE_LABELS[key] || key)}</span>
      <span class="bar-track"><span class="bar-fill" data-fill="${(p.raw * 100).toFixed(0)}"></span></span>
      <span class="bar-val">${(p.raw * 100).toFixed(0)}</span>
    </div>`).join('');

  const risks = entry.penalties.length
    ? `<h3 class="section">Risk deductions</h3><ul class="risks">${
        entry.penalties.map((p) => `<li>${esc(p.label)} (−${(p.value * 100).toFixed(0)} pts)</li>`).join('')
      }</ul>`
    : '';

  resultEl.hidden = false;
  resultEl.innerHTML = `
    <div class="card">
      <div class="card-top">
        ${safeUrl(c.icon) ? `<img class="token-icon" src="${esc(safeUrl(c.icon))}" alt="" onerror="this.remove()" />` : ''}
        <div class="token-id">
          <p class="ticker">$${esc(c.symbol)}</p>
          <p class="token-name">${esc(c.name)}</p>
        </div>
        <div class="score-badge">
          <div class="score-num">${entry.score}</div>
          <div class="score-cap">Moonshot score</div>
        </div>
      </div>
      <div class="live-note">
        ${live
          ? '<span class="live-dot"></span>Prices updated just now — entry levels recalculated'
          : '<span class="live-dot"></span>Live — prices refresh every 45s'}
      </div>

      <div class="band">
        <div class="band-value">${esc(entry.upside.band)} potential</div>
        <div class="band-note">${esc(entry.upside.note)}</div>
      </div>

      ${renderEntryTiming(c)}

      <div class="stats">
        <div class="stat"><div class="stat-k">Price</div><div class="stat-v">${price(c.priceUsd)}</div></div>
        <div class="stat"><div class="stat-k">Market cap</div><div class="stat-v">${usd(c.fdv)}</div></div>
        <div class="stat"><div class="stat-k">Liquidity</div><div class="stat-v">${usd(c.liquidity)}</div></div>
        <div class="stat"><div class="stat-k">24h volume</div><div class="stat-v">${usd(c.vol24)}</div></div>
        <div class="stat"><div class="stat-k">5m</div><div class="stat-v">${chg(c.chg5m)}</div></div>
        <div class="stat"><div class="stat-k">1h</div><div class="stat-v">${chg(c.chg1h)}</div></div>
        <div class="stat"><div class="stat-k">6h</div><div class="stat-v">${chg(c.chg6h)}</div></div>
        <div class="stat"><div class="stat-k">24h</div><div class="stat-v">${chg(c.chg24h)}</div></div>
        <div class="stat"><div class="stat-k">Pair age</div><div class="stat-v">${age(c.ageMs)}</div></div>
        <div class="stat"><div class="stat-k">24h trades</div><div class="stat-v">${count(c.txns24)}</div></div>
        <div class="stat"><div class="stat-k">1h buy/sell</div><div class="stat-v">${count(c.buys1h)} / ${count(c.sells1h)}</div></div>
        <div class="stat"><div class="stat-k">DEX</div><div class="stat-v">${esc(c.dexId || '—')}</div></div>
      </div>

      <h3 class="section">Why this one</h3>
      <div class="bars">${bars}</div>
      ${risks}
      ${renderSafety(safety)}

      <h3 class="section">Contract address</h3>
      <div class="addr-row">
        <code class="addr" id="addr">${esc(c.address)}</code>
        <button class="copy" type="button" id="copy">Copy</button>
      </div>

      <div class="links">
        <a class="primary" href="https://jup.ag/swap/SOL-${encodeURIComponent(c.address)}" target="_blank" rel="noopener noreferrer">Buy on Jupiter</a>
        <a href="${esc(safeUrl(c.url, `https://dexscreener.com/solana/${encodeURIComponent(c.address)}`))}" target="_blank" rel="noopener noreferrer">DexScreener chart</a>
        <a href="https://birdeye.so/token/${encodeURIComponent(c.address)}?chain=solana" target="_blank" rel="noopener noreferrer">Birdeye</a>
        <a href="https://rugcheck.xyz/tokens/${encodeURIComponent(c.address)}" target="_blank" rel="noopener noreferrer">RugCheck</a>
      </div>
    </div>`;

  // Inline style attributes are blocked by the page's CSP, so the bars are
  // filled through the CSSOM instead, which is allowed.
  for (const bar of resultEl.querySelectorAll('.bar-fill')) {
    bar.style.width = `${bar.dataset.fill}%`;
  }

  $('copy').addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(c.address);
      e.target.textContent = 'Copied ✓';
      setTimeout(() => { e.target.textContent = 'Copy'; }, 1600);
    } catch {
      const range = document.createRange();
      range.selectNodeContents($('addr'));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });
}

function safetyCell(safety) {
  if (!safety) return '<td title="not checked — ranked below the shortlist">–</td>';
  if (safety.verdict === 'reject') {
    return `<td class="down" title="${esc(safety.rejections.join('; '))}">✗ rug risk</td>`;
  }
  if (safety.unverified.length) {
    return `<td class="warn-cell" title="${esc(safety.unverified.join('; '))}">partial</td>`;
  }
  return '<td class="up" title="all contract checks passed">✓</td>';
}

function entryCell(c) {
  const e = assessEntry(c);
  const label = entryLabel(e.state);
  const cls = e.state === 'buy_now' ? 'up' : e.state === 'falling' ? 'down' : 'warn-cell';
  // For anything worth waiting on, show the level to wait for — a bare
  // "Wait" is useless without a number attached to it.
  const target = e.state === 'buy_now' || e.zoneHigh == null ? '' : `<br><span class="tiny">${usd(e.zoneHigh)}</span>`;
  return `<td class="${cls}" title="${esc(e.verdict)}">${label}${target}</td>`;
}

function renderRunnersUp(list, vetted = new Map()) {
  if (!list.length) { runnersEl.hidden = true; return; }
  const tbody = $('runners-table').querySelector('tbody');
  tbody.innerHTML = list.map((e, i) => {
    const c = e.candidate;
    return `<tr>
      <td>${i + 2}</td>
      <td><a href="${esc(safeUrl(c.url, `https://dexscreener.com/solana/${encodeURIComponent(c.address)}`))}" target="_blank" rel="noopener noreferrer" title="${esc(shortAddr(c.address))}">$${esc(c.symbol)}</a></td>
      <td>${e.score}</td>
      ${safetyCell(vetted.get(e))}
      ${entryCell(c)}
      <td>${usd(c.fdv)}</td>
      <td>${usd(c.liquidity)}</td>
      <td>${chg(c.chg1h)}</td>
      <td>${chg(c.chg24h)}</td>
      <td>${age(c.ageMs)}</td>
    </tr>`;
  }).join('');
  runnersEl.hidden = false;
}

// --- live refresh ----------------------------------------------------------
// Entry advice is only good while the price it was computed from is current, so
// the displayed winner re-checks itself. One token, one request per interval.

const LIVE_REFRESH_MS = 45_000;
let liveTimer = null;

function stopLiveRefresh() {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
}

function startLiveRefresh(entry, safety) {
  stopLiveRefresh();
  const address = entry.candidate.address;

  liveTimer = setInterval(async () => {
    // Nothing to update if the card has been replaced or the tab is hidden.
    if (document.hidden || !document.getElementById('addr')) return;
    try {
      const live = await fetchCurrentMarketCaps([address]);
      const fresh = live.get(address);
      if (!fresh || !(fresh.fdv > 0)) return;

      const before = entry.candidate.fdv;
      // Move the cap and the price-change window together — the entry maths
      // derives past caps from these, so a half-updated candidate lies.
      Object.assign(entry.candidate, {
        fdv: fresh.fdv,
        marketCap: fresh.fdv,
        priceUsd: fresh.priceUsd || entry.candidate.priceUsd,
        liquidity: fresh.liquidity || entry.candidate.liquidity,
        chg5m: fresh.chg5m,
        chg1h: fresh.chg1h,
        chg6h: fresh.chg6h,
        chg24h: fresh.chg24h,
        vol1: fresh.vol1 || entry.candidate.vol1,
        vol6: fresh.vol6 || entry.candidate.vol6,
      });
      if (Math.abs(fresh.fdv - before) / before < 0.005) return; // noise

      renderWinner(entry, safety, { live: true });
    } catch {
      // A failed refresh just means the card keeps its last good values.
    }
  }, LIVE_REFRESH_MS);
}

/**
 * Show what was thrown away and why. The filters are the most opinionated part
 * of the app, so they should be auditable rather than taken on trust.
 */
function renderRejected(rejected, rejectedForSafety = []) {
  const el = $('rejected');
  const total = rejected.length + rejectedForSafety.length;
  if (!total) { el.hidden = true; return; }

  // Contract failures first — they are the most interesting rejections.
  const safetyRows = rejectedForSafety.map(({ entry, safety }) => `
    <div class="rej-row rej-danger">
      <span class="rej-sym">$${esc(entry.candidate.symbol)}</span>
      <span class="rej-why">${esc(safety.rejections.join(' · '))}</span>
    </div>`);

  // Group the market-filter rejections by reason: "31 too thin" reads better
  // than thirty-one near-identical lines.
  const byReason = new Map();
  for (const { candidate, reasons } of rejected) {
    const key = reasons[0] || 'unknown';
    if (!byReason.has(key)) byReason.set(key, []);
    byReason.get(key).push(candidate.symbol);
  }
  const grouped = [...byReason.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([reason, syms]) => `
      <div class="rej-row">
        <span class="rej-count">${syms.length}</span>
        <span class="rej-why">${esc(reason)}</span>
        <span class="rej-syms">${esc(syms.slice(0, 8).join(', '))}${syms.length > 8 ? ` +${syms.length - 8} more` : ''}</span>
      </div>`);

  $('rejected-count').textContent = String(total);
  $('rejected-body').innerHTML = safetyRows.join('') + grouped.join('');
  el.hidden = false;
}

// --- track record ----------------------------------------------------------

const historyEl = $('history');

function multipleClass(m) {
  if (m == null) return '';
  if (m >= 1.5) return 'up';
  if (m <= 0.6) return 'down';
  return '';
}

function resultText(row) {
  if (row.multiple == null) return '<span class="muted">no data</span>';
  const m = row.multiple;
  const label = m >= 1 ? `${m.toFixed(2)}x` : `−${((1 - m) * 100).toFixed(0)}%`;
  return `<span class="${multipleClass(m)}">${label}</span>`;
}

/** Render the stored picks, grading them against live market caps. */
async function renderHistory({ refresh = true } = {}) {
  const stored = loadHistory();
  if (!stored.length) { historyEl.hidden = true; return; }

  let current = new Map();
  if (refresh) {
    try {
      current = await fetchCurrentMarketCaps(stored.map((p) => p.address));
    } catch {
      current = new Map(); // ungraded is fine; never break the page over this
    }
  }

  const { rows, stats } = gradeHistory(stored, current);

  $('history-stats').innerHTML = [
    ['Picks', stats.total],
    ['Graded', stats.graded],
    ['Up 1.5x+', stats.wins],
    ['Down 75%+', stats.rugs],
    ['Median', stats.median != null ? `${stats.median.toFixed(2)}x` : '—'],
    ['Best', stats.best != null ? `${stats.best.toFixed(2)}x` : '—'],
  ].map(([k, v]) => `<div class="hstat"><span class="hstat-k">${esc(k)}</span><span class="hstat-v">${esc(String(v))}</span></div>`).join('');

  renderCalibration(rows);

  historyEl.querySelector('tbody').innerHTML = rows.map((r) => `
    <tr>
      <td><a href="https://dexscreener.com/solana/${encodeURIComponent(r.address)}" target="_blank" rel="noopener noreferrer">$${esc(r.symbol)}</a></td>
      <td>${r.ageMs < 60_000 ? 'just now' : `${age(r.ageMs)} ago`}</td>
      <td class="${r.entryState === 'buy_now' ? '' : 'warn-cell'}">${esc(entryLabel(r.entryState))}</td>
      <td>${usd(r.pickedMc)}</td>
      <td>${r.nowMc != null ? usd(r.nowMc) : '—'}</td>
      <td>${resultText(r)}</td>
    </tr>`).join('');

  historyEl.hidden = false;
}

/** Show whether the score has actually predicted anything, once there is data. */
function renderCalibration(rows) {
  const el = $('calibration');
  const cal = calibration(rows);
  if (!cal.ready) { el.hidden = true; return; }

  el.innerHTML = `
    <div class="cal-head">Is the score predictive?</div>
    <div class="cal-bands">${cal.buckets.map((b) => `
      <div class="cal-band">
        <span class="cal-label">Score ${esc(b.label)}</span>
        <span class="cal-median ${b.median >= 1 ? 'up' : 'down'}">${b.median != null ? `${b.median.toFixed(2)}x` : '—'}</span>
        <span class="cal-n">${b.n} pick${b.n === 1 ? '' : 's'}</span>
      </div>`).join('')}</div>
    <p class="cal-verdict">${esc(cal.verdict)}</p>`;
  el.hidden = false;
}

$('clear-history').addEventListener('click', () => {
  clearHistory();
  historyEl.hidden = true;
  $('calibration').hidden = true;
});

// Grade past picks on load, without blocking the button.
renderHistory().catch((err) => console.warn('history render failed', err));

// Surface the tuning in the console for anyone who wants to poke at it.
console.info('Moonshot filters/weights:', CONFIG.filters, CONFIG.weights);
