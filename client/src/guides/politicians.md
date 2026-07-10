Politician Dossiers are per-member tear sheets computed from the trade archive: what their disclosed buys actually returned if you'd copied them at disclosure, how fast they file, and how concentrated their bets are.

## How to read a dossier

Each profile is built from the member's archived **buys** (options and low-confidence filings excluded), entered at the disclosure-date close:

- **Forward returns** at +7/30/90/180 days, with win rates per horizon.
- **Edge score** — the member's percentile rank of average 90-day return among members with at least 10 measurable buys. A missing edge score means "not enough data", which is deliberately distinct from "average".
- **Median disclosure lag** — how stale their filings are by the time you can act.
- **Sector breakdown** — per-sector 30-day returns, and ticker concentration (a concentrated trader is one lucky ticker away from a fake track record).
- **Recent trades** — their latest filings with copy scores.

## How to find who's worth copying

1. Sort the list by edge score, but read the **trade count** next to it — a high score on a handful of trades is noise.
2. Prefer many trades across a long window, and check win rate, not just return.
3. Confirm with a real backtest: the Backtests page's leaderboard mode ranks every politician by simulated copy-return, and "Full backtest" drills into one.

## Tips & caveats

- STOCK Act disclosures lag the actual trade by 30–45+ days and are often filed late. Every number here is computed from the disclosure date — what a copier could actually have done — not the politician's own entry.
- Stats suffer survivorship bias: delisted/renamed tickers drop out, so a member's record can look better than reality.
- Stats refresh nightly (06:00 ET); a full refresh recomputes prices and can take minutes.
