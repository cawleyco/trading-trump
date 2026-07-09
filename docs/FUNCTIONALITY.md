# Functionality Reference

What every part of the system does, module by module.

## Signal pipeline (the core loop)

```
signal source → makeTradeSignal() → processSignal() ─┬→ fund A: [checks] → order/rejection
                                                     └→ fund B: [checks] → order/rejection
```

A signal is stored once, then **fans out to every enabled fund subscribed to its source** (per `funds.json`); each fund runs the full check list with its own limits and records its own decision. The pipeline never throws on a rejected signal — rejection is a normal, logged outcome.

### `server/signal.js` — TradeSignal

The single normalized shape both sources emit:

| Field | Meaning |
|---|---|
| `source` | `congress`, `sentiment`, or `auto-exit` |
| `ticker` | Uppercased, validated (letters + dots, e.g. `BRK.B`) |
| `direction` | `buy` or `sell` |
| `confidence` | 0–1 (sentiment only; null for congress) |
| `rationale` | Human-readable "why" for the audit log |
| `rawReference` | The original source payload (filing row / post + classification), stored as JSON |
| `eventTimestamp` | When the underlying event happened (disclosure date / post time) |

Invalid signals (bad ticker, direction, confidence out of range) throw at creation and never reach the risk manager.

### `server/riskManager.js` — the gatekeeper

For each target fund, `processSignal` runs these checks **in order**; the first failure rejects the signal for that fund with that reason:

1. **Halted?** — global `HALT` file or this fund's untripped circuit-breaker event.
2. **Confidence gate** — sentiment signals below the fund's `sentimentConfidenceThreshold` are rejected here (each fund sets its own bar).
3. **Market open?** — checked against Alpaca's market clock. No extended-hours trading.
4. **P&L refresh + re-check** — updates the fund's P&L and trips its breaker if its daily loss limit is breached (which then rejects this signal too).
5. **Tradable?** — the ticker must exist and be tradable on Alpaca (filters foreign listings, OTC, delisted symbols that appear in disclosures).
6. **Sell without position?** — sells only ever close existing long positions. **The bot never shorts.**
7. **Exposure caps** (buys only) — the fund's max open positions and max total dollar exposure.
8. **Optional guardrails** — per-fund `risk` keys in `funds.json`: sector exposure cap, minimum average dollar volume, same-ticker cooldown, max approved orders per ET day, option blocking, unresolved review-queue blocking for auto strategies, and minimum copy score for auto strategies. Missing optional keys are skipped, except `blockOptions` defaults to `true`.
9. **Position sizing** — the smaller of the fund's dollar cap and %-of-equity cap. Sells close up to the full position; auto-exit sells always close the whole position.
10. **Dry-run gate** — if `TRADING_MODE` is not `live`, the order is recorded as `simulated` and nothing is sent. This is the last line before real money moves.

Approved live orders are submitted as **notional market orders** (dollar amount, fractional shares, day time-in-force) through that fund's own Alpaca connection, and fire a notification.

Every decision stores the ordered check list as JSON (`checks` on `decisions`), so the Signal Log audit view can show which rules passed, skipped, or rejected a signal.

`refreshAllFundsPnl()` also runs every 60 seconds independently, so a breaker can trip between signals. Each fund's daily baseline is its account equity at the first observation of each US/Eastern calendar day.

### `server/alpacaClient.js` — broker connections

`createFundClient(fund)` builds one Alpaca connection per fund (account, positions, order submission, cancel-all, and a trade-updates websocket recording that fund's fills). Market data that doesn't depend on an account — clock, asset lookup, quotes, daily and minute bars (IEX feed) — goes through one shared client.

### `server/positionManager.js` — auto-exit

Every 5 minutes during market hours, for each fund with `autoExit` configured: compares every position against its average entry price and age, and when a rule breaches (`stopLossPct` / `takeProfitPct` / `maxHoldDays`) emits an `auto-exit` sell signal targeted at that fund only. It goes through the normal pipeline — respecting kill switches and dry-run — but is exempt from exposure caps (it only ever reduces exposure) and closes the full position. Positions opened outside the bot have no recorded age, so `maxHoldDays` can't apply to them (price-based rules still do).

### `server/notifier.js` — alerts

Best-effort macOS Notification Center (`osascript`) and optional Discord webhook alerts on: live order submitted, circuit-breaker trip, manual halt, auto-exit, and poller failures (throttled to once per hour per component). Notification failures are logged and swallowed — alerting can never break trading.

### `server/attribution.js` — P&L by source

FIFO-matches sell fills against buy fills per fund+ticker and attributes each closed lot's realized P&L to the source of the **entry** signal. Served at `/api/attribution` and charted on the dashboard — the direct answer to "which strategy is making money?". Only fills are counted (dry-run simulated orders have no fills), and sells with no matched buy (positions predating the bot) are ignored.

## Market data & metadata helpers

### `server/marketData.js` — cached price utilities

A reusable price API over the shared Alpaca client, with a 1-hour in-memory cache, used by scoring, profiles, and dashboards. `getDailyCloses(ticker, start, end)`, `priceOn(ticker, date)` (close of the first trading day ≥ date), `latestPrice(ticker)`, `driftSincePct(ticker, sinceDate)` (percent move from then to now), and `avgDollarVolume(ticker, days)` (mean close×volume — a liquidity proxy). **Every function returns `null` on missing data — a bad ticker never throws.** The math is factored into pure helpers (`_computeDrift`, `_computeAdv`, `_firstCloseOnOrAfter`) that are unit-tested offline; the Alpaca client is imported lazily so the helpers don't require broker config.

### `server/sources/tickerMeta.js` — ticker → company/CIK/sector

Resolves ticker symbols to company metadata using free SEC EDGAR data (no key; a contact email in the User-Agent via `SEC_CONTACT_EMAIL`). `refreshTickerUniverse()` downloads the SEC company-tickers file into the `ticker_meta` table (ticker → name/CIK); `ensureTickerUniverse()` runs it in the background at startup when the table is empty or older than 7 days. `getSectorForTicker(ticker)` fetches the company's SEC submissions once, maps its SIC code to one of ~12 coarse sectors (`server/lib/sicSectors.js`), and caches it. `resolveTicker(nameOrTicker)` is the entity-resolution entry point: a manual override map (`server/lib/tickerOverrides.js`) wins, then an exact ticker match, then a company-name `LIKE` match. Raw SEC responses are cached on disk under `data-cache/` with a TTL.

## Intelligence layer (`server/intel/`, `server/lib/filingQuality.js`)

Deterministic, mostly-pure modules layered on the trade archive. Everything under `server/intel/` is I/O-free where possible (callers inject data) so it's unit-testable offline.

### Data quality (`server/lib/filingQuality.js`)

`assessTrade(trade, { resolveTicker })` scores how much to trust a filing. It starts at parse confidence 1.0 and subtracts for each detected problem, recording a flag: missing transaction date (−0.3), unparseable amount band (−0.2), a ticker that won't resolve (−0.3), an option mention with no extractable strike/expiry (−0.2), and a disclosure dated before the transaction (−0.4). It also detects options (type/strike/expiry → `is_option` + `option_detail`) and normalizes the filing's owner to self/spouse/dependent. `archiveTrade()` runs this on every ingested row, storing the confidence, owner, and option fields as columns and the flags inside `raw._qualityFlags`; it also links amended eFD filings to the original via `amendment_of`.

### Human-review queue

Any trade archived below **0.8** parse confidence is queued in `review_queue` at ingest (idempotently) and is intended to be barred from auto-trading / strategy auto modes (enforced in later phases). `GET /api/review-queue` lists pending items joined with the raw filing and its source URL; `POST /api/review-queue/:id/resolve` marks one approved/rejected. The Signal Log view surfaces pending items with an inline filing dump and approve/reject buttons.

### Freshness (`server/intel/freshness.js`, `freshnessReports.js`)

Pure lag math: `disclosureLagDays` (trade → disclosure), `publishLagDays` (trade → when we first saw it), `ageDays` (since first seen), and `freshnessScore` — 0–100, 100 within 5 days of the trade decaying linearly to 0 at 60 days (falling back to the disclosure date when the transaction date is missing). `filingSpeedLeaderboard()` aggregates the archive into per-politician median disclosure lag and % filed within 15/30/45 days (`GET /api/intel/filing-speed`), rendered as a sortable table on the dashboard. `GET /api/intel/drift/:tradeKey` answers "has this already moved?" using the cached market-data helpers.

### Politician alpha profiles (`server/intel/politicianStats.js`)

`buildPoliticianStats` (pure, with injected price/sector lookups) turns a member's archived **buys** (options and parse-confidence &lt; 0.8 excluded) into a tear-sheet row: entry at the disclosure-date close, forward returns at +7/30/90/180 days, win rates, average amount, median disclosure lag, per-sector 30-day returns, ticker concentration (HHI), and a recent (last-12-month) average. `refreshAllPoliticianStats` computes every politician then assigns `edge_score` — the percentile rank of `avg_return_90d` among members with ≥10 measurable 90-day buys; fewer than that leaves `edge_score` **null** (unknown, not average), so "proven good", "proven bad", and "not enough data" stay distinct. Rows persist in `politician_stats`. It runs nightly at 06:00 ET (`node-cron`) and on demand via `POST /api/intel/refresh-stats`; `GET /api/intel/politicians` lists the rows and `GET /api/intel/politicians/:name` returns one profile plus recent trades. Returns rely on the shared `marketData` cache, so a full refresh can take minutes.

### Copy-worthiness scores (`server/intel/copyScore.js`, `scoreRunner.js`)

Every archived congress trade can be scored deterministically into `trade_scores`: 0-100 composite score, 0-1 confidence, recommendation (`copy-candidate` / `watchlist` / `avoid` / `manual-review`), factor breakdown JSON, and warning JSON. Factors are freshness, politician edge, conviction, already-moved drift, political relevance, 30-day same-ticker cluster, and liquidity. `scoreTrade()` gathers the inputs (stats row, market-data drift/ADV, archive cluster counts, graph relevance), hashes them to skip unchanged recomputes, and persists the result. Recent trades rescore nightly at 06:30 ET; `POST /api/intel/score/:tradeKey` scores on demand; `GET /api/intel/trades` serves the archive joined with scores for the Trades view. `CONGRESS_MIN_COPY_SCORE` is an optional disabled-by-default gate: when set, the congress poller scores each new trade before signal creation and skips low-score, `avoid`, or `manual-review` trades.

### Thesis cards (`server/intel/thesisCard.js`, `cardRunner.js`)

Any scored trade renders an explainable **thesis card** — a plain-language brief assembled entirely from the trade row, its score (factor detail strings + warnings), and injected context (drift, cluster/repeat counts, politician stats, and relevance signals). It is fully template-based: no LLM call, so cards are free, instant, and deterministic, and missing data omits a sentence rather than printing "undefined". Sections: *What happened*, *Why it might matter* (repeat buys, clustering, position size, and committee/bill/lobby relevance), *Since then* (drift since trade and since disclosure), *Signal strength* (score, confidence, recommendation, politician edge), *Risks* (disclosure lag, options, and score warnings), and *Suggested action*. `getOrBuildThesisCard()` scores the trade if needed, builds the card, and caches it in `thesis_cards` keyed by the score's `computed_at` so cards rebuild whenever the score changes. `GET /api/intel/card/:tradeKey` serves it (build-on-demand, `?force=true` to rebuild) and the Trades view renders it as the expanded row above the factor breakdown. Setting `THESIS_LLM=true` additionally passes the card to Claude for a 4-sentence analyst-note rewrite (stored as `polished`); it adds no facts and any API error falls back to the deterministic card silently.

### Political knowledge graph (`server/sources/legislators.js`, `congressGov.js`, `lobbying.js`, `contracts.js`, `server/intel/relevance.js`)

The graph is stored in plain SQLite tables, not a graph database. `refreshLegislatorsAndCommittees()` fetches the public unitedstates/congress-legislators YAML files, populates politician identities, committee rows, and committee memberships, then links archived filing names to Bioguide IDs with normalized exact matching, `Last, First` variants, manual overrides, and conservative unique-last-name fallback. `refreshRecentBills()` uses Congress.gov when `CONGRESS_GOV_API_KEY` is configured, while `refreshLobbyingFilings()` and `refreshGovContracts()` query only companies already present in traded ticker metadata. All refreshers log and skip on missing config or source failures.

`computeRelevance(trade)` performs a deterministic two-hop query: trade politician → committees → committee sectors, and ticker → company/sector/activity. It awards points for committee-sector overlap, committee leadership, active bill overlap, recent lobbying, lobbying issue overlap, and recent federal contracts overseen by a relevant committee. The resulting score replaces the former neutral committee stub, adds the `no-political-relevance` warning below 25, and feeds thesis-card explanations. `GET /api/intel/graph/:tradeKey` returns the full context rendered as a Connections panel in the Trades view; politician profiles also show linked committees and related bills.

### Political market calendar (`server/sources/eventsCollector.js`)

The event collector stores upcoming/recent political catalysts in `events`: Congress.gov committee meetings for tracked committees when `CONGRESS_GOV_API_KEY` is configured, bill actions from the existing `bills` table, static Senate LDA quarterly filing deadlines, and manually maintained federal election dates from `server/lib/electionDates.json`. Earnings remain a reserved event type for a future data source. Every event carries sector tags and a derived `related_tickers` list: tickers in those sectors that appeared in Congress trades during the prior 90 days. The collector runs at startup and daily at 05:15 ET; each source skips independently on missing data or config. `GET /api/intel/events` powers the Calendar view, grouped by week with links back to matching recent trades.

## Signal sources

### Congress (`server/sources/congressPoller.js` + `congressData.js` + `senateEfd.js`)

- Runs on `CONGRESS_POLL_CRON` (default every 20 min).
- Data source: **Quiver Quantitative** if `QUIVER_API_KEY` is set (House + Senate); otherwise the **official Senate eFD site** (free, Senate only). The eFD scraper accepts the site's access agreement, pages through the filing index, and parses each electronic Periodic Transaction Report's HTML table. Paper (scanned-PDF) filings are skipped — they aren't machine-readable.
- Each new, unseen trade becomes a signal: politician purchase → `buy`, sale → `sell`.
- **Archive**: every fetched trade (seen or not) is upserted into the `congress_trades` table *before* the dedup check — the full-row historical archive that scoring, profiles, and the backtester read from. `archiveTrade()` (in `congressData.js`) parses the amount band (`server/lib/amountRange.js` → `amount_min/max/mid`) and tags the source. Idempotent by `trade_key`.
- **Dedup**: a key of `politician|ticker|date|type|amount` in the `seen_congress_trades` table ensures each disclosed trade is *traded* exactly once, across restarts. (The archive and the dedup set use the same key but serve different purposes — the archive keeps everything, dedup gates signal creation.)
- **Score gate (optional)**: each new archived row is scored before signal creation. By default the score is advisory only; setting `CONGRESS_MIN_COPY_SCORE` skips signals below the threshold or recommended `avoid` / `manual-review`.
- **Staleness guard**: disclosures older than `CONGRESS_MAX_DISCLOSURE_AGE_DAYS` are skipped.
- **First-run seeding**: the first poll after startup only marks trades as seen, it does not trade them.
- **Backfill**: `npm run backfill [-- --start YYYY-MM-DD --end YYYY-MM-DD]` (`scripts/backfill-congress.js`) populates the archive from historical disclosures (default: 3 years back). Idempotent — re-runs insert 0 new rows. Backfilled rows set `first_seen_at` to the disclosure date as a best-available publish-time estimate; live-poller rows carry a true `first_seen_at`.

### Trump sentiment (`server/sources/truthSocialPoller.js` + `truthSocialData.js` + `sentiment/classifier.js`)

- Polls the configured account's public posts every `TRUTH_SOCIAL_POLL_SECONDS` via Truth Social's unofficial Mastodon-style endpoints. Re-truths (reposts) and empty posts are ignored; HTML is stripped to plain text.
- Each new post goes to Claude with a fixed prompt that returns strict JSON: post-level `relevanceType` (`company`, `sector`, `legislation`, `regulation`, `contracts`, `opinion`, or `none`), `marketRelevance` 0–1, up to 3 ticker calls (`direction`, `confidence`, rationale), sector tags, and a rationale. The prompt is deliberately conservative — most posts should classify as "opinion" or "none".
- The full classification is persisted on `seen_posts.classification`. Only non-`opinion`/`none` posts with `marketRelevance >= SENTIMENT_MIN_RELEVANCE` can emit ticker signals; sector-only classifications are saved for future alerts but do not trade in v1.
- Market-relevant ticker signals include `crossSignal` metadata in `rawReference`: recent congress buys of matching tickers/sectors and committee-sector exposure when graph data is available. `GET /api/intel/cross-signal/:postId` exposes the same context for inspection.
- Every classified ticker becomes a signal; **confidence gating happens per fund** in the risk manager, so different funds can hold different bars for the same call.
- Same dedup (by post ID), staleness guard (`SENTIMENT_MAX_POST_AGE_MINUTES`), and first-run seeding as the congress source. Post texts are stored in `seen_posts`, so everything the bot sees live becomes backtestable later.
- If `ANTHROPIC_API_KEY` is unset or the API errors, the poller logs and skips — it never crashes the bot.

### Influence Signals / YouTube (`server/influence/*`, `server/sources/youtubeApiClient.js`)

Influence Signals is a separate research module for public-source market impact. The YouTube MVP tracks creator channels, syncs official YouTube Data API metadata, accepts compliant manual transcript uploads, segments transcripts, detects asset mentions, classifies them, backtests post-mention returns, calculates creator-alpha profiles, and creates research-only `influence_signal_events`.

The module deliberately does **not** scrape YouTube transcripts and does **not** write into the executable `signals` table. Any future bridge to the live risk/order pipeline is gated behind `YOUTUBE_LIVE_SIGNALS_ENABLED=false` and would require an explicit integration phase.

Key pieces:

- `server/sources/youtubeApiClient.js` uses official metadata endpoints only: channel metadata, uploads playlist videos, and video metadata/statistics.
- `server/influence/transcripts.js` provides the transcript provider registry plus manual/stub providers and plain-text/SRT/VTT segmentation.
- `server/influence/entityResolution.js` and `youtubeMentionDetection.js` detect cashtags, asset aliases, and company/token names with ambiguity filters for terms like apple/SOL.
- `server/influence/youtubeMentionClassifier.js` classifies mentions with structured JSON and stores normalized scores plus raw model output.
- `server/backtest/youtubeBacktest.js` calculates mention returns by horizon and creator-alpha metrics from real Alpaca data: minute bars price the entry and intraday (1h/6h) windows, daily closes price the longer windows, and every result carries a 30-day SPY benchmark. Off-hours mentions enter at the next day's open (intraday windows null); mentions with no price data get null returns and a `noPriceData` flag instead of synthetic prices, and creator-alpha win rates are computed only over measurable mentions.
- `server/influence/youtubeSignals.js` converts high-quality classified mentions into research signal events with careful labels such as `watch`, `avoid`, and `manual_review`.

## Backtesting (`server/backtest/`)

### `simulate.js` — shared simulation core

Takes a list of planned trades and a fixed dollar amount per trade, fetches bars from Alpaca (cached in memory per run), and computes:

- **Entry** at the open of the first trading day **on or after** the event date — or, in intraday mode (`holdHours` + a post timestamp), at the first **minute bar** after the event, with the hold clock starting at actual entry (an off-hours post enters at the next open). Falls back to daily bars with a per-trade flag when minute data is unavailable.
- **Stop-loss / take-profit** (optional): bars are walked from entry; exit fills at the level when crossed intrabar, at the open when the bar gaps past it, and stop-before-target when both hit in one bar (conservative). Otherwise…
- **Exit** at the close of the exit date / end of the hold period, clamped to today.
- Per-trade P&L with exit reason (`time` / `stop-loss` / `take-profit`), aggregate totals, win rate, and a cumulative P&L curve.
- **SPY benchmark**: the same dollar amounts deployed into SPY on the same entry/exit dates, returned as a parallel curve + return % — the "should I have just bought the index?" baseline.
- `direction: 'sell'` trades are simulated as short P&L (price down = profit) — a "what if I'd acted on the bearish call" measure, even though the live bot never shorts.
- Trades with no price data (delisted tickers, dates outside data coverage) are reported as **skipped with a reason** and excluded from totals — never silently filled in.
- **Trading costs** (optional, all default zero so old backtests stay comparable): `slippageBps` worsens every entry and exit fill (mirrored for shorts); `feePerTradeUsd` is a flat per-round-trip cost; `autoSlippage` instead picks a slippage tier per trade from the ticker's average dollar volume (≥$50M → 5bps, $10–50M → 15, $1–10M → 40, &lt;$1M → 100) and records it on the trade row. The cost math (`applyCosts`, `slippageTierBps`) is pure and unit-tested; the SPY benchmark stays cost-free as a clean baseline.

### `congressBacktest.js`

Filters historical disclosures to one politician and a **disclosure-date** range (matching what a live copier could have known), turns their purchases into entries, and applies the chosen exit rule (`follow` their later sale of the same ticker / `hold_30` / `hold_90` / `hold_to_present`), plus optional SL/TP. Data source: the local `congress_trades` **archive** first (populated by the poller + backfill), falling back to a live network fetch (cached in memory for 1 hour) only while the archive has no rows in range. Also powers the politician dropdown (`listPoliticians`) and `runCongressLeaderboard`, which backtests **every** politician with ≥ minTrades in one pass (shared caches) and ranks them by return.

**Entry basis** (`entryBasis`, both single and leaderboard runs): which date becomes the entry — `disclosure` (default, realistic), `transaction` (a **fantasy upper bound** — you can't know before disclosure; results echo it and the UI banners it), or `first_seen` (when the poller actually saw it; ≈ disclosure for backfilled rows). The disclosure-date window is fixed across bases, so they compare the same trades. `runEntryBasisComparison` runs `transaction` vs `disclosure` side by side — the return gap *is* the cost of the disclosure lag.

### `walkForward.js`

The overfitting guard. `runWalkForward` splits the range into `folds` contiguous windows; for each window it ranks politicians in-sample (reusing `rankByReturn`), copies only that window's **top-N** into the *next* window, and measures out-of-sample return. It reports per-fold results plus a combined out-of-sample curve and SPY benchmark, persisted as `kind: 'walk-forward'`. A politician who ranks high in-sample and flops out-of-sample is noise, not edge.

### `tweetBacktest.js`

Merges the public archive of Trump's posts (~15 MB JSON, cached 1 hour) with **posts the bot's own poller has collected** (the archive lags — results include its coverage dates and warn when your range falls outside), samples up to `maxPosts` **evenly across the range**, classifies them with the **same** Claude classifier used live, and simulates every above-threshold ticker (daily `holdDays` or intraday `holdHours`, optional SL/TP). Results include every post's classification with per-ticker confidences and whether it traded — so "no trades" is always explainable — plus scanned/classified/no-impact/below-threshold counts.

All backtest kinds persist params + full results in the `backtests` table for instant reload later. The dashboard also has reusable research presets stored in `backtest_presets`, so common setups can be named, reapplied, and updated without re-entering every parameter.

## Web server & dashboard (`server/index.js`, `client/`)

Express serves the JSON API and the built React app on `127.0.0.1:PORT` (localhost only, no auth). See [API.md](API.md) for every endpoint. The dashboard is plain-JS React + Vite + Recharts with views for Dashboard, Trades, Backtesting, Politicians, and Signal Log plus the always-visible status bar / kill switch. It's a pure API client — anything the dashboard does, you can also do with `curl`.

## Persistence (`server/db.js`)

SQLite (`trading.db`, WAL mode). Tables:

| Table | Contents |
|---|---|
| `signals` | Every signal from any source, with rationale and raw source payload |
| `decisions` | The risk manager's verdict **per signal per fund**: approved/rejected, reason, computed size, and full ordered check results |
| `orders` | Orders per approved decision, tagged with their fund: Alpaca order ID, status (`simulated`/`submitted`/`filled`/`canceled`/`rejected`/`error`) |
| `fills` | Fill events from the per-fund websockets: quantity, average price |
| `daily_pnl` | One row per US/Eastern trading day **per fund**: day P&L and the equity baseline |
| `kill_switch_events` | Every circuit-breaker trip and manual halt per fund, with reason, trip time, and reset time |
| `seen_congress_trades` / `seen_posts` | Dedup state so nothing is traded twice; `seen_posts` also keeps post text, timestamp, and the full sentiment classification JSON for backtests/auditing |
| `congress_trades` | Full-row archive of every disclosed trade the poller/backfill has seen: parties, dates, parsed amount band (`amount_min/max/mid`), source + filing URL, and (later phases) quality/identity fields. The substrate for scoring, profiles, and archive-backed backtests |
| `ticker_meta` | Ticker → company name, SEC CIK, SIC code, and coarse sector; populated from SEC EDGAR, refreshed weekly |
| `review_queue` | Low-confidence filings (parse confidence &lt; 0.8) held for human review, with reason and approved/rejected status |
| `politician_stats` | Per-politician tear-sheet: forward returns by horizon, win rates, sector breakdown, concentration, and `edge_score`; refreshed nightly |
| `trade_scores` | Persisted copy-worthiness score per archived trade: composite score, confidence, recommendation, factor details, warnings, and input hash |
| `politicians` / `committees` / `committee_memberships` | Political identity and committee graph used to link filings to Bioguide IDs and derive committee-sector relevance |
| `bills` / `lobbying_filings` / `gov_contracts` | Recent political/economic activity joined into relevance scoring and graph context panels |
| `events` | Political market calendar rows: hearings, bill actions, lobbying deadlines, elections, sector tags, and related Congress-traded tickers |
| `backtests` | Saved backtest params + results (congress / tweet / leaderboard / walk-forward) |
| `app_modules` | Enabled module registry rows such as `politics`, `influence`, and `youtube` |
| `assets` / `asset_aliases` | Shared asset registry used by Influence Signals mention detection |
| `youtube_channels` / `youtube_channel_snapshots` | Tracked YouTube creators and their subscriber/view/video count snapshots |
| `youtube_videos` / `youtube_video_snapshots` | YouTube video metadata and engagement snapshots from official metadata/manual seed data |
| `content_documents` / `content_segments` | Generic text documents and timestamped transcript chunks |
| `asset_mentions` / `mention_classifications` | Detected asset mentions and normalized classification/quality/pump-risk scores |
| `youtube_backtest_runs` / `youtube_backtest_signal_results` | YouTube mention backtest configs and per-mention horizon returns |
| `creator_alpha_metrics` | Aggregated YouTube creator performance, win rates, pump-dump rate, and alpha labels |
| `influence_signal_events` | Research-only influence signal feed, separate from executable trading signals |
| `market_candles` | Reserved shared candle storage for future persisted market-data providers |

Schema migrations (adding fund columns etc.) run automatically and idempotently at startup — v1 databases upgrade in place, existing rows attributed to fund `default`.

## Logging (`server/logger.js`)

Structured JSON lines to stdout (`ts`, `level`, `component`, `message`, plus context like `signalId`). The database is the durable audit trail; the log is the operational play-by-play. Grep-friendly: `component` is one of `server`, `risk`, `alpaca`, `congress`, `truth-social`, `sentiment`, `senate-efd`, `backtest`, `auto-exit`, `notify`, `market-data`, `ticker-meta`, `politician-stats`, `events`. Per-fund lines are prefixed `[fund-name]`.
