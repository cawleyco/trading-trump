The Backtest Lab simulates three strategies against real historical prices, always next to a SPY benchmark — the honest "should I have just bought the index?" line.

## How to backtest copying one politician

1. Pick a **Politician** — the dropdown lists everyone with disclosed trades in the period, with trade counts. (Without a Quiver key the first load scrapes the Senate site and can take minutes; it's cached for an hour after.)
2. Choose an **Exit rule**: `Follow their sells` (exit when they later disclose selling the same ticker, else hold to today), `Hold 30/90 days`, or `Hold to present`.
3. Set **From/To** — this filters by **disclosure date** (when the filing became public), matching what a live copier could actually have done.
4. Set **$ per trade** and run.

## How to find who's worth copying (leaderboard)

The **All-politicians leaderboard** backtests every politician with at least *min trades* in the period and ranks them by return. Use it to discover candidates instead of guessing, then click **Full backtest** on a row to drill in. Beware ranking bait: with many politicians and short windows, the top is often luck — prefer many trades over a long window and check win rate.

## How to backtest Trump post sentiment

1. Set **Hold for** — days (daily bars) or hours (minute bars, entering right after the post; more realistic for sentiment moves).
2. Set **Max posts** — a hard cap on classifications. **Each post is one Claude API call**, so this is your cost control. Posts are sampled evenly across the range.
3. Set **Confidence ≥** — the threshold for turning a classifier call into a simulated trade. Start around 0.5, then tighten.
4. If the result is empty, expand **"What the classifier said"** — every post's ticker calls and confidences are listed, with near-misses below your threshold highlighted. An empty result is always explainable.

## How to choose the entry basis

- **Disclosure** (default) — entry when the filing became public. The realistic number; trust this one.
- **Transaction** — entry at the politician's own trade date. A fantasy upper bound: you cannot trade on information you don't have yet. The UI banners these results.
- The compare-modes view runs both side by side; the gap *is* the cost of the disclosure lag. A strategy that only looks good in fantasy mode does not work.

## How to read the results

- Total P&L, win rate, and a cumulative P&L chart with the SPY overlay (same dollars, same dates, into SPY).
- The per-trade table: entry/exit dates and prices, P&L, and exit reason (`time` / `stop-loss` / `take-profit`).
- **Skipped trades** are listed with a reason (usually no price data — delisted tickers) and excluded from totals, never silently guessed. Check this list: if a politician's worst pick got delisted, its loss may be missing.
- Optional **Stop-loss % / Take-profit %** exit intrabar at the level, at the open on gaps, and stop-before-target when both hit in one bar (conservative).

## Tips & caveats

- Every run is saved: the **Past Backtests** table reloads any previous result instantly, and research presets let you name and reapply common setups.
- Simulations ignore slippage and spread by default — treat results as optimistic upper bounds, and always read the SPY line before believing a strategy "works".
- The Trump post archive lags (the results warn when your range falls outside coverage); the bot extends coverage with every post it collects while running.
