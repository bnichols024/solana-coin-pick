# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                                              # all 133 tests
node --test tests/score.test.mjs                      # one file
node --test --test-name-pattern="headroom" tests/*.test.mjs   # one test by name
npm start                                             # serve at :8080 (python3 http.server)
npm run docker:build && npm run docker:run            # nginx image on :8080
```

There is no build step, no linter, and no `node_modules`. `npm test` is the whole gate.

## Architecture

A static, dependency-free browser app. `index.html` loads `src/app.js` as an ES module
and everything runs client-side against free keyless APIs, which is why the identical
files serve from GitHub Pages and from the nginx container.

**Pipeline** — `src/app.js` `run()` orchestrates; each stage lives in its own module:

1. `sources.js` `discoverCandidates()` — five feeds in parallel (DexScreener boosts ×2 +
   profiles, GeckoTerminal new + trending pools) producing a `seeds` Map of
   `address → {boostAmount, hasProfile, sources[]}`. Each source is independently
   fail-soft and returns a `count`; a source that responds with **zero rows** is
   reported as a failure, because that is how a changed API shape shows up.
2. `app.js` orders seeds, then `sources.js` `hydratePairs()` batches DexScreener token
   lookups 30 at a time (capped at `CONFIG.fetch.maxBatches`) keeping each token's
   deepest pool.
3. `score.js` `normalizePair()` flattens a pair into the flat candidate shape everything
   downstream uses, then `rankCandidates(candidates, tuning)` applies `rejectReasons()`
   and `scoreCandidate()`.
4. `select.js` `vetShortlist()` contract-checks the top `CONFIG.safety.maxVetted` in rank
   order via `safety.js` `vetToken()`, stopping at the first fully verified pass.
5. `entry.js` `assessEntry()` decides buy-now vs wait and derives retracement targets.
6. `app.js` renders; `history.js` records and later grades the pick.

`config.js` holds every threshold. `cache.js` is a TTL wrapper over `localStorage` with
an in-memory fallback (contract results cache 15 minutes — this is what keeps the free
public Solana RPCs from rate-limiting repeat clicks).

### Rules the code is built around

**Safety fails closed on a bad answer, loud on no answer.** `evaluateSafety()` rejects a
coin outright on a dangerous verdict. A check that *could not run* never silently passes
it: the coin is marked `unverified`, docked `CONFIG.safety.unverifiedPenalty` points so a
lower-scoring fully verified coin outranks it, and the gap is printed on the card. Never
let a failed check read as a pass.

**Presets thread through the model, not around it.** `resolvePreset()` merges a preset
over `CONFIG.filters`/`weights`; `rankCandidates` passes both into `rejectReasons` and
`scoreCandidate`, and the signal functions take `filters`. Signals whose scale depends on
a threshold (`headroomScore`, `freshnessScore`) derive their range from the *active*
filters. Adding a preset with a much narrower range will silently flatten any signal that
hardcodes a boundary — this already happened twice with the Gamble tier, where headroom
collapsed to a constant 1 and freshness scored every candidate 0 while ranking the oldest
coin highest. `scale()`/`logScale()` step rather than divide by zero on a degenerate
range, but that only converts the bug from NaN to constant; check new presets numerically.

**Fresh-hunting presets need seed-ordering help.** Seeds are normally ranked by
corroborating feeds then boost spend. A coin minutes old appears in one feed with no
promotion, so it sorts below the hydration cap and is never priced. `app.js` puts
`gecko-new` seeds first when `filters.maxPairAgeDays <= 1`.

**Third-party strings reach the DOM.** `esc()` for text, `safeUrl()` (absolute `https:`
only, no base URL — relative input must fail) for anything in an `href`/`src`.

## Constraints that will bite

- **Adding a file to `src/` requires updating `Dockerfile` *and*
  `.github/workflows/pages.yml`.** Both list assets by hand; `tests/deploy.test.mjs`
  enforces it.
- **No bare imports.** The browser loads these modules directly — `import x from 'pkg'`
  breaks the page. Enforced by a test.
- **A strict CSP meta tag in `index.html` blocks inline `style` attributes.** Set widths
  through the CSSOM (`el.style.width = …`). New outbound hosts must be added to
  `connect-src`; a test keeps the policy in sync with the source.
- **Sized `<span>`s need an explicit `display`.** Width/height do not apply to inline
  elements. The score bars shipped invisible for several versions because of this; the
  style attribute looked correct while the rendered width was 0. Measure geometry, not
  attributes.
- **This sandbox's egress blocks the crypto APIs and `github.io`.** You cannot smoke-test
  live data or load the deployed page. Use Playwright (`/opt/pw-browsers/chromium-1194`,
  pass `executablePath`) with `page.route` mocks — that is how every UI change here has
  been verified.
- **`curl` to `api.github.com` returns "GitHub access is not enabled".** Use the
  `mcp__github__*` tools for workflow/run status; curl-based polling silently reports
  nothing.

## Deploying

GitHub Pages only accepts deployments from `main` — the `github-pages` environment's
branch policy rejects other branches before any step runs (the job fails in ~2s with zero
steps and no runner, which is the signature to recognise). Work on the feature branch,
then fast-forward:

```bash
git checkout main && git merge --ff-only <branch> && git push origin main && git checkout <branch>
```

The workflow runs tests first and only deploys if they pass. `concurrency:
cancel-in-progress` means pushing twice quickly shows the earlier run as **cancelled** —
benign when the newer commit is a descendant, but check rather than assume.

## Testing approach

`tests/` is not only unit tests, and new work is expected to extend the right category:

- `score`/`entry`/`preset`/`state`/`select` — behaviour against `tests/fixtures.js`.
- `fuzz.test.mjs` — thousands of random and hostile candidates asserting invariants
  (finite scores in range, ordered entry levels, never advising entry above the current
  cap). This found three live crash paths on its first run.
- `sources.test.mjs` / `safety-net.test.mjs` — network layer against a stubbed
  `globalThis.fetch`; batching, retry-vs-permanent-failure, RPC fallback, Token-2022
  parsing.
- `deploy.test.mjs` / `sanitize.test.mjs` — packaging, nginx config, CSP and sanitiser
  guards. **Verify these by mutation** (break the thing, confirm the suite fails, restore)
  — several assert on files no test can execute.

The Docker image has never been built in this environment; `nginx.conf` is only checked
structurally.
