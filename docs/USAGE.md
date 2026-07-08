# How to Use

This is the full operating manual. For a quick start, see the [README](../README.md).

## 1. First-time setup

```bash
npm install                 # backend dependencies
npm --prefix client install # dashboard dependencies
cp .env.example .env        # then edit .env with your keys
npm run build:client        # build the dashboard once
```

Fill in `.env`:

- **Alpaca** — create an account at [app.alpaca.markets](https://app.alpaca.markets). Generate API keys for the **paper** account first (top-right account switcher → Paper). Put them in `ALPACA_API_KEY` / `ALPACA_SECRET_KEY` and keep `ALPACA_PAPER=true`.
- **Anthropic** — create a key at [platform.claude.com](https://platform.claude.com). Without it, the Trump sentiment source and tweet backtests are disabled (the bot logs a warning and skips them); everything else still works.
- **Quiver (optional)** — a paid key from [api.quiverquant.com](https://api.quiverquant.com) adds House trades and much faster historical congress data. Without it, the bot scrapes the official Senate eFD site for free (Senate only).

The server **fails fast at startup** if the Alpaca keys are missing. Placeholder values like `REPLACE_ME` will start the server but every Alpaca call will fail with 401 until you use real keys.

## 2. Running

```bash
npm start
```

Then open **http://localhost:3000**.

On startup the log prints a loud banner with the trading mode — check it every time:

```
TRADING MODE: DRY_RUN (no live orders)
Alpaca endpoint: PAPER
```

What starts automatically:

| Component | Schedule | What it does |
|---|---|---|
| Congress poller | every 20 min (cron, configurable) | Fetches newly disclosed congress trades, emits signals |
| Truth Social poller | every 30 s (configurable) | Fetches new posts, classifies with Claude, emits signals (post texts are kept, extending the backtestable history forward) |
| P&L refresher | every 60 s | Updates each fund's daily P&L, trips its circuit breaker if its loss limit is hit |
| Position manager | every 5 min (market hours) | Auto-exits positions per each fund's stop-loss / take-profit / max-hold rules (if configured) |
| Fill streams | one websocket per fund | Records order fills from Alpaca into the database |

Signals fan out to every enabled fund subscribed to their source; each fund applies its own limits and threshold and records its own decision.

**First-run seeding:** on the very first poll after startup, both pollers mark all currently-visible disclosures/posts as "seen" WITHOUT trading them. This prevents the bot from firing a burst of orders for old events every time it restarts. Only events that appear *after* startup generate signals.

To stop the bot: `Ctrl-C` (or kill the process). State survives restarts — the seen-lists, signals, orders, and backtests are all in `trading.db`.

## 3. The dashboard

### Status bar (always visible, refreshes every 10 s)

- **Mode banner**: 🟢 DRY RUN / 🔴 LIVE MODE, plus a global-halt warning if the `HALT` file exists.
- **One chip per fund**: 🧪 paper / 💵 live, its sources, equity, day P&L, position count — and its own **KILL button**. Killing a fund halts it and cancels its open orders without touching other funds; the chip then shows **Reset & Resume**. Halting is deliberately easy, resuming deliberately requires intent.

### Dashboard view

- **Fund selector** (when you have more than one) — positions, limits, and the pipeline test all apply to the selected fund.
- **Open Positions** — live from that fund's Alpaca account with unrealized P&L.
- **Limits** — the fund's effective risk limits, sources, sentiment threshold, and auto-exit rules, so you can confirm what the bot thinks its caps are.
- **Pipeline Test** — fires a manual buy signal at the selected fund through the *real* risk pipeline. In dry-run it simulates; in live mode it places a real order, so treat it accordingly.
- **Realized P&L by source** — cumulative realized P&L from closed positions, attributed to the signal source that opened them (per fund). This chart answers "is congress-copying or sentiment actually making me money?" It appears once positions have been closed.
- **Recent Signals** — the last signals with per-fund decision (✅/❌), order status, and reasoning.

### Backtesting view

Three strategies, one form:

**Copy a politician**
- *Politician* — dropdown listing everyone with disclosed trades in the selected period (with their trade counts). Without a Quiver key this list comes from the Senate eFD site and can take a couple of minutes to load the first time; it's cached for 1 hour after that.
- *Exit rule*:
  - `Follow their sells` — exit a position when that politician later discloses selling the same ticker; if they never do, hold to today.
  - `Hold 30/90 days` — fixed holding period.
  - `Hold to present` — never exit.
- *From/To* — filters by **disclosure date** (when the filing became public), not the original trade date. This matches what a live copier could actually have done.
- *$ per trade* — fixed dollar amount per copied trade.

**All-politicians leaderboard**
Backtests **every** politician with at least *min trades* in the period and ranks them by return — use this to discover who's worth copying instead of guessing, then click "Full backtest" on a row to drill in. Can take a while (one price series per traded ticker).

**Trump post sentiment**
- *Hold for* — how long each simulated position is held: **days** (daily bars) or **hours** (minute bars, entering right after the post — more realistic for sentiment moves; trades fall back to daily bars with a note when minute data is unavailable).
- *Max posts* — hard cap on how many posts get classified. **Each post is one Claude API call**, so this is your cost control. Posts are sampled **evenly across the whole date range** (the summary shows "sampled X of Y in range").
- *Confidence ≥* — the threshold for turning a classifier call into a simulated trade. Start around 0.5 to see what the classifier finds, then tighten.
- Historical posts come from a public archive **plus every post the bot itself has collected while running** — the archive can lag by weeks/months (the results warn you when your range falls outside coverage), so a long-running bot steadily extends its own backtestable history.

**Stop-loss % / Take-profit %** (all except leaderboard) — optional exit levels checked bar by bar: exit at the level when crossed intrabar, at the open when the price gaps past it, and stop-before-target when both hit in the same bar (conservative).

**Results** show total P&L, win rate, a cumulative P&L chart with a **SPY benchmark overlay** (the same dollars deployed into SPY on the same dates — the honest "should I have just bought the index?" line), an expandable per-trade table (entry/exit, prices, P&L, exit reason), and for tweet backtests an expandable **"What the classifier said"** table showing every post's ticker calls with confidences — near-misses below your threshold are highlighted, so an empty result is always explainable. Trades that couldn't be simulated are listed as "skipped" with the reason — excluded from totals rather than silently guessed.

Every backtest is saved; the **Past Backtests** table reloads any previous run instantly without recomputing.

### Signal Log view

The complete audit trail: every signal the bot ever generated — including rejected ones — with the risk manager's exact reasoning ("market is closed", "max open positions reached", "no open position to sell", …). If you ever wonder "why didn't it trade X" or "why did it trade Y", the answer is here.

## 4. Going live — the recommended ramp

1. **Dry run + paper keys** (the default). Let it run a few days. Read the Signal Log daily.
2. **Backtest**: run the leaderboard to find politicians worth copying, drill into them, and compare against the SPY benchmark line. If a strategy trails SPY, copying it live buys you risk for nothing.
3. **`TRADING_MODE=live`** with your paper fund only — real order flow against fake money. This exercises everything except actual risk. Run this at least a week.
4. **Add a real fund**: create `funds.json` with your paper fund plus a live-account fund (`"paper": false`) with tight limits and only the sources that backtested well; add its keys to `.env`. Keep the paper fund running alongside — it's your control group, and the P&L-by-source chart shows you per-fund, per-source results.

At each step, restart the bot after config edits (config is read once at startup) and check the startup banner — it lists every fund with its account type and sources.

## 4½. Keeping it running

The bot only trades while the process runs. To auto-start at login and restart on crash:

```bash
./scripts/install-launchd.sh          # install (logs to ~/Library/Logs/trading-bot.log)
./scripts/install-launchd.sh remove   # uninstall
```

launchd keeps the *process* alive, not the Mac awake — run `caffeinate -s` during market hours (or adjust Energy Saver) so the machine doesn't sleep through signals. Note that `launchctl stop com.trading-bot` restarts automatically; to actually stop trading, use the kill switch (or uninstall the agent).

## 5. Emergency stops

Three independent ways to stop trading, in order of speed:

1. **Per-fund KILL button** on each fund chip — halts that fund and cancels its open orders; persists in the database until you click Reset & Resume on that fund. Other funds keep trading.
2. **`touch HALT`** in the project root — blocks **all funds** while the file exists, even if the dashboard is unreachable. `rm HALT` (or a dashboard Resume) clears it.
3. **Stop the process** — nothing trades if nothing is running (if installed via launchd, uninstall the agent too, or it restarts). Already-submitted orders at Alpaca are NOT cancelled by killing the process; use the Alpaca dashboard to cancel those.

The **daily-loss circuit breaker** is the automatic fourth: when a fund's day loss exceeds its limits, that fund's open orders are cancelled and its trading blocked. It does **not** auto-reset the next day — you must review what happened and click Reset & Resume on the fund. Halts and breaker trips also fire a macOS/Discord notification if enabled.

## 6. Maintenance

- **Database**: `trading.db` in the project root (SQLite). Back it up by copying the file while the bot is stopped. Delete it to reset all state (the pollers will re-seed on next start).
- **Logs**: structured JSON lines on stdout. Redirect to a file if you want history: `npm start >> bot.log 2>&1`.
- **Tests**: `npm test` (signal validation unit tests).
- **Dashboard development**: `npm run dev:client` starts a Vite dev server with hot reload, proxying API calls to the bot on :3000. Run `npm run build:client` afterwards to update what `npm start` serves.
