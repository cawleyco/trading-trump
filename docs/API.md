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

### `GET /api/posture`

Mode-ladder compliance posture per fund (Phase 12). `autoStrategiesEffective` is `true` only when the fund opts in (`funds.json "allowAutoStrategies": true`) **and** `TRADING_MODE=live`. The startup log prints the same summary; the UI status bar shows it per fund.

```json
{ "tradingMode": "dry_run",
  "funds": [
    { "name": "default", "account": "paper", "tradingMode": "dry_run",
      "sources": ["congress", "sentiment"],
      "allowAutoStrategies": false, "autoStrategiesEffective": false,
      "activeStrategies": 2 }
  ]
}
```

## Signals

### `GET /api/signals?limit=100`

The audit log, newest first: each signal joined with its per-fund decisions and orders — a signal routed to N funds appears as N rows, each with a `fund` field. `limit` defaults to 100 (Signal Log view uses 500). Rows include `decision_id`, `order_id`, and `checks` (`[{ "check": "tradable", "pass": true, "detail": "..." }]`) when present. Sentiment rows include parsed `sentimentClassification` (`relevanceType`, `marketRelevance`, ticker calls, sectors) and any attached `crossSignal` corroboration.

### `GET /api/audit/signal/:signalId`

Returns the full audit chain for one signal: archived source trade and quality flags when linked, copy score, strategy match, approval record, signal, every per-fund decision with check results, orders, and fills.

### `GET /api/audit/order/:orderId`

Same audit document, looked up by local numeric order id or Alpaca order id.

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

### `POST /api/intel/refresh-graph`

Refreshes the political knowledge graph: legislators/committees, recent Congress.gov bills, Senate LDA lobbying filings for traded companies, and USAspending contracts for traded companies. Missing `CONGRESS_GOV_API_KEY` skips only bill refresh; other sources remain best-effort.

```json
{ "legislators": { "politicians": 535, "committees": 300, "linkedArchiveTrades": 1240 },
  "bills": { "stored": 40 },
  "lobbying": { "stored": 18 },
  "contracts": { "stored": 22 } }
```

### `GET /api/intel/graph/:tradeKey`

Full graph context for an archived trade: linked politician identity, committees, related bills, lobbying filings, and contracts. The `tradeKey` must be URL-encoded.

### `GET /api/intel/cross-signal/:postId`

For a persisted Truth Social post classification, returns recent congress-buy corroboration for the named tickers/sectors and any committee-sector exposure for those politicians. This is display/alerting metadata only and does not affect signal gating.

```json
{ "postId": "123", "targets": { "tickers": ["XLE"], "sectors": ["energy"] },
  "corroboratingTrades": [ { "trade_key": "...", "politician": "Jane Doe", "ticker": "XLE", "score": 78 } ],
  "note": "Found 1 recent congress buy(s) matching XLE / energy." }
```

### `GET /api/intel/politicians/:name/graph`

Committee memberships and recent related bills for a politician profile. `:name` may be a display name or Bioguide ID and must be URL-encoded.

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
  "factors": { "freshness": { "score": 95, "weight": 20, "hasData": true, "detail": "..." } },
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

### `GET /api/intel/events?from=&to=&sector=`

Political market calendar events, chronological: committee hearings, bill actions, lobbying filing deadlines, and elections. Each row includes sector tags, related tickers derived from recent Congress trades in those sectors, and a small `recentTrades` list for click-through context.

```json
[
  { "id": 12, "event_type": "hearing", "event_date": "2026-08-12",
    "title": "Hearing on defense supply chains",
    "source_url": "https://www.congress.gov/...",
    "committee_id": "HSAS",
    "sectors": ["defense-aerospace", "technology"],
    "related_tickers": ["LMT", "RTX"],
    "recentTrades": [
      { "trade_key": "Jane Doe|LMT|2026-07-01|buy|$15,001 - $50,000",
        "politician": "Jane Doe", "ticker": "LMT", "type": "buy",
        "disclosure_date": "2026-07-10" }
    ] }
]
```

### `POST /api/intel/events/refresh`

Runs the event collectors immediately. Body is optional: `{ "from": "2026-07-09", "to": "2026-10-07" }`. Missing `CONGRESS_GOV_API_KEY` skips only hearing collection; static deadlines/elections and bill actions still run.

```json
{ "hearings": { "skipped": true, "reason": "missing CONGRESS_GOV_API_KEY", "stored": 0 },
  "billActions": { "skipped": false, "considered": 8, "stored": 8 },
  "static": { "skipped": false, "stored": 5 } }
```

### `GET /api/intel/card/:tradeKey`

Deterministic, template-based thesis card for one archived trade. Scores the trade first if it has no persisted score, then builds and caches the card in `thesis_cards` (rebuilt automatically when the trade's score is newer). Pass `?force=true` to rebuild unconditionally. `polished` is a Claude-written analyst note, present only when `THESIS_LLM=true` and the call succeeds; it is `null` otherwise (the deterministic card still renders). The path segment contains `|` and spaces — URL-encode it.

```json
{ "trade_key": "Jane Doe|NVDA|2026-06-20|buy|$50,001 - $100,000",
  "score_computed_at": "2026-07-08 06:30:00",
  "polished": null,
  "cached": false,
  "card": {
    "what": "Rep. Jane Doe purchased NVDA ($50k–$100k) on 2026-06-20, disclosed 2026-06-27.",
    "whyItMatters": ["Repeat purchase — 3rd NVDA buy in 90 days.", "3 members traded NVDA the same direction within 30 days."],
    "sinceThen": "NVDA is up 3.1% since the trade date and up 1.2% since disclosure.",
    "signal": { "copyScore": 82, "confidence": 0.86, "recommendation": "copy-candidate", "politicianEdge": "Top-quartile 90-day returns (edge 78/100)." },
    "risks": ["Disclosure lag of 7 days."],
    "suggestedAction": "copy-candidate" }
}
```

## Intelligence dashboards, watchlists & alerts (Phase 11)

### Aggregate dashboards — `GET /api/intel/agg/...`

Read-only aggregates over the archive; each backs one tab of the **Intel** view. All recompute on request.

| Endpoint | Query | Returns |
| --- | --- | --- |
| `GET /api/intel/agg/most-active` | `days` (30), `limit` (25) | Per-ticker buy/sell counts, distinct politicians, net sentiment, avg copy score |
| `GET /api/intel/agg/sector-heatmap` | `days` (90) | Matrix `{ rows: sectors, cols: weeks, cells }` of net buys − sells |
| `GET /api/intel/agg/committee-heatmap` | `days` (180) | Matrix `{ rows: committees, cols: sectors, cells }` of trade counts (needs bioguide + membership links) |
| `GET /api/intel/agg/exposed-stocks` | `days` (180), `limit` (25) | Tickers ranked by a `riskIndex` (0–100) composed of trades + lobbying + contracts |
| `GET /api/intel/agg/disclosure-quality` | `minTrades` (3) | The filing-speed leaderboard, embedded here |
| `GET /api/intel/agg/copy-performance` | `limit` (10) | Disclosure-basis backtest returns vs SPY (`alphaPct`) + a per-strategy match summary |

### Watchlists — `/api/watchlist`

- `GET /api/watchlist?kind=` — all watched items (optionally filtered by `kind`).
- `GET /api/watchlist/activity?limit=25` — recent trades and calendar events touching watched items, each tagged with the matching watch.
- `POST /api/watchlist` — `{ kind, value, note? }`; `kind` ∈ `ticker|politician|sector|committee`. Upserts on `(kind, value)`; tickers are upper-cased.
- `DELETE /api/watchlist/:id` — remove one item.

### Alert rules & feed — `/api/alerts`

- `GET /api/alerts/rules` — `{ rules, ruleTypes, channels }`.
- `POST /api/alerts/rules` — `{ ruleType, params, channel }`. `ruleType` ∈ `high-score-trade | watchlist-activity | cluster | committee-relevant | stale-warning | strategy-match | tweet-catalyst`; `channel` ∈ `macos | discord | all`. `params` is rule-specific JSON, e.g. `{"minScore": 85}` or `{"clusterCount": 3, "windowDays": 30}`.
- `PUT /api/alerts/rules/:id` — patch `{ params?, channel?, enabled? }`.
- `DELETE /api/alerts/rules/:id` — delete a rule (its sent-alert history is detached, not removed).
- `GET /api/alerts/feed?limit=100` — recently fired alerts (deduped by `dedup_key`).

Rules evaluate at natural pipeline moments — a trade is scored, a strategy matches, the events collector runs — and route explanatory, deduplicated messages through `notifier.js`. Every alert states the *why*, built from the same detail strings as the thesis card.

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

## Influence Signals / YouTube

Research-only YouTube creator market-impact endpoints live under `/api/influence/*`. They do not write to the executable `/api/signals` trading pipeline.

### Channels

- `GET /api/influence/youtube/channels`
- `POST /api/influence/youtube/channels`
- `GET /api/influence/youtube/channels/:id`
- `PATCH /api/influence/youtube/channels/:id`
- `POST /api/influence/youtube/channels/:id/sync`
- `GET /api/influence/youtube/channels/:id/videos`
- `GET /api/influence/youtube/channels/:id/mentions`
- `GET /api/influence/youtube/channels/:id/alpha`

Manual channel creation requires `youtube_channel_id` and `title`. Passing `{ "resolveWithApi": true, "input": "@handle" }` resolves metadata through the official YouTube Data API if `YOUTUBE_API_KEY` is configured.

### Videos And Transcripts

- `GET /api/influence/youtube/videos`
- `POST /api/influence/youtube/videos`
- `GET /api/influence/youtube/videos/:id`
- `POST /api/influence/youtube/videos/:id/sync`
- `POST /api/influence/youtube/videos/:id/transcript`
- `POST /api/influence/youtube/videos/:id/analyze`
- `POST /api/influence/youtube/videos/:id/signals`

Transcript upload accepts `{ "rawText": "...", "format": "plain_text" | "srt" | "vtt" }`. The system stores the raw document and timestamped segments. It does not scrape YouTube transcripts.

### Mentions, Backtests, Signals

- `GET /api/influence/youtube/mentions`
- `GET /api/influence/youtube/mentions/:id`
- `PATCH /api/influence/youtube/mentions/:id`
- `POST /api/influence/youtube/mentions/:id/reclassify`
- `GET /api/influence/youtube/mentions/:id/backtest`
- `GET /api/influence/youtube/backtests`
- `POST /api/influence/youtube/backtests`
- `GET /api/influence/youtube/backtests/:id`
- `POST /api/influence/youtube/backtests/:id/run`
- `GET /api/influence/signals?moduleKey=youtube`
- `GET /api/influence/signals/:id`
- `PATCH /api/influence/signals/:id`

Suggested actions are market-intelligence labels only: `watch`, `avoid`, `fade_candidate`, `copy_candidate`, or `manual_review`.

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

### `GET /api/backtest-presets`

Lists saved reusable backtest setups, newest updated first.

```json
[
  {
    "id": 1,
    "name": "Top 5 disclosure walk-forward",
    "kind": "walk-forward",
    "params": {
      "startDate": "2025-01-01",
      "endDate": "2026-01-01",
      "notional": 1000,
      "folds": 4,
      "topN": 5,
      "entryBasis": "disclosure"
    },
    "updated_at": "2026-07-09 12:00:00"
  }
]
```

### `POST /api/backtest-presets`

Creates a named preset. `kind` must be `congress`, `leaderboard`, `walk-forward`, or `tweet`; `params` is the saved dashboard form state.

```json
{
  "name": "Gary Peters 90d realistic",
  "kind": "congress",
  "params": {
    "politician": "Gary C Peters",
    "startDate": "2025-07-01",
    "endDate": "2026-07-01",
    "notional": 1000,
    "exitRule": "hold_90",
    "entryBasis": "disclosure"
  }
}
```

### `PUT /api/backtest-presets/:id`

Updates any subset of `name`, `kind`, or `params`. Returns the updated preset.

### `DELETE /api/backtest-presets/:id`

Deletes a saved preset. Returns `{ "deleted": id }`.

## Errors

All endpoints return `{ "error": "message" }` with status 400 (bad input), 404 (not found), or 500 (upstream failure: Alpaca auth, eFD rate limit, Claude API, etc.). Backtest and status errors are also logged to stdout with component context.
