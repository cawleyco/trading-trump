The Political Market Calendar aggregates upcoming and recent political catalysts — committee hearings, bill actions, lobbying (LDA) filing deadlines, and federal elections — each tagged with sectors and linked to tickers Congress actually traded recently.

## How to scan for catalysts

1. Set the **From/To** range (defaults to the next 90 days) and optionally a **sector** filter, then Apply.
2. Events are grouped by week. Each row shows its type (Hearing / Bill action / LDA deadline / Election), sector tags, and **related tickers** — tickers in those sectors that appeared in Congress trades during the prior 90 days.
3. Follow a related ticker back to the matching trades to see who was positioned before the event.

## How to refresh the data

- **Reload** re-reads what's already collected.
- **Run collectors** re-fetches from the sources for your date range. Collectors also run automatically at startup and daily at 05:15 ET; each source skips independently if its data or API key is missing (committee hearings need a Congress.gov API key).

## Tips & caveats

- Calendar refreshes are one of the alert engine's trigger moments — a `watchlist-activity` rule fires when a new event touches a watched sector, committee, or ticker.
- Earnings is a reserved event type — it appears in the legend but has no data source wired up yet.
- An event near a cluster of trades is association, not causation. It tells you where to look, not what happened.
