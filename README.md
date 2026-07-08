# Trading Bot

Personal automated trading system with two signal sources feeding one risk-managed execution engine:

1. **Congress copy-trading** — watches politicians' STOCK Act disclosures and copies newly disclosed trades. Note: disclosures legally lag the actual trade by 30–45+ days, so this copies trades *after disclosure*, not in real time.
2. **Trump post sentiment** — polls Truth Social, classifies each new post's market impact with Claude, and trades tickers above a confidence threshold.

Plus:
- **Multiple funds** — each fund is one Alpaca account (paper or live) with its own risk limits, signal routing, kill switch, circuit breaker, and optional auto-exit rules (stop-loss / take-profit / max-hold), so a fake-money fund and a real-money fund run side by side.
- A **backtester** for both strategies — per-politician runs, an all-politicians leaderboard, tweet backtests with full classifier visibility, intraday (minute-bar) simulation, stop-loss/take-profit exits, and a SPY benchmark overlay on every result.
- A **local web dashboard** with per-fund status chips and kill switches, live positions, a realized-P&L-by-source chart, and a full audit log of every decision.
- **Notifications** (macOS + optional Discord) on orders, halts, and failures, and a **launchd installer** to keep the bot running.

> **This is not investment advice. Neither strategy has proven edge — that's what the backtester is for, and past results still don't guarantee future ones. Automated trading can lose real money quickly. Read [docs/CAVEATS.md](docs/CAVEATS.md) before going live.**

## Documentation

| Doc | What's in it |
|---|---|
| [docs/USAGE.md](docs/USAGE.md) | **How to use** — setup, running, every dashboard feature, the recommended path to live trading, emergency stops, maintenance |
| [docs/CAVEATS.md](docs/CAVEATS.md) | **Things to watch out for** — financial/legal risks, operational gotchas, cost control, troubleshooting table |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every `.env` setting, what it defaults to, and what it controls |
| [docs/FUNCTIONALITY.md](docs/FUNCTIONALITY.md) | What every module does — signal pipeline, risk checks in order, data sources, backtest mechanics, database schema |
| [docs/API.md](docs/API.md) | Every HTTP endpoint with request/response examples |

## Quick start

```bash
npm install
npm --prefix client install
cp .env.example .env        # fill in your keys (see below)
npm run build:client
npm start                   # dashboard at http://localhost:3000
```

Keys in `.env`:

| Key | Where to get it | Needed for |
|---|---|---|
| `ALPACA_API_KEY` / `ALPACA_SECRET_KEY` | [alpaca.markets](https://app.alpaca.markets) (create a **paper** account first) | Required — all trading + historical prices |
| `ANTHROPIC_API_KEY` | [platform.claude.com](https://platform.claude.com) | Sentiment classification (optional; that source is disabled without it) |
| `QUIVER_API_KEY` | [api.quiverquant.com](https://api.quiverquant.com) (paid) | Optional — adds House trades + fast historical data. Without it, Senate data is scraped free from the official Senate eFD site |

## Safety model in one paragraph

The bot starts in **`dry_run`** — the full pipeline runs and logs, but orders are only simulated for every fund. Signals fan out to each subscribed fund, where every trade must pass, in order: kill-switch check, per-fund confidence gate, market-hours check, per-fund daily-loss circuit breaker, tradability check, no-shorting rule, exposure caps, and position sizing (smaller of a $ cap and a % of equity) — limits set per fund, nothing hardcoded. A tripped breaker cancels that fund's open orders and blocks its trading until you manually reset it; other funds keep running. Each fund chip has its own kill-switch button, and `touch HALT` stops everything. Every signal — including every rejection and its reason, per fund — is stored in `trading.db`. The recommended ramp to real money is in [docs/USAGE.md](docs/USAGE.md#4-going-live--the-recommended-ramp).

## Architecture

```
sources/congressPoller ─┐    ┌─ sources/truthSocialPoller     ┌─ positionManager.js
 (Quiver or Senate eFD) ▼    ▼   + sentiment/classifier       ▼   (per-fund auto-exits)
                   signal.js (normalized TradeSignal)
                        ▼
                   riskManager.js ── fans out per fund ← config.js (.env + funds.json)
                        ▼                                      → notifier.js (macOS/Discord)
                   alpacaClient.js → one Alpaca connection per fund (paper/live)
                        ▼
                   db.js (SQLite audit trail) ← attribution.js (P&L by source)
                        ▲
     backtest/{simulate,congressBacktest,tweetBacktest}.js (+ leaderboard, SPY benchmark)
                        ▲
                   server/index.js (Express API) → client/ (React dashboard)
```

Runs locally on one machine; designed to move to a cloud VM later without code changes (config via `.env`, state in one SQLite file, server binds localhost).
