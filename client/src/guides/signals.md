The Signals page is the complete audit trail: every signal the bot ever generated — including every rejection — with the risk manager's exact reasoning per fund. If you ever wonder "why didn't it trade X" or "why did it trade Y", the answer is here.

## How to answer "why didn't it trade X"

1. Find the signal (every source's signals appear here: congress, sentiment, auto-exit).
2. Open its decision rows — one per fund subscribed to that source.
3. Read the ordered check list. Checks run in a fixed order and the first failure is the rejection reason: halted → confidence gate → market open → daily-loss breaker → tradable on Alpaca → sell-without-position → exposure caps → optional per-fund guardrails → position sizing → dry-run gate.

Common reasons, decoded:

| Reason | Meaning |
|---|---|
| `market is closed` | Signal arrived outside market hours; no extended-hours trading. |
| `max open positions reached` | The fund's exposure cap; not an error. |
| `no open position to sell (shorting disabled)` | A sell signal for something you don't hold. The bot never shorts. |
| `confidence below threshold` | Sentiment signal under this fund's bar — other funds may have accepted it. |
| Order recorded as `simulated` | You're in dry-run mode; everything worked, nothing was sent. |

## How to read a signal with no decision rows

No enabled fund subscribes to that signal's source. Check each fund's `sources` in `funds.json`.

## How to handle the review queue

Filings that parsed below 0.8 confidence (bad dates, unparseable amounts, unresolvable tickers) are held for human review and surface here with the raw filing inline. Approve or reject each one — pending items are barred from strategy auto-modes.

## Tips & caveats

- A rejection is a normal, logged outcome — the pipeline is designed to say no most of the time.
- Signal detected ≠ edge confirmed. This page proves the plumbing works, not that the strategy makes money — that's what Backtests are for.
