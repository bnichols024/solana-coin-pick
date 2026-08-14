# 🚀 Winning Meme Coin Generator

One button. It scans every **free** Solana market feed, throws out the rugs and the
dead pools, and ranks what is left on its odds of a 5x–100x move in the next 24 hours.

**Live:** https://bnichols024.github.io/solana-coin-pick/

> ⚠️ **This is a gambling heuristic, not financial advice.** Most meme coins go to zero.
> The scan reads public market data — it cannot see rug pulls, insider supply, or the
> future. Never risk money you cannot afford to lose entirely.

---

## How it works

No backend, no database, and one free-tier API key (Helius) committed in plain sight
because there is no server to hide it in. Everything runs in your browser, so the same
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
- FDV over $3M — above that the ceiling is gone before you start (see **v4** below)
- pair younger than 45 minutes (sniper/rug window) or older than 3 days
- fewer than 300 trades, or an average trade size that reads as wash volume or whales
- already up 400%+ on the day **and** red on the hour (blow-off top)
- **up more than 150% on the day, or 100% in six hours, once the coin is past six
  hours old** — the entry has already gone. Inside those first six hours the rule is
  suspended, because for a coin that young the move *is* its whole life
- top 10 wallets holding more than 30% of supply (checked at the vetting stage)

Plus honeypot tells that need no extra API: a token with buyers and **zero sellers**, a
wildly lopsided buy/sell ratio (sell tax), or a pool already down 60%+ on thin liquidity
(the rug has happened).

**4 — Score 0–100.** Weighted signals, each shown in the result card:

| Signal | Weight | What it measures |
| --- | --- | --- |
| Early move | 25% | Rising and accelerating, **discounted hard once vertical or extended** |
| Buy pressure | 25% | 1h and 6h buy/sell transaction ratio |
| Volume velocity | 10% | 1h volume against liquidity — pool turns per hour |
| Corroboration | 3% | Profile, socials, multiple feeds. **Not** boost spend |
| Upside headroom | 22% | Log-inverse FDV — small cap, room to run |
| Freshness | 15% | Sweet spot runs to 72h, or halfway through a preset's shorter age window |

### Model v4 — lateness is a rejection, not a discount

Three model versions in, the track record still said the same thing: 20 picks, peaks of
1.04, 1.06, 1.07, 1.08, 1.23, 1.26, 1.39, 1.52, 1.53, 1.72 and 2.11, then −73% to −99%,
with several tokens gone entirely. Two patterns explain most of it.

**Size capped the ceiling.** Every pick above roughly $500K market cap peaked between
1.04x and 1.08x — they never moved at all. The only ones that reached 1.5x were $146K,
$207K and $561K. The cap ceiling was $30M. v4 drops it to $3M on Balanced and $1.5M on
Degen, and shortens the age window from three weeks to three days.

**We were still buying finished moves.** v2 and v3 made lateness a *weight* — a coin up
250% on the day cleared every filter and lost a fraction of one signal. The only hard
rule needed a coin to be up 400% **and** red on the hour, which almost never co-occurs.
In v4 an already-run coin is thrown out of the field, age-aware exactly as v3's momentum
is: past six hours old, up more than 150% on the day or 100% in six hours means the
entry has gone.

**New fact:** top-10 holder concentration, from Helius, at the vetting stage. This is the
one thing free market data cannot see, and it is the most likely explanation for the rows
that went to −95% and then to no data at all.

Measured against a synthetic board of 20,000 candidates, v4 keeps about 12% of what
Balanced would have scored under v3 — a much smaller field, not an empty one — and halves
the median market cap of what survives. As with v2, this is a hypothesis fitted to a
small number of data points. It is stamped `modelVersion: 4` so the track record judges
it on its own picks and reverting is a config change.

### Model v3 — "late" depends on age

v2 could not tell a 25-minute-old coin from a three-day-old one. Both, up 200%, scored
momentum `0.150`, because the lateness penalty read the price windows without knowing how
long the coin had existed. For a three-day-old coin +200% means the entry has passed; for
one 25 minutes old that 200% *is its whole life* and there was no earlier entry to miss.
The Gamble tier — which exists to catch exactly these — was ranking a parabolic launch 23
points below a sedate one.

Lateness now blends by maturity (0 at launch, 1 by six hours). A mature coin is late when
it is extended; a young one is late only when the move is **rolling over** — the last five
minutes dropping below the hourly pace. A young launch still ripping scores 0.94, the same
launch fading scores 0.26, and every mature case is unchanged from v2.

### Model v2 — why these weights

v1 lost money: 16 picks, median −36%. The Peak column diagnosed it. Peaks since pick were
1.04, 1.06, 1.07, 1.23, 1.26, 1.39, 1.52 — **nothing reached 2x**, so a perfect exit would
still have been roughly break-even against downside of −54% to −91%. The picks were
already finished moving when they were bought.

Two structural causes, both now addressed:

- **Momentum rose monotonically with the 1h change**, so the most vertical candle on the
  board always won. On meme coins that is the exit signal. `momentumScore` now peaks in
  the middle and decays toward the extreme, and multiplies rather than adds so a flat coin
  still scores zero.
- **Boosts and trending list a coin *because* it already pumped.** `gecko-new` is the only
  leading feed and was the lowest-priority seed outside Gamble, often cut by the hydration
  cap. New pools now rank first for every preset, and the cap rose from 240 to 360.

Boost spend was half of the old attention score. It is money paid to attract buyers,
frequently by someone exiting into them, and is no longer scored at all.

**Every pick is stamped with `CONFIG.modelVersion`**, and the track record reports each
version separately — so v1's losses never average into v2's results, and a future change
is measurable the same way. Judge a new model on **median peak**, which measures the
finder independently of exit timing.

Then risk deductions: thin float vs market cap, shallow liquidity, red hour, sellers
outnumbering buyers.

**5 — Vet the contract** (`src/safety.js`). Market data cannot see a rug coming, so the
top-ranked coins get their actual mint account and contract report checked before one is
handed to you. Helius first (a private RPC, so these checks stop being rate-limited into
"unverified"), falling back to three public Solana RPCs, plus RugCheck's public summary.

| Rejected outright | Why it matters |
| --- | --- |
| Mint authority still live | The dev can print unlimited new supply |
| Freeze authority still live | Your tokens can be frozen so you cannot sell |
| Token-2022 transfer fee > 10% | Skimmed off every trade |
| RugCheck `danger` risks | Unlocked LP, top-holder concentration, honeypot patterns |
| Top 10 wallets hold >30% of supply | A handful of people can end the coin in one transaction |

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

**Check a specific coin.** Paste any contract address into the autopsy panel and the app
reports what it actually thinks: which feeds list it right now, its peak since launch, and
for every preset either the exact filters it fails or its score and breakdown — plus
contract checks and an entry verdict. This answers "why didn't you pick this one?" from
the real pipeline rather than from guesswork, and distinguishes a **scoring** miss from a
**discovery** one (a pump.fun token still on its bonding curve returns no pair at all, and
no amount of tuning would have found it).

Everything rejected is listed in an **expandable audit panel**, grouped by reason with
the tickers, contract failures first. The filters are the most opinionated part of the
app, so they are auditable rather than taken on trust.

If the whole field fails the filters, it says so instead of inventing a pick. If a feed
is down, it says which one and scores on the rest — and a source that responds but
returns zero tokens is reported too, so a changed API shape cannot hide behind a tick.

## Risk presets

Four profiles above the button, remembered between visits:

| Preset | What changes |
| --- | --- |
| **Cautious** | $60K+ liquidity, cap ceiling $8M, 600+ trades, 3h+ old, max 7 days; weights favour buy pressure and staying power |
| **Balanced** | The shipped defaults |
| **Degen** | $15K+ liquidity, cap ceiling $1.5M, 200+ trades, 1h+ old, **max 24 hours**; weights favour momentum and headroom |
| **Gamble** | Cap ceiling **$50K**, $3K+ liquidity, 25+ trades, **15–60 minutes old**. Brand-new lottery tickets — expect most to go to zero |

**Gamble** is an order of magnitude below the others on every floor, because a $50K coin
minutes off the launchpad cannot clear thresholds written for an established $1M one.
Three things had to change under the hood to make the tier work at all:

- **Headroom** scaled from a fixed $50K floor, which collapses to a constant against a
  $50K ceiling — every gamble coin scoring an identical, meaningless 1.
- **Freshness** ramped up over the first two hours, on the assumption that a brand-new
  pair is unproven. In a one-hour window that scored *every* candidate zero and ranked
  the oldest one highest. Both boundaries now scale to the allowed window, so inside an
  hour younger genuinely wins.
- **Seed ordering** ranked candidates by corroborating feeds and paid promotion. A coin
  twenty minutes old appears in exactly one feed with no promotion, so it sorted below
  the hydration cap and was never even priced. Fresh-hunting presets now put newly
  listed pools first — without this the tier returns nothing no matter how the filters
  are set.

Volume and trade floors are also lower than raw numbers suggest they should be: those
counters are 24-hour totals, but nothing in this tier is more than an hour old, so they
are really whole-life numbers.

The contract rug checks are identical in all four — appetite changes which coins are
considered, never whether they are vetted. Gamble picks still get mint authority, freeze
authority, LP lock, honeypot and impersonation checks. Expect more "partial" safety
results down there, though: RugCheck often has no report for a coin this new.

## Track record

Every pick is stored in your browser with the market cap at the time, and re-graded
against live data whenever you open the page: median result, best, how many went up
1.5x+, and how many lost 75%+. Nothing leaves the device and nothing is cleaned up to
look good — if the picks are bad, the table says so. There is a Clear button.

Each row also shows the **peak** it reached since being picked, pulled from GeckoTerminal's
free OHLCV history, filled in a few per visit and **persisted once learned** — peaks only
rise, so re-fetching them every page load just burns the rate limit and leaves the column
empty. Where a peak is unavailable the app names the reason rather than showing a bare
dash. This is the diagnostic that matters when picks are losing: a coin that
went 5x and came back is a missing *exit* signal, one that only ever went down is a bad
*pick*, and the "market cap now" column cannot tell those apart. They need opposite fixes.

Once there are at least eight graded picks, the app also **marks its own homework**:
it buckets results by the score it assigned and reports the median multiple of each
band. If high-scoring picks are not outperforming low-scoring ones, it says so in as
many words — "higher scores are doing worse, treat the score with suspicion". A model
that cannot report its own failure is not worth trusting.

The table also records what the app *advised* at pick time. Results are measured from
the market cap when the coin was picked, so a row where the verdict was **Wait** or
**Small dip** understates the outcome — the recommended entry was below that. The
footnote says so rather than quietly taking the credit.

---

## Security

The page renders strings from third-party APIs, so: everything is HTML-escaped, anything
reaching an `href` or `src` must be an absolute `https` URL, and a `Content-Security-Policy`
meta tag denies by default and allows `connect-src` only to the seven hosts the app
actually calls. A test asserts the policy stays in sync with the code.

## Run it

**Locally**

```bash
npm start          # python3 -m http.server 8080
npm test           # 163 tests
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

163 tests, run on every push before deploy:

```bash
npm test
```

Beyond the unit tests, the suite includes **property tests** that throw thousands of
random and deliberately hostile candidates at the model and assert invariants — scores
finite and in range, entry levels correctly ordered, never advising entry above the
current cap, no NaN reaching a formatter. That fuzzing found three real crash paths on
its first run, all reachable from live API data.

The network layer is tested against a stubbed `fetch`: batching, deepest-pool
selection, retry-and-recover versus permanent failure, the RPC fallback chain, and
Token-2022 extension parsing.

There are also **packaging guards**: every module must be imported, referenced by
`index.html`, copied by the `Dockerfile` and staged by the Pages workflow, with no bare
imports and no committed keys. Removing a copy step fails the suite. The nginx container is the one deployment path
these tests cannot execute, so its config is checked structurally instead — balanced
braces, the listen port matching the Dockerfile, the root matching the COPY target, and
every MIME type the app serves being present in the redefined types block (a wrong one
there means the browser refuses every ES module and the page renders nothing). And **sanitiser
tests** pin the two defences against third-party strings — HTML escaping for text, an
https-only allowlist for anything reaching an `href` or `src`.

## Tuning it

Everything worth changing lives in `src/config.js` — the filter thresholds and the
scoring weights. Want more aggressive picks? Drop `maxFdvUsd` and raise the `momentum`
weight. Want safer ones? Raise `minLiquidityUsd`. Want to see more of the board, at the
cost of the thing v4 was built to stop? Raise `maxChange24h`.

`npm test` covers the filters, each scoring signal, ranking, the contract-safety verdicts,
entry timing and the malformed-data path, so you can retune with a safety net.

`CONFIG.safety` controls the vetting: `maxVetted` (how many to contract-check per click),
`vetConcurrency`, and `unverifiedPenalty`.

Contract results are cached for 15 minutes in `localStorage`, and vetting stops at the
first fully verified coin, which together keep the free public RPCs from rate-limiting
repeated clicks.

## Paid signals

`src/sources.js` has stubbed adapters, each gated on an empty key in `CONFIG.paid`, so
adding one is a paste and a function body:

- **Helius** — *wired up.* A private RPC for the mint/authority checks, plus top-10
  holder concentration computed from `getTokenLargestAccounts`. The AMM's own liquidity
  vault is excluded by asking the chain whether each owner is a plain wallet (owned by
  the System Program) or a program-controlled account — no hardcoded list of AMM
  addresses to go stale. The key is committed in `CONFIG.paid.heliusApiKey`; it is
  free-tier, so the worst case is someone spending the rate limit.
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
tests/            163 tests: unit, network, property/fuzz, packaging, sanitiser
Dockerfile        nginx:alpine static image
```
