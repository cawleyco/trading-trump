# Configuration Reference

Configuration lives in `.env` (copy from `.env.example`) plus an optional `funds.json` for multi-fund setups. Config is loaded **once at startup** — restart the bot after any change. Validation happens at boot: missing required keys or non-numeric values abort startup with a clear error.

## Funds (`funds.json`)

A **fund** is one Alpaca account (key pair) with its own positions, risk limits, signal routing, kill switch, circuit breaker, and optional auto-exit rules. Without `funds.json`, the bot runs a single fund named `default` from the legacy `ALPACA_API_KEY`/`ALPACA_SECRET_KEY`/`ALPACA_PAPER` vars — v1 setups keep working unchanged.

To run multiple funds (e.g. a paper "dry-run" fund taking everything plus a cautious real-money fund taking only congress signals), copy `funds.example.json` to `funds.json`. Secrets stay in `.env`; the file references env-var **names**:

```json
[
  { "name": "dry-run",
    "keyEnv": "ALPACA_PAPER_KEY", "secretEnv": "ALPACA_PAPER_SECRET",
    "paper": true, "enabled": true,
    "sources": ["congress", "sentiment"],
    "risk": { "maxTradeNotionalUsd": 100, "maxDailyLossUsd": 50 },
    "sentimentConfidenceThreshold": 0.8,
    "autoExit": { "stopLossPct": 8, "takeProfitPct": 20, "maxHoldDays": 60 } }
]
```

Per-fund fields:

| Field | Default | Meaning |
|---|---|---|
| `name` | required | Unique id (letters/digits/dash/underscore); shows up in the dashboard, logs, and database |
| `keyEnv` / `secretEnv` | required | Names of the `.env` vars holding this fund's Alpaca keys |
| `paper` | `true` | Which Alpaca endpoint this account is on |
| `enabled` | `true` | Disabled funds are ignored entirely |
| `sources` | all | Which signal sources feed this fund: any of `congress`, `sentiment` |
| `risk` | env defaults | Per-fund risk limits; any omitted field falls back to the `.env` value |
| `sentimentConfidenceThreshold` | env default | This fund's own bar for acting on sentiment signals |
| `autoExit` | off | `{ stopLossPct, takeProfitPct, maxHoldDays }` — automatic position closing (any subset) |

Rules enforced at startup: fund names must be unique, key env vars must resolve, and **two funds must not share a key pair** — the circuit breaker measures whole-account equity, so one Alpaca account = one fund.

`funds.json` is git-ignored. The `HALT` file and `TRADING_MODE=dry_run` remain **global**: dry-run simulates orders for every fund regardless of its keys.

## Mode

| Variable | Default | Meaning |
|---|---|---|
| `TRADING_MODE` | `dry_run` | **Global master switch.** `dry_run`: the full pipeline runs but orders are only simulated for every fund (recorded with status `simulated`, nothing sent to Alpaca). `live`: orders are actually submitted — hitting each fund's paper or real account per its `paper` flag. Any other value aborts startup. |
| `ALPACA_PAPER` | `true` | Single-fund (no `funds.json`) setups only: which endpoint the `default` fund targets. With `funds.json`, each fund's own `paper` field applies instead. |

The combinations (per fund):

| `TRADING_MODE` | fund `paper` | Result |
|---|---|---|
| `dry_run` | `true` | Simulation only (default, safest) |
| `dry_run` | `false` | Simulation only — but status/positions read from the real account |
| `live` | `true` | Real orders against fake money (recommended rehearsal) |
| `live` | `false` | **Real orders, real money** — a warning is logged at startup for each such fund |

## API keys

| Variable | Required? | Used for |
|---|---|---|
| `ALPACA_API_KEY` / `ALPACA_SECRET_KEY` | **Yes** (startup fails without them) | Orders, account/positions, market clock, historical price bars |
| `ANTHROPIC_API_KEY` | No | Claude sentiment classification. If empty, the sentiment source logs a warning and never emits signals; tweet backtests produce zero trades. |
| `QUIVER_API_KEY` | No | Congress trade data (House + Senate, fast). If empty, the bot scrapes the official Senate eFD site instead (free, Senate only, slower for historical ranges). |
| `SEC_CONTACT_EMAIL` | No | Contact email included in the User-Agent of SEC EDGAR requests (ticker → company/CIK/sector metadata). SEC asks automated clients to identify themselves; the data is free and needs no key. |

## Risk limits (the safety rails)

These `.env` values are the **defaults for every fund**; any fund can override any of them in its `risk` block in `funds.json`.

| Variable | Default | Meaning |
|---|---|---|
| `MAX_TRADE_NOTIONAL_USD` | `100` | Hard dollar cap per trade. |
| `MAX_TRADE_PCT_EQUITY` | `2` | Cap per trade as % of the fund's account equity. **The smaller of this and the dollar cap wins.** |
| `MAX_OPEN_POSITIONS` | `10` | New buys are rejected once the fund holds this many positions. |
| `MAX_TOTAL_EXPOSURE_USD` | `1000` | New buys are rejected once the fund's summed position value reaches this. |
| `MAX_DAILY_LOSS_USD` | `50` | Per-fund circuit breaker: trips when the fund's daily loss (vs. its equity at day start, US/Eastern) exceeds this… |
| `MAX_DAILY_LOSS_PCT` | `2` | …or this % of day-start equity, whichever comes first. Tripping cancels that fund's open orders, blocks its trading, and requires manual reset from the dashboard. Other funds are unaffected. |

Sell-signal sizing is special: a sell closes up to the whole existing position (never more than you hold, and never opens a short). Auto-exit sells always close the full position.

## Signal thresholds

| Variable | Default | Meaning |
|---|---|---|
| `SENTIMENT_CONFIDENCE_THRESHOLD` | `0.8` | Claude assigns each ticker a 0–1 confidence; a fund only acts on calls at/above its threshold (this value unless the fund overrides it). Also the default for tweet backtests, where it can be set per run. Raise it for fewer, higher-conviction trades. |
| `CONGRESS_MAX_DISCLOSURE_AGE_DAYS` | `3` | Congress disclosures older than this (at the time the poller sees them) are logged and skipped, not traded. Guards against acting on stale filings after downtime. |
| `CONGRESS_MIN_COPY_SCORE` | empty | Optional congress score gate. Empty means disabled and preserves today's behavior. When set, every new congress trade is scored before signal creation; signals below the threshold or recommended `avoid` / `manual-review` are logged and skipped. |
| `SENTIMENT_MAX_POST_AGE_MINUTES` | `15` | Posts older than this when discovered are skipped. Sentiment moves happen fast; a stale post is already priced in. |

## Polling

| Variable | Default | Meaning |
|---|---|---|
| `CONGRESS_POLL_CRON` | `*/20 * * * *` | Cron expression for the congress poll (default: every 20 minutes). Disclosures only update on business days; polling faster gains little. |
| `TRUTH_SOCIAL_POLL_SECONDS` | `30` | Seconds between Truth Social polls. Going much lower increases the chance of being rate-limited or blocked. |
| `TRUTH_SOCIAL_USERNAME` | `realDonaldTrump` | The account to watch. Any public Truth Social account works. |

## Notifications

| Variable | Default | Meaning |
|---|---|---|
| `NOTIFY_MACOS` | `true` | macOS Notification Center alerts on live orders, circuit-breaker trips, manual halts, auto-exits, and poller failures (failures throttled to once/hour per component). |
| `DISCORD_WEBHOOK_URL` | empty | If set, the same alerts are POSTed to this Discord webhook. |

## Misc

| Variable | Default | Meaning |
|---|---|---|
| `SENTIMENT_MODEL` | `claude-haiku-4-5-20251001` | Claude model for classification. Haiku is fast/cheap and sufficient for short-text classification; check current model names/pricing at platform.claude.com before changing. |
| `PORT` | `3000` | Dashboard/API port. The server binds to `127.0.0.1` only — it is not reachable from other machines, which is also why the dashboard has no login. |

## Files the bot manages

| Path | What it is |
|---|---|
| `trading.db` (+ `-wal`, `-shm`) | SQLite database: all signals, per-fund decisions/orders/fills, P&L history, kill-switch events, dedup state (including collected post texts), saved backtests, the congress-trade archive, and ticker metadata. Git-ignored. Schema migrations run automatically at startup. |
| `data-cache/` | On-disk cache of slow-changing raw third-party responses (currently the SEC ticker universe and per-company submissions), each with a TTL. Git-ignored; safe to delete (it refetches). |
| `HALT` | If this file exists in the project root, **all funds** stop trading (global manual override). Git-ignored. |
| `.env` | Your secrets. Git-ignored. Never commit it; never paste it into chats or issues. |
| `funds.json` | Fund definitions (references `.env` var names, no secrets — but git-ignored anyway). |
