This guide is the actual procedure: which page to open, what to set every field to, what number to read, and the pass/fail rule that tells you whether to continue or go back. Work it top to bottom. The Backtest Lab guide explains what each control does; this one tells you what to do with them, in order.

## The workflow at a glance

1. **Screen** a whole source for candidates (leaderboard / batch backtest).
2. **Drill into** one candidate and audit the trades behind the headline number.
3. **Price the lag** — rerun on realistic vs. fantasy timing.
4. **Validate out of sample** with a walk-forward. Most candidates die here. That's the point.
5. **Stress the parameters** — a real edge survives being nudged.
6. **Promote** the survivor to a Watch-mode strategy.
7. **Paper trade** it and compare live matches against the backtest before any real money.

A "fail" at any step sends you back to step 1 with a new candidate — never forward with a rationalization.

## Congress trades, step by step

**Step 1 — Screen.** Open **Backtests**. Set Strategy to `All-politicians leaderboard`, From/To to an 18–24 month window, Exit rule `Hold 90 days`, Entry basis `Disclosure date (realistic)`, Min trades `10`, $ per trade `1000`. Run it.
*Read:* the ranked table. Ignore the return column at first — sort your attention by trade count. Candidates: rows with **15+ trades, win rate ≥ 55%, and return above SPY's** over the same window.
*Pass:* 1–5 names qualify → step 2. *Fail:* nobody qualifies → widen the window before loosening Min trades; a longer history beats a lower bar.

**Step 2 — Drill in.** Click **Full backtest** on a candidate row.
*Read three things:* (a) the cumulative P&L chart — is it above the SPY overlay for most of the window, or did one spike create the whole lead? (b) the per-trade table — are gains spread across many tickers, or is it one moonshot plus noise? (c) **Skipped trades** — any delisted names? A missing worst pick inflates everything.
*Pass:* broad-based gains, clean skip list → step 3. *Fail:* one trade carries it → back to step 1; you found a lottery ticket, not a process.

**Step 3 — Price the lag.** Click **Compare modes** (transaction vs. disclosure basis, side by side).
*Read:* the gap between the two totals. That gap is what the 0–45-day disclosure delay costs you.
*Pass:* disclosure-basis still beats SPY on its own → step 4. *Fail:* only transaction-basis wins → the edge evaporates before you could ever trade it. Back to step 1.

**Step 4 — Validate out of sample.** Set Strategy to `Walk-forward (overfitting guard)`. Same window, Folds `4`, Top N `5`, Min trades `3`, Entry basis `Disclosure date`. Run it.
*Read:* the per-fold tables and the **Out-of-sample quality** summary. Does your candidate appear in the in-sample top-N of more than one fold, and do the out-of-sample returns stay positive and above SPY?
*Pass:* OOS beats SPY and your name recurs → step 5. *Fail:* great in-sample, flat or negative out-of-sample → it was luck. Back to step 1. **Expect this outcome most of the time.**

**Step 5 — Stress it.** Save the setup as a preset, then rerun the full backtest three more times: Exit rule `Hold 30 days`, `Follow their sells`, and once with a Stop-loss (try 15%).
*Pass:* returns shrink or grow but stay SPY-positive in every variant → step 6. *Fail:* the edge only exists at exactly `Hold 90` → it's curve-fit to one parameter. Back to step 1.

**Step 6 — Promote.** On the surviving result, click **Promote** — it creates a strategy pre-filled with the politician filter. Leave the action mode at **Watch**.

**Step 7 — Paper trade.** Let the strategy accumulate matches for a few weeks. Compare the matches (tickers, frequency, lag) against what the backtest predicted; then run the strategy's own backtest button and check they agree. Only then promote it up the ladder — `Paper signal` next, never straight to auto.

## Trump posts, step by step

**Step 1 — Cheap wide screen.** Backtests page, Strategy `Trump post sentiment`. Hold for `24 hours`, Max posts `50`, Confidence ≥ `0.5`, a 6-month range, $ per trade `1000`. Run.
*Read:* total P&L vs SPY and the trade count. Also open **"What the classifier said"** — how many posts produced ticker calls at all?
*Pass:* positive, SPY-beating P&L on 10+ trades → step 2. *Fail:* near-zero trades → the range has thin post coverage (the result warns about this); move the range. Negative P&L → try step 2 anyway once — the signal may live at a shorter hold.

**Step 2 — Find the decay.** Rerun the identical setup at Hold `2 hours`, `24 hours`, and `5 days`. Save each as a preset so the Past Backtests table lines them up.
*Read:* where the return concentrates. A real post-reaction edge is strongest at hours and decays; if returns *grow* with hold time, you're just long the market and the posts are decoration.
*Pass:* short-hold returns dominate → step 3. *Fail:* returns flat across holds or best at 5 days → no sentiment edge; stop here.

**Step 3 — Sweep confidence.** Same range and hold, rerun at Confidence ≥ `0.5`, `0.65`, `0.8`.
*Read:* per-trade average return at each threshold.
*Pass:* higher confidence → better average per trade (fewer, better trades) → step 4. *Fail:* returns peak at some middle value and collapse either side → the threshold is doing the work, not the signal. Stop.

**Step 4 — Spend for density.** Only now raise Max posts (200+, remember: one Claude call per post) and rerun the winning combination over the longest covered range for a proper sample.
*Pass:* holds up at scale → treat as a candidate. There is no auto-bridge from tweet backtests to strategies (Promote is congress-only), so paper trade it by hand via the Invest flow before believing it.

## YouTube mentions, step by step

**Step 0 — Clean the population.** On **Influence → YouTube → Channels**, check pump risk. Anything red (>70) is excluded from your edge search — a "win rate" built on pumps is the scam working on you. Channels need 10+ measurable mentions before their alpha label (`follow`/`fade`/`neutral`) is even trusted; `n/a (x/10)` rows aren't evidence yet.

**Step 1 — Batch backtest.** On the **Backtests** tab: Name the run, Min quality `0.7`, Direction `bullish`, run it.
*Read:* the summary **by window** — average return at 1h, 24h, 7d, 30d, next to the SPY benchmark.
*Pass:* returns positive at 7d/30d → step 2. *Fail:* positive at 1h/24h but gone by 7d → creators move prices briefly and it mean-reverts; that population is a *fade* candidate at best, not a follow.

**Step 2 — Attribute it to creators.** Open the strongest channels' profiles (Channels tab → View) and read per-creator win rates over measurable mentions.
*Pass:* the edge concentrates in 1–3 `follow`-labeled creators with 10+ measurable mentions → step 3. *Fail:* spread thin across everyone → you measured market beta during a bull window.

**Step 3 — Walk-forward the creators.** The creator walk-forward (rank creators per fold, score the next fold's mentions out-of-sample) runs via the API — `POST /api/influence/youtube/walk-forward` with `{ startDate, endDate, folds, topN, minMentions }` — there's no UI button for it yet.
*Pass:* out-of-sample mention returns stay positive for your creators → you have a research finding. YouTube is deliberately research-only (no invest bridge); the deliverable is a watchlist: act on those creators' future mentions via the Signals tab, manually.

## When do you actually have an edge?

All seven, or it's not an edge yet:

1. **30+ trades** behind the number — under that it's an anecdote.
2. **Beats SPY** on the same dollars and dates.
3. **On realistic timing** — disclosure basis / post time / mention time.
4. **Survived a walk-forward** out of sample.
5. **Survived parameter nudges** — exit rule, threshold, stop-loss.
6. **Clean skip list** — no delisted losers silently missing.
7. **Has a mechanism you can say in one sentence** — committee relevance, reaction speed, early-creator alpha. If you can't say why it works, you won't notice when it stops.

Then subtract costs mentally: simulations ignore slippage and spread, so halve any thin edge — especially intraday sentiment trades.

## Tips & caveats

- Save every step as a **research preset** and lean on the Past Backtests table — the workflow is comparisons, and comparisons need identical reruns, not memory.
- The leaderboard tests hundreds of names at once, so its top row *always* looks amazing — that's multiple-comparisons bait, and it's why step 4 is mandatory, not optional.
- Edges decay: re-run step 4 on your live strategies periodically, and treat "live matches stopped resembling the backtest" as a signal to demote the strategy back to Watch.
