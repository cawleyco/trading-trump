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
8. **Position sizing** — the smaller of the fund's dollar cap and %-of-equity cap. Sells close up to the full position; auto-exit sells always close the whole position.
9. **Dry-run gate** — if `TRADING_MODE` is not `live`, the order is recorded as `simulated` and nothing is sent. This is the last line before real money moves.

Approved live orders are submitted as **notional market orders** (dollar amount, fractional shares, day time-in-force) through that fund's own Alpaca connection, and fire a notification.

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

## Signal sources

### Congress (`server/sources/congressPoller.js` + `congressData.js` + `senateEfd.js`)

- Runs on `CONGRESS_POLL_CRON` (default every 20 min).
- Data source: **Quiver Quantitative** if `QUIVER_API_KEY` is set (House + Senate); otherwise the **official Senate eFD site** (free, Senate only). The eFD scraper accepts the site's access agreement, pages through the filing index, and parses each electronic Periodic Transaction Report's HTML table. Paper (scanned-PDF) filings are skipped — they aren't machine-readable.
- Each new, unseen trade becomes a signal: politician purchase → `buy`, sale → `sell`.
- **Archive**: every fetched trade (seen or not) is upserted into the `congress_trades` table *before* the dedup check — the full-row historical archive that scoring, profiles, and the backtester read from. `archiveTrade()` (in `congressData.js`) parses the amount band (`server/lib/amountRange.js` → `amount_min/max/mid`) and tags the source. Idempotent by `trade_key`.
- **Dedup**: a key of `politician|ticker|date|type|amount` in the `seen_congress_trades` table ensures each disclosed trade is *traded* exactly once, across restarts. (The archive and the dedup set use the same key but serve different purposes — the archive keeps everything, dedup gates signal creation.)
- **Staleness guard**: disclosures older than `CONGRESS_MAX_DISCLOSURE_AGE_DAYS` are skipped.
- **First-run seeding**: the first poll after startup only marks trades as seen, it does not trade them.
- **Backfill**: `npm run backfill [-- --start YYYY-MM-DD --end YYYY-MM-DD]` (`scripts/backfill-congress.js`) populates the archive from historical disclosures (default: 3 years back). Idempotent — re-runs insert 0 new rows. Backfilled rows set `first_seen_at` to the disclosure date as a best-available publish-time estimate; live-poller rows carry a true `first_seen_at`.

### Trump sentiment (`server/sources/truthSocialPoller.js` + `truthSocialData.js` + `sentiment/classifier.js`)

- Polls the configured account's public posts every `TRUTH_SOCIAL_POLL_SECONDS` via Truth Social's unofficial Mastodon-style endpoints. Re-truths (reposts) and empty posts are ignored; HTML is stripped to plain text.
- Each new post goes to Claude with a fixed prompt that returns strict JSON: up to 3 tickers, each with `direction` (buy = post likely pushes price up, sell = down) and `confidence` 0–1, plus a rationale. The prompt is deliberately conservative — most posts should classify as "no market impact".
- Every classified ticker becomes a signal; **confidence gating happens per fund** in the risk manager, so different funds can hold different bars for the same call.
- Same dedup (by post ID), staleness guard (`SENTIMENT_MAX_POST_AGE_MINUTES`), and first-run seeding as the congress source. Post texts are stored in `seen_posts`, so everything the bot sees live becomes backtestable later.
- If `ANTHROPIC_API_KEY` is unset or the API errors, the poller logs and skips — it never crashes the bot.

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

### `congressBacktest.js`

Filters historical disclosures to one politician and a **disclosure-date** range (matching what a live copier could have known), turns their purchases into entries, and applies the chosen exit rule (`follow` their later sale of the same ticker / `hold_30` / `hold_90` / `hold_to_present`), plus optional SL/TP. Data source: the local `congress_trades` **archive** first (populated by the poller + backfill), falling back to a live network fetch (cached in memory for 1 hour) only while the archive has no rows in range. Also powers the politician dropdown (`listPoliticians`) and `runCongressLeaderboard`, which backtests **every** politician with ≥ minTrades in one pass (shared caches) and ranks them by return.

### `tweetBacktest.js`

Merges the public archive of Trump's posts (~15 MB JSON, cached 1 hour) with **posts the bot's own poller has collected** (the archive lags — results include its coverage dates and warn when your range falls outside), samples up to `maxPosts` **evenly across the range**, classifies them with the **same** Claude classifier used live, and simulates every above-threshold ticker (daily `holdDays` or intraday `holdHours`, optional SL/TP). Results include every post's classification with per-ticker confidences and whether it traded — so "no trades" is always explainable — plus scanned/classified/no-impact/below-threshold counts.

All backtest kinds persist params + full results in the `backtests` table for instant reload later.

## Web server & dashboard (`server/index.js`, `client/`)

Express serves the JSON API and the built React app on `127.0.0.1:PORT` (localhost only, no auth). See [API.md](API.md) for every endpoint. The dashboard is plain-JS React + Vite + Recharts with three views (Dashboard, Backtesting, Signal Log) and the always-visible status bar / kill switch. It's a pure API client — anything the dashboard does, you can also do with `curl`.

## Persistence (`server/db.js`)

SQLite (`trading.db`, WAL mode). Tables:

| Table | Contents |
|---|---|
| `signals` | Every signal from any source, with rationale and raw source payload |
| `decisions` | The risk manager's verdict **per signal per fund**: approved/rejected, reason, computed size |
| `orders` | Orders per approved decision, tagged with their fund: Alpaca order ID, status (`simulated`/`submitted`/`filled`/`canceled`/`rejected`/`error`) |
| `fills` | Fill events from the per-fund websockets: quantity, average price |
| `daily_pnl` | One row per US/Eastern trading day **per fund**: day P&L and the equity baseline |
| `kill_switch_events` | Every circuit-breaker trip and manual halt per fund, with reason, trip time, and reset time |
| `seen_congress_trades` / `seen_posts` | Dedup state so nothing is traded twice; `seen_posts` also keeps post text + timestamp to extend backtest coverage |
| `congress_trades` | Full-row archive of every disclosed trade the poller/backfill has seen: parties, dates, parsed amount band (`amount_min/max/mid`), source + filing URL, and (later phases) quality/identity fields. The substrate for scoring, profiles, and archive-backed backtests |
| `ticker_meta` | Ticker → company name, SEC CIK, SIC code, and coarse sector; populated from SEC EDGAR, refreshed weekly |
| `backtests` | Saved backtest params + results (congress / tweet / leaderboard) |

Schema migrations (adding fund columns etc.) run automatically and idempotently at startup — v1 databases upgrade in place, existing rows attributed to fund `default`.

## Logging (`server/logger.js`)

Structured JSON lines to stdout (`ts`, `level`, `component`, `message`, plus context like `signalId`). The database is the durable audit trail; the log is the operational play-by-play. Grep-friendly: `component` is one of `server`, `risk`, `alpaca`, `congress`, `truth-social`, `sentiment`, `senate-efd`, `backtest`, `auto-exit`, `notify`, `market-data`, `ticker-meta`. Per-fund lines are prefixed `[fund-name]`.
