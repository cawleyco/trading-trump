# Implementation Plan — Political Trade Intelligence Layer

This document is a complete, ordered work plan for evolving this trading bot from a
"copy disclosed trades" pipeline into a **political market-intelligence terminal**:
trade-quality scoring, explainable thesis cards, a political knowledge graph,
disclosure-aware backtesting, a strategy builder, and guardrailed execution.

It is written to be executed **phase by phase, task by task** by an implementing model.
Read the whole "Ground rules" section first, then execute phases strictly in order —
later phases depend on earlier ones.

---

## Ground rules for the implementing model

1. **Read before writing.** Before starting any phase, read: `README.md`,
   `docs/FUNCTIONALITY.md`, `server/db.js`, `server/signal.js`, `server/riskManager.js`,
   `server/config.js`, and every file the phase says it touches.
2. **One task = one commit.** Complete a task, run `npm test`, commit with a message
   like `feat(score): add freshness factor (task 4.2)`. Never batch multiple tasks
   into one commit.
3. **Never break the live pipeline.** The existing flow
   (`poller → makeTradeSignal → processSignal → order`) must keep working after every
   commit. All new behavior ships behind config flags that default to today's behavior.
4. **Match existing conventions.** ESM modules, `better-sqlite3` prepared statements,
   idempotent migrations in `server/db.js` using the existing `hasColumn()` pattern,
   structured logging via `server/logger.js` with a `component` name, Express routes in
   `server/index.js`, React views in `client/src/views/` using the existing plain-JS +
   Recharts style. No TypeScript, no new frameworks, no ORM.
5. **Tests are offline.** Unit tests (`test/*.test.js`, run with `npm test`) must never
   hit the network or the Anthropic API. Put sample API payloads in `test/fixtures/`
   as JSON files and test parsers/scorers/engines against them.
6. **Every number the user sees must be explainable.** Any score, warning, or
   recommendation must persist the inputs it was computed from (as a JSON column) so
   the UI and audit trail can show *why*.
7. **Degrade gracefully.** Every external data source (Quiver, congress.gov, Senate LDA,
   USAspending, SEC) can be down or unconfigured. A missing source must never crash a
   poller or block trading — log, skip, and mark the affected factor as "no data".
8. **All new endpoints go in `docs/API.md`; all new env vars go in
   `docs/CONFIGURATION.md`; each phase ends by updating `docs/FUNCTIONALITY.md`.**
9. **This is a personal, local, research-first tool.** Keep the compliance posture of
   the README: research/paper modes are the default; live execution stays opt-in per
   fund and everything is disclaimed as not-investment-advice.

### Existing architecture you are extending

```
sources/congressPoller ─┐    ┌─ sources/truthSocialPoller      ┌─ positionManager.js
 (Quiver or Senate eFD) ▼    ▼   + sentiment/classifier        ▼  (per-fund auto-exits)
                   signal.js (normalized TradeSignal)
                        ▼
                   riskManager.js ── fans out per fund ← config.js (.env + funds.json)
                        ▼
                   alpacaClient.js → one Alpaca connection per fund
                        ▼
                   db.js (SQLite audit trail) ← attribution.js
                        ▲
     backtest/{simulate,congressBacktest,tweetBacktest}.js
                        ▲
                   server/index.js (Express API) → client/ (React dashboard)
```

The normalized congress trade shape (from `server/sources/congressData.js`) is:
`{ politician, ticker, type: 'buy'|'sell', transactionDate, disclosureDate, amountRange, raw }`

### Target end-state architecture (what this plan builds)

```
congress trades ──► ingest + data-quality layer (Phase 1) ──► congress_trades table
                                                                    │
   market data helpers (Phase 0) ──► freshness/drift/liquidity ─────┤
   knowledge graph (Phase 6)     ──► committee/bill/lobby relevance ┤
   politician stats (Phase 3)    ──► historical edge ───────────────┤
                                                                    ▼
                                          copy-score engine (Phase 4)
                                                    │
                        ┌───────────────────────────┼─────────────────────────┐
                        ▼                           ▼                         ▼
              thesis cards (Phase 5)      strategy engine (Phase 9)   alerts (Phase 11)
                                                    │
                                    manual-approval queue / auto mode
                                                    ▼
                                     riskManager (+ Phase 10 guardrails)
```

### External data sources used in this plan (all free unless noted)

| Source | URL | Used for | Auth |
|---|---|---|---|
| Quiver Quantitative | `api.quiverquant.com` | House+Senate trades (already integrated) | paid key (optional) |
| Senate eFD | `efdsearch.senate.gov` | Senate trades (already integrated) | none |
| unitedstates/congress-legislators | `https://raw.githubusercontent.com/unitedstates/congress-legislators/main/legislators-current.yaml` and `.../committee-membership-current.yaml` and `.../committees-current.yaml` | politician identity + committee membership | none |
| congress.gov API | `https://api.congress.gov/v3` | bills, committee activity, hearings | free API key (`CONGRESS_GOV_API_KEY`) |
| Senate LDA API | `https://lda.senate.gov/api/v1/` | lobbying filings by company | none (rate-limited; register for higher limits) |
| USAspending API | `https://api.usaspending.gov/api/v2/` | federal contracts by company | none |
| SEC company tickers | `https://www.sec.gov/files/company_tickers.json` | ticker → company name/CIK | none (set a User-Agent header) |
| SEC submissions | `https://data.sec.gov/submissions/CIK##########.json` | SIC code → sector | none (User-Agent header) |
| Alpaca (existing) | existing client | prices, bars, liquidity, tradability | existing keys |

Every fetcher for these goes in `server/sources/` and follows the pattern of
`congressData.js`: axios + `p-retry`, a `normalizeX(row)` function, and a small module
API. Cache raw responses on disk under a new gitignored `data-cache/` directory with a
TTL, because committee/legislator/SEC data changes slowly.

---

## Phase 0 — Foundations: trade archive + market-data helpers

Everything later needs (a) congress trades stored as full rows, not just dedup keys,
and (b) reusable price utilities. Do this first.

### Task 0.1 — `congress_trades` table (the archive)

**Files:** `server/db.js`, `server/sources/congressPoller.js`, `server/backtest/congressBacktest.js`

Add to `server/db.js`:

```sql
CREATE TABLE IF NOT EXISTS congress_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_key TEXT UNIQUE NOT NULL,        -- same key as seen_congress_trades
  politician TEXT NOT NULL,
  politician_id TEXT,                    -- bioguide id, filled by Phase 6; NULL ok
  ticker TEXT NOT NULL,
  type TEXT NOT NULL,                    -- 'buy' | 'sell'
  transaction_date TEXT,                 -- YYYY-MM-DD
  disclosure_date TEXT,                  -- YYYY-MM-DD (filing date)
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),  -- when WE first saw it (publish time)
  amount_range TEXT,                     -- raw band string e.g. "$15,001 - $50,000"
  amount_min REAL, amount_max REAL, amount_mid REAL,      -- parsed from the band
  asset_description TEXT,               -- raw asset text when available
  owner TEXT,                            -- 'self' | 'spouse' | 'dependent' | NULL
  is_option INTEGER NOT NULL DEFAULT 0,
  option_detail TEXT,                    -- JSON {type,strike,expiry} when parseable
  source TEXT NOT NULL,                  -- 'quiver' | 'senate-efd'
  source_url TEXT,                       -- link to the original filing when known
  parse_confidence REAL NOT NULL DEFAULT 1.0,  -- Phase 1 fills this
  amendment_of TEXT,                     -- trade_key this row amends, if any
  raw TEXT                               -- original JSON row
);
CREATE INDEX IF NOT EXISTS idx_ct_ticker ON congress_trades(ticker);
CREATE INDEX IF NOT EXISTS idx_ct_politician ON congress_trades(politician);
CREATE INDEX IF NOT EXISTS idx_ct_disclosure ON congress_trades(disclosure_date);
```

Add db helpers: `upsertCongressTrade(trade)` (INSERT OR IGNORE by `trade_key`, returns
row id and whether it was new), `listCongressTrades({politician, ticker, since, until, limit})`,
`getCongressTradeByKey(key)`.

Write an amount-range parser in a new `server/lib/amountRange.js`:
`parseAmountRange("$15,001 - $50,000") → {min: 15001, max: 50000, mid: 32500}`.
Handle the standard STOCK Act bands, "Over $50,000,000"-style open-ended bands
(use min as mid×0.5 rule: `mid = min * 1.5`), `$1,001 -` variants, and garbage input
(→ all nulls). **Unit-test this exhaustively** in `test/amountRange.test.js` — every
official band plus malformed strings.

Change `congressPoller.js` so every fetched trade (seen or not) is upserted into
`congress_trades` *before* the dedup check; keep `seen_congress_trades` exactly as-is
for dedup semantics. The poller behavior must not otherwise change.

Change `congressBacktest.js`'s `getHistoricalTrades` to read from `congress_trades`
first and only fall back to the network fetch when the table has no rows covering the
requested range (keep the network path — the archive starts empty).

**Acceptance:** `npm test` passes; after running the poller once (or the backfill in
0.2), `sqlite3 trading.db "SELECT COUNT(*) FROM congress_trades"` is > 0 with parsed
`amount_mid` values.

### Task 0.2 — Backfill script

**Files:** new `scripts/backfill-congress.js`, `package.json` (add `"backfill": "node scripts/backfill-congress.js"`)

A CLI that calls `fetchHistoricalCongressTrades(start, end)` (default: 3 years back to
today, overridable via `--start`/`--end` args) and upserts everything into
`congress_trades`. Print progress and a final count. Idempotent — safe to re-run.
For backfilled rows, set `first_seen_at = disclosure_date` (best available estimate),
and add a column-less convention: live-poller rows have real `first_seen_at`.

**Acceptance:** `npm run backfill -- --start 2024-01-01` populates the table; second
run inserts 0 new rows.

### Task 0.3 — Market-data helper module

**Files:** new `server/marketData.js`, `test/marketData.test.js` (pure-logic parts only)

Wrap the shared Alpaca client from `alpacaClient.js` with a cached (in-memory Map,
1-hour TTL) helper API used by scoring, profiles, and dashboards:

- `getDailyCloses(ticker, startDate, endDate)` → `[{date, open, close, volume}]`
- `priceOn(ticker, date)` → close of first trading day ≥ date, or null
- `latestPrice(ticker)` → most recent close
- `driftSincePct(ticker, sinceDate)` → percent change from `priceOn(sinceDate)` to
  `latestPrice`, or null if either is missing
- `avgDollarVolume(ticker, days = 20)` → mean of close×volume over last N bars, or null

All functions return `null` on missing data — never throw for a bad ticker. Unit-test
the math with injected bar fixtures (export a `_computeDrift`, `_computeAdv` pure
functions and test those).

### Task 0.4 — Ticker metadata (company name, CIK, sector)

**Files:** new `server/sources/tickerMeta.js`, `server/db.js`, `test/tickerMeta.test.js`

Table:

```sql
CREATE TABLE IF NOT EXISTS ticker_meta (
  ticker TEXT PRIMARY KEY,
  company_name TEXT,
  cik TEXT,
  sic TEXT,
  sector TEXT,           -- one of ~12 coarse buckets, see below
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`tickerMeta.js`:
- `refreshTickerUniverse()` — download SEC `company_tickers.json` (with a proper
  `User-Agent: trading-bot personal research <email>` header), upsert ticker → name/CIK.
  Run at startup if the table is empty or older than 7 days, in the background.
- `getSectorForTicker(ticker)` — if `sector` is null but CIK exists, fetch the SEC
  submissions JSON once for that CIK, map its `sic` to a coarse sector via a static
  map you create in `server/lib/sicSectors.js` (buckets: technology, healthcare,
  financials, energy, defense-aerospace, industrials, consumer, real-estate,
  utilities, materials, communications, other). Cache in the table.
- `resolveTicker(nameOrTicker)` — exact ticker match first, else case-insensitive
  company-name `LIKE` match; also maintain a small manual override map in
  `server/lib/tickerOverrides.js` (e.g. "Alphabet Inc" → GOOGL) that wins over
  everything. This is the entity-resolution entry point Phase 1 and Phase 6 use.

Unit-test the SIC→sector map and override precedence with fixtures.

**Phase 0 definition of done:** archive table populated by poller + backfill, amount
bands parsed, market-data helpers available, ticker→sector resolution working, all
tests offline and green, docs updated.

---

## Phase 1 — Data-quality layer (feature #14) + freshness engine (feature #4)

These two are the substrate for scoring. Freshness math is trivial once the archive
exists; data quality is mostly parser hardening + review flags.

### Task 1.1 — Parse confidence + options + owner extraction

**Files:** `server/sources/senateEfd.js`, `server/sources/congressData.js`, new `server/lib/filingQuality.js`, tests

Create `filingQuality.js` with `assessTrade(normalizedTrade) → {parseConfidence, flags: []}`:

- start at 1.0; subtract for each issue and record a flag string:
  missing `transactionDate` (−0.3, `missing-transaction-date`), missing `amountRange`
  or unparseable band (−0.2, `no-amount`), ticker failed `resolveTicker` (−0.3,
  `unresolved-ticker`), asset description mentions option/put/call but no parsed
  detail (−0.2, `unparsed-option`), disclosure before transaction date (−0.4,
  `date-inconsistency`).
- Detect options: asset description matched against `/\b(call|put|option)s?\b/i`;
  attempt to extract strike (`$123.45` pattern) and expiry (date pattern); set
  `is_option`, `option_detail`.
- Detect owner from raw fields when the source provides them (eFD rows have an owner
  column; Quiver rows sometimes have `Owner`): map to self/spouse/dependent.
- Detect amendments: eFD filing titles containing "(Amendment" — when found, look up an
  existing `congress_trades` row with same politician+ticker+transaction_date and set
  `amendment_of` to its `trade_key`.

Wire into the poller and backfill so every upserted row carries
`parse_confidence`, flags (store flags inside the `raw` JSON under `_qualityFlags`),
`owner`, `is_option`, `option_detail`.

**Acceptance:** unit tests cover each deduction and the option/owner extraction using
fixture rows from both sources.

### Task 1.2 — Human-review queue

**Files:** `server/db.js`, `server/index.js`, `client/src/views/SignalLog.jsx` (or new view), docs

```sql
CREATE TABLE IF NOT EXISTS review_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_key TEXT NOT NULL REFERENCES congress_trades(trade_key),
  reason TEXT NOT NULL,             -- e.g. 'parse_confidence 0.5 < 0.8'
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected'
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Rule: any trade with `parse_confidence < 0.8` is inserted into `review_queue` at ingest
and is **ineligible for auto-trading and strategy auto modes** (enforced later in
Phase 9/10; for now just store it). Endpoints: `GET /api/review-queue`,
`POST /api/review-queue/:id/resolve {status}`. Small dashboard section listing pending
items with the raw filing JSON and `source_url`, plus approve/reject buttons.

### Task 1.3 — Freshness metrics

**Files:** new `server/intel/freshness.js`, tests

Pure functions (no I/O — callers pass rows + prices):

- `disclosureLagDays(trade)` = days between `transaction_date` and `disclosure_date`
  (null-safe).
- `publishLagDays(trade)` = days between `transaction_date` and `first_seen_at`.
- `ageDays(trade, now)` = days since `first_seen_at`.
- `freshnessScore(trade, now)` → 0–100: 100 when total lag (transaction→now) ≤ 5 days,
  linear to 0 at 60 days. Return `{score, lagDays, ageDays, basis}`.

Create the `server/intel/` directory — all intelligence-layer modules from here on
live in it.

### Task 1.4 — Filing-speed leaderboard + drift analytics endpoints

**Files:** `server/index.js`, new `server/intel/freshnessReports.js`, client Dashboard

- `GET /api/intel/filing-speed` → per politician: trade count, median disclosure lag,
  % filed within 15/30/45 days. Straight SQL over `congress_trades`.
- `GET /api/intel/drift/:tradeKey` → `{sinceTransactionPct, sinceDisclosurePct}` using
  `marketData.driftSincePct` — "has this already moved?"
- Add a "Filing speed" table to the dashboard (sortable by median lag).

**Phase 1 definition of done:** every archived trade has quality metadata; low-quality
trades are queued for review; freshness/lag/drift are computable per trade and exposed
via API; leaderboard visible in the UI.

---

## Phase 2 — Disclosure-aware backtesting upgrades (feature #6)

The backtester already enters at first open **after disclosure date** — the honest
baseline. This phase adds the fantasy/realistic comparison, costs, and walk-forward.

### Task 2.1 — Entry-basis modes

**Files:** `server/backtest/congressBacktest.js`, `server/backtest/simulate.js`, `server/index.js`, `client/src/views/Backtest.jsx`

Add `entryBasis` param to `runCongressBacktest` and the leaderboard:
`'transaction'` (fantasy upper bound) | `'disclosure'` (default, current behavior) |
`'first_seen'` (uses `first_seen_at`, the truest copy-trading entry — only meaningful
for rows collected live). Plumb it into `buildPlans` (choose which date becomes
`entryDate`). Results JSON must echo `entryBasis`, and the UI must label fantasy-mode
results with a visible warning banner: *"Assumes you knew on the trade date — not
achievable. Upper bound only."*

Add a convenience endpoint/UI button "Compare modes" that runs the same params under
`transaction` and `disclosure` and returns both summaries side by side — the
fantasy-vs-realistic gap is itself the product insight.

### Task 2.2 — Slippage, spread, and fee modelling

**Files:** `server/backtest/simulate.js`, tests

Add options to `simulateTrades(plans, notional, opts)`:
- `slippageBps` (default 0): worsen every entry fill by +bps and exit fill by −bps.
- `feePerTradeUsd` (default 0): subtract from each round-trip P&L.
- `autoSlippage` (default false): when true, pick slippage tier from
  `avgDollarVolume`: ≥$50M → 5 bps, $10–50M → 15 bps, $1–10M → 40 bps, <$1M → 100 bps.
  Record the tier per trade in the result row.

Keep defaults zero so stored/old backtests remain comparable. Unit-test the
adjustment math with fixture bars.

### Task 2.3 — Walk-forward leaderboard

**Files:** new `server/backtest/walkForward.js`, `server/index.js`, Backtest view

`runWalkForward({startDate, endDate, folds = 4, topN = 5, notionalPerTrade, exitRule})`:
split the range into `folds` equal windows; for each window i < folds−1, rank
politicians by return in window i (reusing leaderboard logic), then simulate copying
only the top-N in window i+1. Output: per-fold results, the aggregate out-of-sample
return, and the same-period SPY benchmark. Persist in `backtests` with
`kind = 'walk-forward'`. This is the overfitting guard — a politician who ranks high
in-sample and flops out-of-sample is noise.

UI: new panel in Backtest view with fold-by-fold table + combined curve.

**Phase 2 definition of done:** fantasy vs realistic comparison runnable from the UI;
slippage/fees parameterized; walk-forward mode persisted and rendered; docs updated.

---

## Phase 3 — Politician alpha profiles (feature #7)

### Task 3.1 — Stats computation job

**Files:** new `server/intel/politicianStats.js`, `server/db.js`, `server/index.js`

```sql
CREATE TABLE IF NOT EXISTS politician_stats (
  politician TEXT PRIMARY KEY,
  as_of TEXT NOT NULL,
  trade_count INTEGER, buy_count INTEGER, sell_count INTEGER,
  median_disclosure_lag REAL,
  avg_amount_mid REAL,
  win_rate_30d REAL, win_rate_90d REAL,          -- % of buys positive N days after disclosure entry
  avg_return_7d REAL, avg_return_30d REAL, avg_return_90d REAL, avg_return_180d REAL,
  best_hold_window TEXT,                          -- '7d'|'30d'|'90d'|'180d' (highest avg return)
  sector_returns TEXT,                            -- JSON {sector: {trades, avgReturn30d}}
  concentration_hhi REAL,                         -- Herfindahl over tickers (0..1)
  recent_avg_return_30d REAL,                     -- same metric, last 12 months only
  edge_score REAL,                                -- 0-100, see below
  stats TEXT                                      -- JSON blob of everything above + extras
);
```

`computePoliticianStats(politician)`:
- Pull their buys from `congress_trades` (exclude `is_option = 1` and
  `parse_confidence < 0.8`).
- For each buy: entry price = `priceOn(ticker, disclosure_date)`; returns at
  +7/30/90/180 calendar days via `priceOn` (skip trades lacking data — count skips).
- Compute all columns above. `edge_score`: percentile rank (0–100) of
  `avg_return_90d` among all politicians with ≥ 10 measurable buys; politicians with
  < 10 buys get `edge_score = NULL` (unknown, not average).
- `refreshAllPoliticianStats()` iterates all politicians in the archive; schedule it
  daily at 06:00 ET via `node-cron` in `server/index.js`, and expose
  `POST /api/intel/refresh-stats` to trigger manually. Log progress; it may take
  minutes — reuse the `marketData` cache.

### Task 3.2 — Profile API + UI

**Files:** `server/index.js`, new `client/src/views/Politicians.jsx`, `client/src/App.jsx`, `client/src/api.js`

- `GET /api/intel/politicians` → stats table rows (for a sortable list view).
- `GET /api/intel/politicians/:name` → full stats + their recent trades (joined with
  scores once Phase 4 lands).
- New "Politicians" view: sortable/searchable table (edge score, win rate, median lag,
  trade count) → click into a profile page: returns-by-horizon bar chart, sector
  breakdown, lag distribution, recent trades list. Style it like a fund-manager
  tear sheet using existing Recharts patterns.

**Phase 3 definition of done:** stats refresh nightly and on demand; profile pages
render; `edge_score` distinguishes "proven bad", "proven good", and "unknown".

---

## Phase 4 — Copy-worthiness score (feature #1) + do-not-copy warnings (feature #11)

The core differentiator. Deterministic and explainable — **no LLM in the score path**.

### Task 4.1 — Score schema + engine skeleton

**Files:** new `server/intel/copyScore.js`, `server/db.js`, tests

```sql
CREATE TABLE IF NOT EXISTS trade_scores (
  trade_key TEXT PRIMARY KEY REFERENCES congress_trades(trade_key),
  score REAL NOT NULL,                 -- 0-100 weighted composite
  confidence REAL NOT NULL,            -- 0-1: fraction of factor weight backed by real data
  recommendation TEXT NOT NULL,        -- 'copy-candidate'|'watchlist'|'avoid'|'manual-review'
  factors TEXT NOT NULL,               -- JSON: per-factor {score, weight, detail, hasData}
  warnings TEXT NOT NULL,              -- JSON array of warning objects
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  inputs_hash TEXT                     -- hash of inputs so we can skip recompute
);
```

`computeCopyScore(trade, ctx)` where `ctx` bundles everything injected (politician
stats row, drift, avg dollar volume, cluster rows, relevance — so the function is pure
and unit-testable). Returns `{score, confidence, recommendation, factors, warnings}`.

**Factors and weights (v1):**

| Factor | Weight | Scoring rule |
|---|---|---|
| `freshness` | 25 | `freshnessScore` from Phase 1 (total lag ≤5d → 100, →0 at 60d) |
| `politicianEdge` | 20 | `edge_score` from Phase 3; NULL → score 50, `hasData: false` |
| `conviction` | 15 | from `amount_mid`: <15k→30, <50k→50, <100k→65, <250k→75, <1M→85, ≥1M→95; +10 if same politician bought same ticker in prior 90d (repeat buy), cap 100; spouse/dependent owner → −10 |
| `alreadyMoved` | 15 | drift since transaction date, direction-aware: for buys, drift ≤2% →90, 5%→60, 10%→30, ≥15%→10; negative drift (pullback) →75. Mirror for sells. No price data → 50, `hasData:false` |
| `cluster` | 10 | distinct politicians trading same ticker, same direction, within trailing 30d (query `congress_trades`): 1→40, 2→60, 3→75, ≥4→90 |
| `liquidity` | 10 | `avgDollarVolume`: ≥$50M→100, ≥$10M→70, ≥$1M→40, else 10; options → 10 flat |
| `committeeRelevance` | 5 | **stub at 50 / `hasData:false` until Phase 6**, which replaces it with real graph relevance and re-weights (see 6.5) |

`score` = Σ(factor.score × weight) / Σ(weights). `confidence` = Σ(weights where
`hasData`) / Σ(weights). Each factor's `detail` is a human-readable string
("disclosed 7 days after trade; you saw it 7 days after trade").

**Warnings (each `{code, severity: 'critical'|'caution', message}`):**

| Code | Trigger |
|---|---|
| `stale-filing` | total lag > 30d (critical if > 45d) |
| `already-priced-in` | drift in trade direction > 10% (critical > 18%) |
| `low-conviction` | amount_mid < 15k and no repeat buy |
| `weak-trader` | edge_score < 35 with ≥10 measured trades |
| `illiquid` | liquidity factor ≤ 40 |
| `options-trade` | `is_option` (critical — never auto-tradable) |
| `low-parse-confidence` | parse_confidence < 0.8 (critical) |
| `no-political-relevance` | Phase 6: relevance factor < 25 |

**Recommendation mapping:** any critical warning → `avoid` (or `manual-review` if the
only critical is `low-parse-confidence`); else score ≥ 75 and confidence ≥ 0.6 →
`copy-candidate`; score ≥ 55 → `watchlist`; else `avoid`. Confidence < 0.5 →
`manual-review` regardless.

Unit-test every factor rule and the mapping table with constructed contexts —
this is the highest-test-value module in the plan.

### Task 4.2 — Scoring pipeline integration

**Files:** new `server/intel/scoreRunner.js`, `server/sources/congressPoller.js`, `server/index.js`

`scoreTrade(tradeKey)` assembles `ctx` (stats lookup, drift, ADV, cluster query) and
persists to `trade_scores`. Call it: (a) for every **new** trade the poller ingests,
before signal creation; (b) nightly for all trades from the last 60 days (drift and
cluster change over time — the `inputs_hash` skips unchanged ones); (c) via
`POST /api/intel/score/:tradeKey`.

Then wire the score into the live pipeline **behind a flag**: new env
`CONGRESS_MIN_COPY_SCORE` (default empty = disabled). When set, the poller attaches
`{copyScore, recommendation}` to the signal's `rawReference` and skips signal creation
for trades scoring below the threshold or recommended `avoid`/`manual-review`
(log the skip with the reason). Default behavior unchanged.

### Task 4.3 — Scores API + trade feed UI

**Files:** `server/index.js`, new `client/src/views/Trades.jsx`

- `GET /api/intel/trades?since=&minScore=&recommendation=&politician=&ticker=` →
  archive rows joined with scores, newest first.
- New "Trades" view: the main feed. Each row: politician, ticker, direction, amount
  band, transaction/disclosure dates, lag badge, **score badge color-coded**
  (≥75 green, 55–74 yellow, <55 red), recommendation chip, warning icons with hover
  text. Clicking a row expands the factor breakdown (each factor: bar + detail
  string) and warnings — this expansion is the pre-cursor of the Phase 5 thesis card.

**Phase 4 definition of done:** every archived trade has a persisted, explainable
score; feed UI ships; poller can gate on score behind a flag; nightly rescoring runs.

---

## Phase 5 — Explainable thesis cards (feature #2)

### Task 5.1 — Deterministic card generator

**Files:** new `server/intel/thesisCard.js`, tests

`buildThesisCard(trade, score, ctx)` → JSON:

```js
{
  what:   "Rep. X purchased NVDA ($50k–$100k) on 2026-06-20, disclosed 2026-06-27.",
  whyItMatters: ["Repeat purchase — 3rd NVDA buy in 90 days.",
                 "Member of the House Armed Services committee (relevance: high)."],  // Phase 6 enriches
  sinceThen: "NVDA is up 3.1% since the trade date and 1.2% since disclosure.",
  signal: { copyScore: 82, confidence: 0.86, recommendation: "copy-candidate",
            politicianEdge: "Top-quartile 90-day returns (edge 78/100)." },
  risks:  ["Disclosure lag of 7 days.", "Options position — expiry unknown."],  // from warnings
  suggestedAction: "watchlist" // 'copy-candidate'|'watchlist'|'avoid'|'manual-review'
}
```

Fully template-based: every sentence is assembled from the factor `detail` strings and
warning messages — no LLM call, so cards are free, instant, and deterministic. Handle
missing data by omitting sentences, never printing "undefined". Unit-test with a full
and a sparse context.

### Task 5.2 — Optional Claude polish (flagged)

**Files:** `server/intel/thesisCard.js`, `server/config.js`

Env `THESIS_LLM=true` (default false): pass the deterministic card JSON to Claude
(reuse the Anthropic client pattern from `sentiment/classifier.js`, model from config)
with a prompt: "Rewrite these bullet points as a 4-sentence analyst note. Do not add
facts not present in the input." Store both versions. On any API error, fall back to
the deterministic card silently.

### Task 5.3 — Card API + UI

**Files:** `server/index.js`, `client/src/views/Trades.jsx`

`GET /api/intel/card/:tradeKey` (build on demand; cache in a `thesis_cards` table
keyed by trade_key + `computed_at`, invalidated when the score's `computed_at` is
newer). Render the card as the expanded row in the Trades view — sections: What
happened / Why it might matter / Since then / Signal strength / Risks / Suggested
action, matching the structure above.

**Phase 5 definition of done:** every scored trade renders a complete card with no
missing-data artifacts; LLM path optional and fault-tolerant.

---

## Phase 6 — Political knowledge graph + relevance engine (feature #3, and the committee factor from #1)

Keep this pragmatic: it's SQLite tables + a 2-hop relevance query, not a graph database.

### Task 6.1 — Politicians + committees ingestion

**Files:** new `server/sources/legislators.js`, `server/db.js`, tests with YAML fixtures

Tables:

```sql
CREATE TABLE IF NOT EXISTS politicians (
  bioguide_id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  chamber TEXT,           -- 'house' | 'senate'
  party TEXT, state TEXT,
  name_variants TEXT       -- JSON array of alternate spellings seen in filings
);
CREATE TABLE IF NOT EXISTS committees (
  committee_id TEXT PRIMARY KEY,   -- thomas_id from the dataset
  name TEXT NOT NULL,
  chamber TEXT,
  sectors TEXT                     -- JSON array of coarse sectors (static map, 6.2)
);
CREATE TABLE IF NOT EXISTS committee_memberships (
  bioguide_id TEXT NOT NULL,
  committee_id TEXT NOT NULL,
  role TEXT,                       -- 'member' | 'chair' | 'ranking member'
  PRIMARY KEY (bioguide_id, committee_id)
);
```

Fetch the three YAML files from the `unitedstates/congress-legislators` repo (add the
`yaml` npm package). Refresh weekly via cron + on demand. Then **name-link the
archive**: match `congress_trades.politician` strings to bioguide IDs (normalize case,
strip titles like "Hon.", try "Last, First" ↔ "First Last", fall back to fuzzy
last-name + state match; store successful variants in `name_variants`). Fill
`congress_trades.politician_id` for all matchable rows; log the unmatched distinct
names so the override map (`server/lib/politicianOverrides.js`) can be extended
manually.

### Task 6.2 — Committee → sector map

**Files:** new `server/lib/committeeSectors.js`

A static, hand-written map from committee thomas_id/name keywords to the coarse
sector buckets from Task 0.4 (Armed Services → defense-aerospace; Energy & Commerce →
energy, healthcare, communications; Financial Services / Banking → financials;
Agriculture → consumer, materials; SSCI/Intelligence → defense-aerospace, technology;
Judiciary → technology (antitrust); HELP → healthcare; Ways & Means / Finance →
financials, healthcare; Transportation & Infrastructure → industrials; Science, Space
& Technology → technology, defense-aerospace; Natural Resources / ENR → energy,
materials; Veterans' Affairs → healthcare; Homeland Security → defense-aerospace,
technology). Cover every current standing committee; unit-test that every committee
in a fixture list maps to ≥ 0 sectors without throwing.

### Task 6.3 — Bills, lobbying, contracts ingestion

**Files:** new `server/sources/congressGov.js`, `server/sources/lobbying.js`, `server/sources/contracts.js`, `server/db.js`

```sql
CREATE TABLE IF NOT EXISTS bills (
  bill_id TEXT PRIMARY KEY,        -- e.g. 'hr1234-119'
  title TEXT, policy_area TEXT,
  latest_action TEXT, latest_action_date TEXT,
  committees TEXT,                 -- JSON array of committee_ids
  sectors TEXT,                    -- JSON, derived from policy_area + committees
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS lobbying_filings (
  filing_id TEXT PRIMARY KEY,
  client_name TEXT, registrant_name TEXT,
  ticker TEXT,                     -- via resolveTicker(client_name); NULL if unmatched
  amount REAL, filing_period TEXT, filed_at TEXT,
  issues TEXT                      -- JSON array of issue-area codes
);
CREATE TABLE IF NOT EXISTS gov_contracts (
  contract_id TEXT PRIMARY KEY,
  recipient_name TEXT, ticker TEXT,
  awarding_agency TEXT, amount REAL, action_date TEXT
);
```

- `congressGov.js`: needs `CONGRESS_GOV_API_KEY` env. Poll `/v3/bill?sort=updateDate`
  daily; store bills whose committees intersect committees our tracked politicians sit
  on. Derive `sectors` from committee map + policy area keywords.
- `lobbying.js`: Senate LDA API `/api/v1/filings/?filing_period=...`. **Scope: only
  fetch filings for client names matching companies in `ticker_meta` that appear in
  `congress_trades`** (query per company name, most-recent 2 periods). This keeps
  volume manageable.
- `contracts.js`: USAspending `POST /api/v2/search/spending_by_award/` filtered by
  recipient name, last 12 months, for the same company set.
- All three: daily cron, on-demand endpoints, graceful skip when unconfigured/down.

### Task 6.4 — Edges + relevance query

**Files:** new `server/intel/relevance.js`, tests

No separate edges table needed for v1 — relevance is a deterministic join:

`computeRelevance(trade)`:
1. Resolve trade → politician_id → committees → committee sectors.
2. Resolve ticker → sector (+ company name/CIK).
3. Signals, each with points and an explanation string:
   - **committee-sector match** (ticker sector ∈ politician's committee sectors): +40,
     "+chair/ranking role": +10.
   - **active bill overlap** (a bill in the politician's committees shares the ticker's
     sector, latest_action_date within 90d): +20.
   - **recent lobbying** (lobbying filing by this company filed within 180d): +15;
     lobbying issue area matches a committee of the politician: +10.
   - **recent contract** (gov contract to this company, action within 180d, and
     politician sits on a committee overseeing the awarding agency — use a small
     static agency→committee map): +15.
4. `relevanceScore` = min(100, sum). Return `{score, signals: [{type, points, text}]}`.

Unit-test with constructed rows covering each signal type and stacking.

### Task 6.5 — Wire relevance into the score + cards

**Files:** `server/intel/copyScore.js`, `server/intel/scoreRunner.js`, `server/intel/thesisCard.js`

Replace the stubbed `committeeRelevance` factor: score = relevanceScore, weights become
freshness 20 / edge 20 / conviction 15 / alreadyMoved 15 / **relevance 15** / cluster 10 /
liquidity 5. Add the `no-political-relevance` warning (relevance < 25). Thesis card's
"Why it might matter" now lists the relevance signal texts. Rescore the archive
(nightly job covers it; also run once manually).

### Task 6.6 — Graph explorer endpoint + UI panel

**Files:** `server/index.js`, `client/src/views/Politicians.jsx`, `client/src/views/Trades.jsx`

`GET /api/intel/graph/:tradeKey` → the full relevance context: politician, committees,
matched bills, lobbying filings, contracts — each with dates and source URLs. Render
as a "Connections" panel inside the expanded trade card and on politician profiles
(their committees + recent related bills). A simple linked list/table is fine — do
**not** build a force-directed graph visualization in v1.

**Phase 6 definition of done:** ≥90% of archive trades link to a bioguide ID;
committees/bills/lobbying/contracts refresh on cron; relevance feeds the score and
cards; connections panel renders with source links.

---

## Phase 7 — Tweet/X market-relevance sentiment engine (feature #8)

### Task 7.1 — Extend the classifier taxonomy

**Files:** `server/sentiment/classifier.js`, `test/signal.test.js` fixtures, `server/db.js`

Extend the Claude prompt to return, per post (strict JSON, keep the conservative
bias):

```js
{
  relevanceType: "company"|"sector"|"legislation"|"regulation"|"contracts"|"opinion"|"none",
  marketRelevance: 0-1,          // separate from per-ticker confidence
  tickers: [{ticker, direction, confidence, rationale}],
  sectors: ["energy", ...]       // when sector-level but no single ticker
}
```

Store the full classification JSON in a new `seen_posts.classification` column
(migration via `hasColumn`). Signal gating: only create signals when
`marketRelevance ≥ SENTIMENT_MIN_RELEVANCE` (new env, default 0.5) AND relevanceType
is not `opinion`/`none` — in addition to the existing per-fund confidence gate.
Sector-only classifications don't trade in v1; they feed alerts (Phase 11).

### Task 7.2 — Cross-signal enrichment

**Files:** new `server/intel/crossSignal.js`, `server/index.js`

When a post classification names a ticker or sector, look for **corroboration**:
congress buys of that ticker/sector in the last 30 days (from `congress_trades` +
scores), and relevant politicians' committee exposure. Attach
`{corroboratingTrades: [...], note}` to the signal's `rawReference` and expose
`GET /api/intel/cross-signal/:postId`. This is metadata for display/alerting only —
it does not change gating in v1.

**Phase 7 definition of done:** classifier returns the extended schema (update its
fixture-based tests); irrelevant posts are filtered before signal creation;
classifications persisted and visible in the Signal Log.

---

## Phase 8 — Event-driven political market calendar (feature #9)

### Task 8.1 — Events table + collectors

**Files:** new `server/sources/eventsCollector.js`, `server/db.js`

```sql
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,   -- 'hearing'|'bill-action'|'lobbying-deadline'|'earnings'|'election'
  event_date TEXT NOT NULL,
  title TEXT NOT NULL,
  source_url TEXT,
  committee_id TEXT,
  sectors TEXT,               -- JSON
  related_tickers TEXT,       -- JSON, derived: tickers in those sectors traded by Congress in last 90d
  dedup_key TEXT UNIQUE
);
```

Collectors (daily cron, each independently skippable):
- **Hearings:** congress.gov `/v3/committee-meeting` — upcoming meetings for
  committees our tracked politicians sit on; sectors via the committee map.
- **Bill actions:** upcoming/recent actions on bills already in the `bills` table.
- **Lobbying deadlines:** static quarterly LDA deadlines (Jan/Apr/Jul/Oct 20) —
  generate rows a year ahead.
- **Elections:** a static JSON file `server/lib/electionDates.json` you populate with
  known federal election/primary dates (maintained manually).
- **Earnings:** v1 = skip (no reliable free source); leave the type in the enum and
  note it as future work.

### Task 8.2 — Calendar API + UI

**Files:** `server/index.js`, new `client/src/views/Calendar.jsx`

`GET /api/intel/events?from=&to=&sector=`. UI: month-grid or grouped-by-week list of
upcoming events; each event shows type badge, related sectors/tickers, and links to
any recent congress trades in those tickers (click-through to the Trades feed
filtered). Chronological list grouped by week is acceptable for v1 — don't
over-invest in calendar widgets.

**Phase 8 definition of done:** events populate from live collectors + static data;
calendar view links events → sectors → recent trades.

---

## Phase 9 — Strategy builder (feature #5) + manual approval mode

### Task 9.1 — Strategy schema + engine

**Files:** new `server/intel/strategyEngine.js`, `server/db.js`, tests

```sql
CREATE TABLE IF NOT EXISTS strategies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  definition TEXT NOT NULL,     -- JSON DSL below
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
```

Strategy DSL (validate hard on save; reject unknown keys):

```json
{
  "source": "congress",
  "filters": {
    "direction": "buy",
    "minCopyScore": 80,
    "minConfidence": 0.6,
    "maxDisclosureLagDays": 10,
    "maxDriftPct": 3,
    "minClusterCount": null,
    "minRelevanceScore": null,
    "politicians": [],
    "excludePoliticians": [],
    "sectors": [],
    "excludeWarnings": ["stale-filing", "illiquid"],
    "minAmountMid": null,
    "minEdgeScore": null
  },
  "action": {
    "mode": "manual",
    "fund": "paper",
    "notionalUsd": 500
  }
}
```

`action.mode`: `"watch"` (record a match, alert only) | `"paper"` (signal routed to a
dry-run/paper fund) | `"manual"` (create a pending approval, Task 9.2) | `"auto"`
(create a signal for live processing — Phase 10 gates this further).

`evaluateStrategies(trade, score)` → array of `{strategyId, matched, failedFilters: []}`.
Pure function over the trade + score + ctx; test every filter individually plus
combinations. Record every evaluation in:

```sql
CREATE TABLE IF NOT EXISTS strategy_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL REFERENCES strategies(id),
  trade_key TEXT NOT NULL,
  matched INTEGER NOT NULL,
  failed_filters TEXT,          -- JSON, why it didn't match (explainability)
  outcome TEXT,                 -- 'watch'|'signal-created'|'pending-approval'|'skipped-review-queue'
  signal_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Task 9.2 — Manual approval queue

**Files:** `server/db.js`, `server/index.js`, new `client/src/views/Approvals.jsx`, `server/notifier.js`

```sql
CREATE TABLE IF NOT EXISTS pending_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER REFERENCES strategies(id),
  trade_key TEXT NOT NULL,
  proposed TEXT NOT NULL,       -- JSON {ticker, direction, notionalUsd, fund}
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'approved'|'rejected'|'expired'
  expires_at TEXT NOT NULL,     -- created + APPROVAL_TTL_HOURS (env, default 24)
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`POST /api/approvals/:id/approve` creates the TradeSignal (rationale includes strategy
name + score + card summary) and runs it through the normal `processSignal` — **risk
manager still has final say**. `POST /api/approvals/:id/reject`. A sweep in the
strategy engine expires stale rows. Notify (macOS/Discord) on new pending approvals.
Approvals view: pending cards with the thesis card inline and Approve/Reject buttons.

### Task 9.3 — Pipeline integration + strategy CRUD UI

**Files:** `server/sources/congressPoller.js`, `server/config.js`, `server/index.js`, new `client/src/views/Strategies.jsx`

New env `SIGNAL_ROUTING=legacy|strategies` (default `legacy`). In `strategies` mode
the poller's per-trade flow becomes: upsert → quality → score → **strategy engine**
(instead of unconditional signal creation). Trades in the review queue
(`parse_confidence < 0.8`) can only produce `watch` outcomes regardless of mode.
`legacy` mode keeps today's behavior byte-for-byte.

CRUD endpoints (`GET/POST/PUT/DELETE /api/strategies`) with DSL validation, plus
`POST /api/strategies/:id/backtest` — reuse the Phase 2 backtester: filter historical
archive trades through the strategy's filters (recompute historical scores from stored
factors where possible; document that drift/cluster factors use as-of-now data as a
limitation), simulate with `entryBasis: 'disclosure'`, persist as kind `'strategy'`.

Strategies view: list, enable/disable toggle, a form editor for the DSL fields
(dropdowns/inputs, not raw JSON), "Backtest this strategy" button, and per-strategy
match history from `strategy_matches`.

Ship three seed strategies (inserted if the table is empty, all `enabled: 0`):
"Fresh high-conviction buys" (score ≥ 80, lag ≤ 10d, manual), "Committee edge"
(relevance ≥ 50, score ≥ 65, watch), "Cluster accumulation" (cluster ≥ 3, watch).

**Phase 9 definition of done:** strategies CRUD + validation; engine evaluates every
new trade and records why matches failed; manual approval round-trip works end to end
in dry-run; strategy backtests run from the UI; legacy mode untouched.

---

## Phase 10 — Auto-trading guardrails + audit trail (feature #10)

### Task 10.1 — New risk checks

**Files:** `server/riskManager.js`, `server/config.js`, `funds.example.json`, docs, tests

Add per-fund config options (all optional; absent = check skipped, preserving current
behavior):

| funds.json key | Check inserted into the existing ordered list |
|---|---|
| `maxSectorExposurePct` | after exposure caps: sum of position market values in the ticker's sector (via `ticker_meta`) ÷ equity must stay under the cap after this buy |
| `minAvgDollarVolume` | reject buys in tickers under this ADV (uses `marketData.avgDollarVolume`) |
| `cooldownMinutes` | reject if this fund traded this ticker within the window (query `orders`) |
| `maxTradesPerDay` | reject when the fund's approved-order count for the ET day is reached |
| `blockOptions` (default true) | reject signals whose source trade `is_option` |
| `minCopyScoreAuto` | for signals originating from an `auto`-mode strategy only: reject below this score |

Also hard-code: signals from `auto` strategies whose trade sits unresolved in
`review_queue` are rejected with reason `pending-human-review`. Keep the check order
documented in FUNCTIONALITY.md. Unit-test each check with a mocked fund/positions
context (refactor checks into small pure functions if needed for testability —
without changing behavior of existing ones).

### Task 10.2 — Full audit-chain endpoint + UI

**Files:** `server/index.js`, `client/src/views/SignalLog.jsx`

`GET /api/audit/order/:orderId` and `GET /api/audit/signal/:signalId` → the complete
chain as one JSON document: source trade row (+ quality flags, source URL) → score
(factors + warnings) → strategy match (which filters passed) → approval record (who/
when, for manual mode) → signal → per-fund decision (every check result) → order →
fills. To capture per-check results, extend `insertDecision` with a `checks` JSON
column (migration) that `processSignal` fills with `[{check, pass, detail}]` for every
check it ran. Signal Log rows get an "Audit" button rendering the chain as a vertical
timeline. **This closes the loop on "which rule fired, which data supported it, what
risk checks passed."**

**Phase 10 definition of done:** all new checks tested and configurable per fund;
every decision stores its full check list; audit timeline renders for any order.

---

## Phase 11 — Intelligence dashboards (feature #12) + watchlists & alerts (feature #13)

### Task 11.1 — Aggregate dashboards

**Files:** new `server/intel/aggregates.js`, `server/index.js`, new `client/src/views/Intel.jsx`

One "Intel" view with tabs, each backed by one SQL-aggregate endpoint under
`GET /api/intel/agg/...`:

1. **Most bought/sold** — by ticker, last 30/90d: buy count, sell count, distinct
   politicians, net sentiment, avg copy score.
2. **Sector heatmap** — buys minus sells per sector per week (Recharts heatmap or a
   colored grid table).
3. **Committee heatmap** — committee × sector trade counts (via memberships join).
4. **Politically exposed stocks** — tickers ranked by composite: recent trades +
   lobbying filings + contracts + relevance (a "conflict-risk index" column).
5. **Disclosure quality** — the Phase 1 filing-speed leaderboard, moved/embedded here.
6. **Copy performance** — realized results of `disclosure`-basis backtests and (once
   live) `strategy_matches` outcomes vs SPY.

### Task 11.2 — Watchlists

**Files:** `server/db.js`, `server/index.js`, client

```sql
CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,       -- 'ticker' | 'politician' | 'sector' | 'committee'
  value TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, value)
);
```

CRUD endpoints + "add to watchlist" buttons on trades, politicians, and sectors
throughout the UI. Watchlist panel on the main Dashboard showing latest activity
(trades, events, posts) touching watched items.

### Task 11.3 — Alert rules engine

**Files:** new `server/intel/alertEngine.js`, `server/db.js`, `server/notifier.js`, client settings section

```sql
CREATE TABLE IF NOT EXISTS alert_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_type TEXT NOT NULL,  -- 'high-score-trade'|'watchlist-activity'|'cluster'|'committee-relevant'|'stale-warning'|'strategy-match'|'tweet-catalyst'
  params TEXT NOT NULL,     -- JSON e.g. {"minScore": 85} or {"clusterCount": 3, "windowDays": 14}
  channel TEXT NOT NULL DEFAULT 'all',   -- 'macos'|'discord'|'all'
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS alerts_sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER REFERENCES alert_rules(id),
  dedup_key TEXT UNIQUE,    -- rule + subject, prevents re-alerting
  message TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Hook evaluation into the natural moments: after scoring a new trade, after a strategy
match, after a post classification, after the events collector runs. **Every alert
message must state the why**, built from the same detail strings as the thesis card —
e.g. `"[92/100] Sen. Y bought LMT ($100k–$250k), disclosed in 6 days, sits on Armed
Services, 3rd defense buy this month. Recommendation: copy-candidate."` Route through
the existing `notifier.js` (respect its throttling patterns). Alert-rule management UI
in a settings section; also an in-app alert feed endpoint + panel.

**Phase 11 definition of done:** all six dashboard tabs render from live data;
watchlists work across entity kinds; alerts fire with explanatory messages and never
duplicate (dedup_key).

---

## Phase 12 — Compliance posture + polish (feature #15)

### Task 12.1 — Mode ladder enforcement

**Files:** `server/config.js`, `server/index.js`, docs

Codify the ladder **research → paper → manual → semi-auto** in config validation:
strategies with `action.mode: "auto"` are refused at save time unless the target fund
has `"allowAutoStrategies": true` in `funds.json` AND global `TRADING_MODE=live`.
Startup logs a one-line posture summary per fund ("fund X: live, auto-strategies
enabled, 3 active strategies"). `GET /api/posture` returns the same for the UI status
bar.

### Task 12.2 — Disclaimers + docs overhaul

**Files:** `client/src/App.jsx` (footer), `README.md`, `docs/CAVEATS.md`, all docs

Persistent UI footer: "Research tool. Not investment advice. Congressional disclosure
data is delayed 30–45+ days and may contain errors." Expand CAVEATS.md with sections
on: score limitations (backward-looking, survivorship in politician stats), the
fantasy-vs-realistic backtest distinction, data-source reliability, and a plain-English
note that offering this to *other people* (recommendations/execution for third
parties) would raise regulatory obligations (RIA registration territory) — it is built
for personal use. Do a final pass so README/API/CONFIGURATION/FUNCTIONALITY fully
describe everything added by Phases 0–11.

### Task 12.3 — End-to-end smoke test script

**Files:** new `scripts/smoke.js`

A script (run manually, needs keys) that: ingests recent trades → verifies quality
fields → scores them → builds one thesis card → evaluates seed strategies → creates a
manual approval in dry-run → approves it via the API → verifies the audit chain
endpoint returns the complete document. Prints PASS/FAIL per step. This validates the
whole intelligence pipeline wiring in one command.

---

## Dependency map (execute top to bottom)

```
Phase 0 (archive, prices, ticker meta)
  ├─► Phase 1 (quality + freshness)
  │       ├─► Phase 2 (backtest modes)  ──► Phase 3 (alpha profiles)
  │       │                                     │
  │       └────────────┬────────────────────────┘
  │                    ▼
  │              Phase 4 (copy score) ──► Phase 5 (thesis cards)
  │                    │                        ▲
  ├─► Phase 6 (graph/relevance) ────────────────┘ (6.5 re-weights the score)
  │
  ├─► Phase 7 (sentiment relevance)   [independent after Phase 0]
  ├─► Phase 8 (calendar)              [needs 6.1–6.3 tables]
  │
  Phase 4+5 ──► Phase 9 (strategies + approvals) ──► Phase 10 (guardrails + audit)
                                     │
  Phases 1,3,4,6,7,8 ──► Phase 11 (dashboards, watchlists, alerts)
                                     │
                              Phase 12 (compliance + smoke test)
```

Phases 7 and 8 can be reordered or deferred without blocking anything else.

## What NOT to build (v1 scope guards)

- No shorting, no options execution — options trades are scored and displayed but
  never tradable.
- No force-directed graph visualization — tables and linked lists.
- No multi-user accounts, auth, or hosting changes — this stays a localhost tool.
- No paid data sources beyond the existing optional Quiver key.
- No LLM in the scoring path — LLM is optional polish for thesis cards and the
  existing sentiment classifier only.
- No earnings-calendar scraping in v1.
- No brokerage integrations beyond Alpaca.
