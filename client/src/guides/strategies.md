A strategy is a saved rule set matched against every newly scored Congress trade: filters decide *which* trades qualify, the action decides *what happens* when one does.

## How to create a strategy

1. Fill in the **New Strategy** form. Every filter is optional — leave a field blank to skip it:
   - **Min copy score / Min confidence / Min edge score** — quality bars from the scoring layer.
   - **Max lag days / Max drift %** — freshness bars: skip stale filings and names that already moved.
   - **Min cluster count / Min relevance** — conviction bars: multiple members buying, or committee-relevance.
   - **Politicians / Exclude politicians / Sectors / Exclude warnings** — comma-separated allow/deny lists (e.g. exclude `stale-filing, illiquid`).
   - **Min amount mid** — minimum midpoint of the disclosed amount band.
2. Choose the **Action** mode (see below), the target **Fund**, and the **Notional USD** per matched trade.
3. Click **Create strategy**. Matches start appearing on the strategy row ("Last match") and in Alerts if you have a `strategy-match` rule.

## How to choose the action mode

The modes are a ladder, least to most automated:

| Mode | What a match does |
|---|---|
| **Watch** | Records the match. Nothing else. The right default. |
| **Paper signal** | Sends a signal to a paper fund — real pipeline, fake money. |
| **Manual approval** | Queues the trade on the Approvals page with its thesis card; nothing happens until you approve. |
| **Auto signal** | Trades without asking. Refused unless the target fund sets `allowAutoStrategies: true` in funds.json **and** the bot runs in live mode. |

## How to backtest a strategy

1. Set the **Backtest Settings** range, $ per trade, and exit rule.
2. Click **Backtest** on the strategy row. The result applies your filters to the historical archive and simulates the matches.
3. Read the summary *and* its stated limitation — then compare against the plain politician backtests before trusting it.

## Tips & caveats

- Start every strategy in **Watch** mode and let it accumulate matches for a while; promote it up the ladder only after the matches (and their backtest) look sane.
- Tight filters on a short history match nothing; loose filters match everything. Iterate with the Trades page — its filters mirror these, so you can preview what a rule set would have caught.
- Auto-mode matches are additionally subject to the per-fund guardrails (min copy score, review-queue blocking) and every normal risk check.
