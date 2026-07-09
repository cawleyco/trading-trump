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
  "takeProfitPct": 20                // optional, exit at +20%
}
```

### `POST /api/backtests/congress-leaderboard`

```json
{
  "startDate": "2026-01-01", "endDate": "2026-07-01",  // required
  "notionalPerTrade": 1000,                              // required
  "exitRule": "hold_90",                                 // default hold_90
  "minTrades": 3                                         // skip politicians with fewer (default 3)
}
```

Returns `results.leaderboard`: `[{ politician, trades, skipped, winRate, totalPnl, totalInvested, returnPct }]` ranked by return, plus `politiciansConsidered`.

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
