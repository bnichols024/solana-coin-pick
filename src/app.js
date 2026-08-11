// Orchestration + rendering. Fetch -> normalize -> filter -> score -> show.

import { CONFIG, SCORE_LABELS } from './config.js';
import { discoverCandidates, hydratePairs, fetchJupiterVerified } from './sources.js';
import { normalizePair, rankCandidates } from './score.js';
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

btn.addEventListener('click', run);

async function run() {
  btn.disabled = true;
  btn.querySelector('.cta-label').textContent = 'Scanning the chain…';
  logEl.hidden = false;
  logEl.textContent = '';
  resultEl.hidden = true;
  runnersEl.hidden = true;

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

    log('Filtering out rugs, dead pools and blow-off tops…');
    const { winner, runnersUp, scored, rejected } = rankCandidates(candidates);
    log(`${rejected.length} rejected · ${scored.length} tradeable.`, 'ok');

    if (!winner) {
      showNotice('No coin clears the bar right now',
        `All ${rejected.length} candidates in view failed the safety and liquidity filters — too thin, too big, too new, or already blown off. That is a real answer: a bad field is worth sitting out. Try again in an hour.`);
      return;
    }

    log(`Winner: ${winner.candidate.symbol} — score ${winner.score}/100`, 'ok');
    if (failures.length) log(`Note: scored without ${failures.join(', ')}.`, 'warn');
    renderWinner(winner);
    renderRunnersUp(runnersUp);
    log(`Done in ${((performance.now() - started) / 1000).toFixed(1)}s.`);
  } catch (err) {
    console.error(err);
    showNotice('Scan failed', esc(err?.message || 'Unknown error') + ' — try again in a moment.');
  } finally {
    btn.disabled = false;
    btn.querySelector('.cta-label').textContent = 'Generate Another Winner';
  }
}

function showNotice(title, body) {
  resultEl.hidden = false;
  resultEl.innerHTML = `<div class="notice"><strong>${esc(title)}</strong>${esc(body)}</div>`;
}

function chg(v) {
  return `<span class="${v >= 0 ? 'up' : 'down'}">${pct(v)}</span>`;
}

function renderWinner(entry) {
  const c = entry.candidate;
  const bars = Object.entries(entry.parts).map(([key, p]) => `
    <div class="bar-row">
      <span>${esc(SCORE_LABELS[key] || key)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(p.raw * 100).toFixed(0)}%"></span></span>
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
        ${c.icon ? `<img class="token-icon" src="${esc(c.icon)}" alt="" onerror="this.remove()" />` : ''}
        <div class="token-id">
          <p class="ticker">$${esc(c.symbol)}</p>
          <p class="token-name">${esc(c.name)}</p>
        </div>
        <div class="score-badge">
          <div class="score-num">${entry.score}</div>
          <div class="score-cap">Moonshot score</div>
        </div>
      </div>

      <div class="band">
        <div class="band-value">${esc(entry.upside.band)} potential</div>
        <div class="band-note">${esc(entry.upside.note)}</div>
      </div>

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

      <h3 class="section">Contract address</h3>
      <div class="addr-row">
        <code class="addr" id="addr">${esc(c.address)}</code>
        <button class="copy" type="button" id="copy">Copy</button>
      </div>

      <div class="links">
        <a class="primary" href="https://jup.ag/swap/SOL-${encodeURIComponent(c.address)}" target="_blank" rel="noopener noreferrer">Buy on Jupiter</a>
        <a href="${esc(c.url || `https://dexscreener.com/solana/${c.address}`)}" target="_blank" rel="noopener noreferrer">DexScreener chart</a>
        <a href="https://birdeye.so/token/${encodeURIComponent(c.address)}?chain=solana" target="_blank" rel="noopener noreferrer">Birdeye</a>
        <a href="https://rugcheck.xyz/tokens/${encodeURIComponent(c.address)}" target="_blank" rel="noopener noreferrer">RugCheck</a>
      </div>
    </div>`;

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

function renderRunnersUp(list) {
  if (!list.length) { runnersEl.hidden = true; return; }
  const tbody = $('runners-table').querySelector('tbody');
  tbody.innerHTML = list.map((e, i) => {
    const c = e.candidate;
    return `<tr>
      <td>${i + 2}</td>
      <td><a href="${esc(c.url || `https://dexscreener.com/solana/${c.address}`)}" target="_blank" rel="noopener noreferrer" title="${esc(shortAddr(c.address))}">$${esc(c.symbol)}</a></td>
      <td>${e.score}</td>
      <td>${usd(c.fdv)}</td>
      <td>${usd(c.liquidity)}</td>
      <td>${chg(c.chg1h)}</td>
      <td>${chg(c.chg24h)}</td>
      <td>${age(c.ageMs)}</td>
    </tr>`;
  }).join('');
  runnersEl.hidden = false;
}

// Surface the tuning in the console for anyone who wants to poke at it.
console.info('Moonshot filters/weights:', CONFIG.filters, CONFIG.weights);
