Alert rules evaluate at natural pipeline moments — a trade is scored, a strategy matches, a post is classified, the calendar refreshes — and route explanatory, deduplicated notifications through macOS Notification Center and/or Discord. Every alert states the *why*.

## How to create a rule

1. Pick a **rule type** (reference below) and, where applicable, edit its JSON params.
2. Pick a **channel**: `macos`, `discord`, or `all`. (Discord requires the webhook configured in `.env`.)
3. Save. Enabled rules fire automatically; disabled rules are kept but skipped.

## Rule type reference

| Rule | Fires when | Params |
|---|---|---|
| `high-score-trade` | A scored trade's copy score ≥ minScore | `{"minScore": 85}` |
| `watchlist-activity` | A trade or event touches a watched ticker/politician/sector/committee | — |
| `cluster` | ≥ clusterCount members trade the same ticker/direction within the window | `{"clusterCount": 3, "windowDays": 30}` |
| `committee-relevant` | The committee-relevance factor ≥ minRelevance | `{"minRelevance": 50}` |
| `stale-warning` | A scored trade carries a stale-disclosure warning | — |
| `strategy-match` | Any strategy matches a trade | — |
| `tweet-catalyst` | A classified post is market-relevant | — |

## How to test and troubleshoot delivery

- The in-app **feed** on this page shows everything that fired, regardless of channel — check it first: if an alert is in the feed but didn't reach you, the problem is the channel (Discord webhook URL, macOS notification permissions), not the rule.
- If nothing is in the feed either, the rule's condition simply hasn't been met — rules only evaluate when their trigger moment happens (e.g. `high-score-trade` needs a *new* trade to be scored).
- Duplicates are suppressed by a dedup key, so re-scoring the same trade won't re-alert. That's by design.

## Tips & caveats

- `watchlist-activity` is only as good as your watchlist — add tickers and politicians from the Intel and Politicians pages.
- Alerting is best-effort by design: a notification failure is logged and swallowed, and can never break trading. The system's own events (breaker trips, halts, live orders) notify independently of these rules.
