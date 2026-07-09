# API Reference

The dashboard is a plain client of this API — everything it does, you can do with `curl`. Base URL: `http://localhost:3000` (localhost only, no authentication).

## Status & control

### `GET /api/status`

Live snapshot: global mode plus one entry per enabled fund.

```json
{
  "tradingMode": "dry_run",
  "globallyHalted": false,
  "funds": [
    {
      "name": "default", "paper": true,
      "sources": ["congress", "sentiment"],
      "risk": { "maxTradeNotionalUsd": 100, "...": "..." },
      "sentimentConfidenceThreshold": 0.8,
      "autoExit": null,
      "halted": false, "haltReason": null, "killSwitchEvent": null,
      "dailyPnl": { "trade_date": "2026-07-08", "fund": "default", "realized_pnl": -12.5, "equity_open": 100012.5 },
      "equity": 100000, "buyingPower": 200000,
      "positions": [ { "symbol": "AAPL", "qty": 0.5, "marketValue": 105.2, "unrealizedPl": 1.1, "avgEntry": 208.2 } ]
    }
  ]
}
```

A fund whose Alpaca account is unreachable gets an `error` field instead of account data; the endpoint itself still returns 200.

### `POST /api/halt`

Engages a kill switch: records a kill-switch event and cancels that fund's open Alpaca orders. Body: `{ "fund": "name", "reason": "why" }` — omit `fund` to halt **all** funds.

```bash
curl -X POST localhost:3000/api/halt -H 'Content-Type: application/json' -d '{"fund":"real","reason":"stepping away"}'
```

### `POST /api/resume`

Body: `{ "fund": "name" }` resets that fund's kill-switch events; omit `fund` to reset **all** funds *and* remove the global `HALT` file. Think before calling it.

## Signals

### `GET /api/signals?limit=100`

The audit log, newest first: each signal joined with its per-fund decisions and orders — a signal routed to N funds appears as N rows, each with a `fund` field. `limit` defaults to 100 (Signal Log view uses 500).

### `POST /api/test-signal`

Fires a manual signal through the **real** pipeline — same checks, same mode gating. In `live` mode this can place a real order.

Body: `{ "ticker": "AAPL", "direction": "buy", "source": "congress", "confidence": 0.99, "fund": "dry-run" }` (only `ticker` required; direction defaults to `buy`; omit `fund` to fan out to all subscribed funds).

Response is one outcome per fund evaluated: `[{ "fund": "dry-run", "approved": true, "simulated": true, "notionalUsd": 100, "signalId": 7 }]` — or `[]` when no enabled fund subscribes to the source.

### `GET /api/attribution`

Realized P&L per fund per signal source, FIFO-matched from fills:

```json
{ "series": [ { "fund": "default", "source": "congress", "totalRealizedPnl": 84.1,
                "closedLots": 12, "points": [ { "week": "2026-06-29", "pnl": 12.4, "cumulativePnl": 84.1 } ] } ],
  "totalClosedLots": 12 }
```

## Intelligence layer

### `GET /api/review-queue?status=pending`

Low-quality filings held for human review (parse confidence &lt; 0.8), newest first, each joined with its archived trade and the raw filing JSON. `status` is `pending` (default), `approved`, or `rejected`.

```json
[ { "id": 3, "trade_key": "Jane Doe|ABC|2026-06-01|buy|N/A",
    "reason": "parse_confidence 0.5 < 0.8 (no-amount, unresolved-ticker)",
    "status": "pending", "politician": "Jane Doe", "ticker": "ABC", "type": "buy",
    "parse_confidence": 0.5, "source": "senate-efd",
    "source_url": "https://efdsearch.senate.gov/search/view/ptr/…/",
    "raw": { "…": "the original filing row + _qualityFlags" } } ]
```

### `POST /api/review-queue/:id/resolve`

Body: `{ "status": "approved" | "rejected" }`. Marks a pending item resolved. Returns `{ "id", "status" }`, or 404 if no pending item has that id. (Resolution is currently advisory metadata; the auto-trade/strategy gating it feeds is enforced in later phases.)

### `GET /api/intel/filing-speed?minTrades=3`

Per-politician disclosure-speed stats over the archive, fastest median first. `minTrades` (default 3) drops thinly-traded members.

```json
[ { "politician": "Sheldon Whitehouse", "tradeCount": 7, "medianLagDays": 13,
    "pctWithin15": 71.4, "pctWithin30": 100, "pctWithin45": 100 } ]
```

### `GET /api/intel/politicians?limit=500`

Persisted politician alpha stats, sorted by known `edge_score` first. Run `POST /api/intel/refresh-stats` to populate or refresh the table.

```json
[
  {
    "politician": "Jane Doe",
    "as_of": "2026-07-09",
    "trade_count": 42,
    "buy_count": 30,
    "median_disclosure_lag": 18,
    "win_rate_30d": 56.7,
    "avg_return_90d": 4.2,
    "best_hold_window": "90d",
    "edge_score": 74.5
  }
]
```

### `GET /api/intel/politicians/:name`

Full stats row plus the politician's 50 most recent archived trades. `:name` must be URL-encoded.

### `POST /api/intel/refresh-stats`

Recomputes all politician stats from `congress_trades`, using cached market-data helpers where possible. This can take minutes on a large archive and is also scheduled daily at 06:00 America/New_York.

```json
{ "refreshed": 120, "asOf": "2026-07-09" }
```

### `GET /api/intel/drift/:tradeKey`

"Has this trade already moved?" — percent price change since the transaction and disclosure dates for the trade's ticker. The `tradeKey` (which contains `|` and spaces) must be **URL-encoded**. Either field is `null` when price data is unavailable; 404 if the key is unknown.

```json
{ "ticker": "NVDA", "sinceTransactionPct": 3.1, "sinceDisclosurePct": 1.2 }
```

### `POST /api/intel/score/:tradeKey`

Computes or refreshes the deterministic copy-worthiness score for one archived congress trade and persists it in `trade_scores`. Body is optional; `{ "force": true }` recomputes even when the input hash has not changed.

```json
{ "trade_key": "Jane Doe|NVDA|2026-06-20|buy|$50,001 - $100,000",
  "score": 82.4, "confidence": 0.85, "recommendation": "copy-candidate",
  "factors": { "freshness": { "score": 95, "weight": 25, "hasData": true, "detail": "..." } },
  "warnings": [] }
```

### `GET /api/intel/trades?since=&minScore=&recommendation=&politician=&ticker=`

Archive feed joined to persisted scores, newest first. Filters are optional; `recommendation` is one of `copy-candidate`, `watchlist`, `avoid`, or `manual-review`.

```json
[
  { "trade_key": "Jane Doe|NVDA|2026-06-20|buy|$50,001 - $100,000",
    "politician": "Jane Doe", "ticker": "NVDA", "type": "buy",
    "amount_mid": 75000, "score": 82.4, "confidence": 0.85,
    "recommendation": "copy-candidate", "warnings": [] }
]
```

## Backtesting

### `GET /api/politicians`

`[{ "name": "Gary C Peters", "tradeCount": 12 }, ...]` — everyone with disclosed trades in the last year, sorted by activity. **Slow on first call without a Quiver key** (scrapes the Senate eFD site; cached 1 hour after).

### `POST /api/backtests/congress`

```json
{
  "politician": "Gary C Peters",     // required, exact name from /api/politicians
  "startDate": "2025-07-01",         // required, disclosure-date range (YYYY-MM-DD)
  "endDate": "2026-07-01",           // required
  "notionalPerTrade": 1000,          // required, dollars per copied trade
  "exitRule": "follow",              // follow | hold_30 | hold_90 | hold_to_present
  "stopLossPct": 8,                  // optional, exit at -8% (checked bar by bar)
  "takeProfitPct": 20,               // optional, exit at +20%
  "entryBasis": "disclosure"         // disclosure (default) | transaction | first_seen
}
```

`entryBasis` chooses which date becomes the entry: `disclosure` (realistic — first open after the filing, the live system's behavior), `transaction` (**fantasy** upper bound — assumes you knew on the trade date; results echo `entryBasis` and the UI banners it), or `first_seen` (when our poller actually saw it; ≈ disclosure for backfilled rows). The window is always a disclosure-date range, so all bases compare the same set of trades. `results.entryBasis` echoes the choice.

### `POST /api/backtests/congress/compare`

Same body as `/api/backtests/congress` (no `entryBasis`). Runs the params under `transaction` and `disclosure` and returns both, plus the return gap — the fantasy-vs-realistic delta the disclosure lag costs.

```json
{ "transaction": { "id": 8, "results": { "...": "..." } },
  "disclosure":  { "id": 9, "results": { "...": "..." } },
  "gapPct": 4.2 }
```

### `POST /api/backtests/congress-leaderboard`

```json
{
  "startDate": "2026-01-01", "endDate": "2026-07-01",  // required
  "notionalPerTrade": 1000,                              // required
  "exitRule": "hold_90",                                 // default hold_90
  "minTrades": 3,                                        // skip politicians with fewer (default 3)
  "entryBasis": "disclosure"                             // disclosure (default) | transaction | first_seen
}
```

Returns `results.leaderboard`: `[{ politician, trades, skipped, winRate, totalPnl, totalInvested, returnPct }]` ranked by return, plus `politiciansConsidered`.

### `POST /api/backtests/walk-forward`

The overfitting guard. Splits the range into `folds` windows; for each window it ranks politicians in-sample, then copies only that window's top-`topN` into the **next** window and measures out-of-sample return.

```json
{
  "startDate": "2025-01-01", "endDate": "2025-12-31",  // required
  "notionalPerTrade": 1000,                             // required
  "folds": 4,                                           // default 4 (min 2)
  "topN": 5,                                            // default 5
  "exitRule": "hold_90",                                // default hold_90
  "minTrades": 3,                                       // default 3
  "entryBasis": "disclosure"                            // default disclosure
}
```

Returns `results.foldResults` (per fold: train/test windows, top politicians, out-of-sample summary, SPY) and `results.aggregate` (combined out-of-sample `summary`, `curve`, and SPY `benchmark`). Persisted with `kind: 'walk-forward'`.

### `POST /api/backtests/walk-forward`

```json
{
  "startDate": "2025-01-01",         // required, disclosure-date range
  "endDate": "2026-01-01",           // required
  "notionalPerTrade": 1000,          // required
  "folds": 4,                        // default 4, minimum 2
  "topN": 5,                         // copy top N from each in-sample fold into the next fold
  "exitRule": "hold_90",             // default hold_90
  "minTrades": 3,                    // default 3
  "entryBasis": "disclosure"         // disclosure (default) | transaction | first_seen
}
```

Splits the range into contiguous folds, ranks politicians in each fold, then simulates copying only that fold's top-N politicians in the following out-of-sample fold. Results persist with `kind: "walk-forward"` and include `foldResults` plus `aggregate.summary`, `aggregate.curve`, and an SPY `aggregate.benchmark`.

### `POST /api/backtests/tweet`

```json
{
  "startDate": "2026-01-01",         // required (post-date range)
  "endDate": "2026-03-01",           // required
  "notionalPerTrade": 1000,          // required
  "holdDays": 1,                     // daily-bar mode: exit after N days (default 1)
  "holdHours": 3,                    // intraday mode: minute bars, overrides holdDays
  "confidenceThreshold": 0.8,        // default: your SENTIMENT_CONFIDENCE_THRESHOLD
  "maxPosts": 200,                   // cap on Claude calls (default 200, sampled evenly)
  "stopLossPct": 2,                  // optional
  "takeProfitPct": 5                 // optional
}
```

Congress and tweet backtests return the same shape:

```json
{
  "id": 3,
  "params": { "...": "as submitted" },
  "results": {
    "summary": { "totalTrades": 9, "skipped": 1, "wins": 5, "losses": 4,
                 "winRate": 55.6, "totalPnl": 142.7, "totalInvested": 9000, "returnPct": 1.59 },
    "curve": [ { "date": "2026-02-03", "cumulativePnl": 31.2 }, "..." ],
    "benchmark": { "ticker": "SPY", "totalPnl": 88.2, "returnPct": 0.98, "curve": [ "..." ] },
    "trades": [ { "ticker": "T", "entryDate": "2026-07-02", "exitDate": "2026-08-01",
                  "entryPrice": 19.1, "exitPrice": 19.8, "pnl": 36.6, "returnPct": 3.66,
                  "exitReason": "time", "label": "...", "skipped": false }, "..." ]
  }
}
```

Tweet backtests additionally include: `postsInRange`, `postsScanned`, `classifiedPosts`, `noImpactPosts`, `belowThresholdTickers`, `fellBackToDaily`, `archiveCoverage: {from, to}`, a `classifications` array (every post's ticker calls with confidences and whether each traded), and a `warning` string when the range falls outside post-data coverage or classification failed entirely.

### `GET /api/backtests` / `GET /api/backtests/:id`

List past runs (params only) / fetch one with full results. Nothing is recomputed.

## Errors

All endpoints return `{ "error": "message" }` with status 400 (bad input), 404 (not found), or 500 (upstream failure: Alpaca auth, eFD rate limit, Claude API, etc.). Backtest and status errors are also logged to stdout with component context.
