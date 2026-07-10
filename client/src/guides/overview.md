The Overview terminal is the live operating view: what the bot is doing right now, per fund, and the fastest place to stop it.

## How to read the status bar

The status bar sits above every page and refreshes every 10 seconds.

- **Mode banner** — 🟢 DRY RUN means orders are simulated; 🔴 LIVE MODE means real orders. It also warns when a global `HALT` file exists.
- **One chip per fund** — 🧪 paper / 💵 live, the fund's signal sources, equity, day P&L, and open position count.

> The mode banner is the single most important thing on the screen. Check it after every restart — config is read once at startup.

## How to stop a fund (and bring it back)

1. Click **KILL** on the fund's chip. That fund is halted and its open orders at the broker are cancelled. Other funds keep trading.
2. The chip switches to **Reset & Resume**. Nothing auto-resumes — a fund stays halted (including after a daily-loss circuit-breaker trip) until you review what happened and click Reset & Resume.

Halting is deliberately easy; resuming deliberately requires intent. For an everything-stops switch, create a `HALT` file in the project root (`touch HALT`) — all funds block until it's removed.

## How to use the fund selector

When more than one fund is configured, the selector controls which fund the rest of the page describes:

- **Open Positions** — live from that fund's Alpaca account, with unrealized P&L.
- **Limits** — the fund's effective risk caps, sources, sentiment threshold, and auto-exit rules. Use this to confirm what the bot *thinks* its limits are.

## How to run a Pipeline Test

The Pipeline Test fires a manual buy signal for a ticker you type, through the **real** risk pipeline — every check runs, and the decision is recorded like any other signal.

1. Select the target fund.
2. Enter a ticker and submit.
3. Read the decision in Recent Signals: which checks passed, and the computed position size.

> In dry-run mode the order is simulated. In live mode **it places a real order**. It respects all risk caps, but it is not a toy.

## How to read Realized P&L by source

Once positions have been closed, this chart shows cumulative realized P&L attributed to the signal source that *opened* each position (per fund). It answers "is congress-copying or sentiment actually making me money?" directly. Only real fills count — dry-run simulated orders never appear here.

## How to read Recent Signals

Each row is one signal with a per-fund decision (✅ approved / ❌ rejected), the order status, and the risk manager's reasoning. For the complete history including everything ever rejected, use the **Signals** page.

## Tips & caveats

- The bot only trades while the process runs. If the machine sleeps mid-day, nothing trades and nothing alerts you.
- On startup, currently-visible disclosures/posts are marked as seen *without* trading — downtime means missed signals, silently, never a burst of stale orders.
- Killing the server process does **not** cancel orders already at Alpaca; the KILL button does.
