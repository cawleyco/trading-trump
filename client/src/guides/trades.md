Congressional Trades is the archive of every disclosed trade the bot has seen, joined to explainable copy-worthiness scores and do-not-copy warnings.

## How to filter the feed

Combine **Since** (disclosure date), **Min score**, **Recommendation** (`copy-candidate` / `watchlist` / `avoid` / `manual-review`), **Politician**, and **Ticker**, then Apply. These filters mirror the Strategies form — use them to preview what a strategy rule set would have caught.

## How to read a row

- **Lag** — days between the trade and its disclosure. Everything here is 30–45+ days old by law; lag beyond that earns a stale warning.
- **Amount** — disclosed as a band, not an exact figure; the archive stores min/mid/max of the range.
- **Score / Recommendation / Warnings** — the deterministic copy score (0–100) with its verdict and any red flags. A trade with no score yet has a **Score** button to compute it on demand.

## How to read a thesis card

Expand a row to see its thesis card — a plain-language brief with a fixed structure: *What happened*, *Why it might matter* (repeat buys, clustering, position size, committee/bill/lobby relevance), *Since then* (price drift since trade and since disclosure), *Signal strength*, *Risks*, and *Suggested action*. Below it sits the factor breakdown (exactly which factors produced the score) and the **Connections** panel: the politician's committees, related bills, lobbying, and contracts for that ticker.

Cards are template-based — free, instant, and deterministic — and rebuild automatically whenever the score changes.

## Tips & caveats

- The copy score is backward-looking and heuristic: fixed hand-chosen weights over freshness, politician edge, conviction, drift, relevance, clustering, and liquidity. A 90 means "checks the boxes we decided mattered", not "will make money". The warnings and thesis card exist precisely so you never act on the number alone.
- Disclosures can be amended or plain wrong; amended filings are linked to their originals, and low-confidence parses are routed to the review queue (on the Signals page) instead of being trusted.
- Click through to the politician's dossier before copying anyone — one good-looking trade is not a track record.
