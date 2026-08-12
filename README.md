# 🚀 Winning Meme Coin Generator

One button. It scans every **free** Solana market feed, throws out the rugs and the
dead pools, and ranks what is left on its odds of a 5x–100x move in the next 24 hours.

**Live:** https://bnichols024.github.io/solana-coin-pick/

> ⚠️ **This is a gambling heuristic, not financial advice.** Most meme coins go to zero.
> The scan reads public market data — it cannot see rug pulls, insider supply, or the
> future. Never risk money you cannot afford to lose entirely.

---

## How it works

No backend, no API keys, no database. Everything runs in your browser, so the same
files serve from GitHub Pages and from a container on your Unraid box.

**1 — Discover** (in parallel, each source fail-soft):

| Source | Signal |
| --- | --- |
| DexScreener token boosts (latest + top) | Someone is paying real money to promote it *right now* |
| DexScreener token profiles | Project has a funded, active listing |
| GeckoTerminal new pools | Fresh launches before they trend |
| GeckoTerminal trending pools (1h) | What is actually moving this hour |
| Jupiter verified list | Bonus credibility signal |

**2 — Hydrate.** Batched DexScreener lookups (30 addresses per call) pull price,
liquidity, FDV, 5m/1h/6h/24h price change, buy/sell counts and pair age. Each token
keeps its deepest pool.

**3 — Filter.** Hard disqualifiers, no scoring mercy — see `src/config.js`:

- liquidity under $20K (you cannot exit) or over $2M (too heavy to 10x in a day)
- 24h volume under $50K, or a pool that has not turned over once
- FDV over $30M — a 100x from there would be a top-20 coin
- pair younger than 45 minutes (sniper/rug window) or older than 21 days
- fewer than 300 trades, or an average trade size that reads as wash volume or whales
- already up 400%+ on the day **and** red on the hour (blow-off top)

Plus honeypot tells that need no extra API: a token with buyers and **zero sellers**, a
wildly lopsided buy/sell ratio (sell tax), or a pool already down 60%+ on thin liquidity
(the rug has happened).

**4 — Score 0–100.** Weighted signals, each shown in the result card:

| Signal | Weight | What it measures |
| --- | --- | --- |
| Momentum acceleration | 25% | Is the curve steepening *now* — 5m vs 1h vs 6h rates |
| Buy pressure | 20% | 1h and 6h buy/sell transaction ratio |
| Volume velocity | 15% | 1h volume against liquidity — pool turns per hour |
| Paid attention | 15% | Boost spend, profile, socials, corroborating sources |
| Upside headroom | 15% | Log-inverse FDV — small cap, room to run |
| Freshness | 10% | Sweet spot is a 2–72h old pair |

Then risk deductions: thin float vs market cap, shallow liquidity, red hour, sellers
outnumbering buyers.

**5 — Vet the contract** (`src/safety.js`). Market data cannot see a rug coming, so the
top-ranked coins get their actual mint account and contract report checked before one is
handed to you. Free and keyless: public Solana RPC (three endpoints, first to answer
wins) plus RugCheck's public summary.

| Rejected outright | Why it matters |
| --- | --- |
| Mint authority still live | The dev can print unlimited new supply |
| Freeze authority still live | Your tokens can be frozen so you cannot sell |
| Token-2022 transfer fee > 10% | Skimmed off every trade |
| RugCheck `danger` risks | Unlocked LP, top-holder concentration, honeypot patterns |

The governing rule: **fail closed on a bad answer, fail loud on no answer.** A check that
says "dangerous" rejects the coin. A check that cannot run never silently passes it — the
coin is marked unverified, penalised 8 points (so a slightly lower-scoring but fully
verified coin wins instead), and the gap is printed on the card. If *no* check could run,
the card says so in red and tells you the pick is unvetted.

The highest-scoring coin is therefore not always the winner — the highest-scoring coin
that *survives vetting* is. The runners-up table shows ✓ / partial / ✗ for each, so you
can see the filter working.

**6 — Time the entry** (`src/entry.js`). Picking the right coin and picking the right
moment are different problems — a good coin bought at the top of a vertical candle still
loses money. Every pick gets an entry verdict:

| Verdict | Trigger | What you get |
| --- | --- | --- |
| **Good entry now** | rising steadily, not vertical | entry zone + a chase limit |
| **Close — wait for a small dip** | most of the 6h move happened this hour | a shallow (23.6–38.2%) retracement target |
| **Wait for the pullback** | +60% in an hour, or +8% in five minutes | a deeper (38.2–61.8%) retracement target |
| **Do not buy yet** | down 5%+ on the hour | a level to watch once it bases |
| **Momentum has gone quiet** | flat hour, volume under 70% of its 6h average | no urgency |

Targets are derived, never invented: the market cap 1h and 6h ago is reconstructed from
the price changes, the move from that low to now is "the leg", and the entry zone is a
Fibonacci retracement of that leg. Every card also shows **do not chase above** (+12%)
and **thesis dead below** (the base of the leg), so you go in with an exit already
decided. The runners-up table carries the same verdict and target.

**7 — Show.** One winner card with price, cap, liquidity, age, a **"why this one"**
breakdown of every score component, an honest upside band, the contract address with a
copy button, and links to Jupiter / DexScreener / Birdeye / RugCheck. Top-5 runners-up
below it, each with its own safety and entry verdict.

The card **refreshes itself every 45 seconds** — market cap and the price-change window
move together, so the entry levels stay derived from current data rather than from
whenever you happened to click. It pauses on a hidden tab and keeps its last good values
if a refresh fails.

Everything rejected is listed in an **expandable audit panel**, grouped by reason with
the tickers, contract failures first. The filters are the most opinionated part of the
app, so they are auditable rather than taken on trust.

If the whole field fails the filters, it says so instead of inventing a pick. If a feed
is down, it says which one and scores on the rest — and a source that responds but
returns zero tokens is reported too, so a changed API shape cannot hide behind a tick.

## Track record

Every pick is stored in your browser with the market cap at the time, and re-graded
against live data whenever you open the page: median result, best, how many went up
1.5x+, and how many lost 75%+. Nothing leaves the device and nothing is cleaned up to
look good — if the picks are bad, the table says so. There is a Clear button.

---

## Run it

**Locally**

```bash
npm start          # python3 -m http.server 8080
npm test           # 79 tests
```

**Docker / Unraid**

```bash
docker compose up -d --build
# or
docker build -t solana-coin-pick .
docker run -d --name solana-coin-pick -p 8080:80 --restart unless-stopped solana-coin-pick
```

Then browse to `http://<your-unraid-ip>:8080`.

In the Unraid UI: **Docker → Add Container** → Repository `solana-coin-pick:latest`
(after building it on the box, or push it to a registry first) → Network `bridge` →
add port `8080` → `80`. No paths, no variables, no secrets to configure.

**GitHub Pages** deploys automatically on push via `.github/workflows/pages.yml`
(tests must pass first). If the site 404s, enable it once at
**Settings → Pages → Source: GitHub Actions**.

---

## Testing

79 tests, run on every push before deploy:

```bash
npm test
```

Beyond the unit tests, the suite includes **property tests** that throw thousands of
random and deliberately hostile candidates at the model and assert invariants — scores
finite and in range, entry levels correctly ordered, never advising entry above the
current cap, no NaN reaching a formatter. That fuzzing found three real crash paths on
its first run, all reachable from live API data.

There are also **packaging guards**: every module must be imported, referenced by
`index.html`, copied by the `Dockerfile` and staged by the Pages workflow, with no bare
imports and no committed keys. Removing a copy step fails the suite. And **sanitiser
tests** pin the two defences against third-party strings — HTML escaping for text, an
https-only allowlist for anything reaching an `href` or `src`.

## Tuning it

Everything worth changing lives in `src/config.js` — the filter thresholds and the
scoring weights. Want more aggressive picks? Drop `maxFdvUsd` to `5_000_000` and raise
the `momentum` weight. Want safer ones? Raise `minLiquidityUsd`.

`npm test` covers the filters, each scoring signal, ranking, the contract-safety verdicts,
entry timing and the malformed-data path (30 tests), so you can retune with a safety net.

`CONFIG.safety` controls the vetting: `maxVetted` (how many to contract-check per click),
`vetConcurrency`, and `unverifiedPenalty`.

Contract results are cached for 15 minutes in `localStorage`, and vetting stops at the
first fully verified coin, which together keep the free public RPCs from rate-limiting
repeated clicks.

## v2 — paid signals

`src/sources.js` has stubbed adapters, each gated on an empty key in `CONFIG.paid`, so
adding one is a paste and a function body:

- **Helius** — a private RPC, so the mint/authority checks stop being rate-limited by the
  public endpoints, plus exact top-10 holder concentration.
- **Birdeye** — 1-minute OHLCV for true acceleration, real holder counts.
- **X / Twitter** — mention velocity, the strongest leading indicator that no free tier
  gives you.

## Layout

```
index.html        the page
styles.css        dark terminal styling
src/config.js     filters, weights, safety settings, optional paid keys
src/sources.js    fail-soft market-data clients
src/safety.js     contract rug checks (RPC mint authority + RugCheck)
src/entry.js      entry timing and retracement targets
src/select.js     winner selection over the vetted shortlist
src/cache.js      TTL cache (localStorage, memory fallback)
src/history.js    pick storage and grading
src/score.js      pure scoring engine
src/format.js     display helpers
src/app.js        orchestration + rendering
tests/            79 tests: unit, property/fuzz, packaging and sanitiser
Dockerfile        nginx:alpine static image
```
