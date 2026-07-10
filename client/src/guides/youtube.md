YouTube Influence is a research module: it tracks finance creators, detects asset mentions in their transcripts, classifies them, and measures what actually happened to the price after each mention. It is deliberately **research-only** — nothing here places orders or feeds the live trading pipeline.

## How the tabs fit together

- **Overview** — module-level stats: tracked channels, videos, mentions, and recent signal events.
- **Channels** — every tracked creator with subscriber/engagement snapshots. Click a channel for its profile: creator-alpha metrics, win rates, pump-dump rate, and its recent mentions.
- **Videos** — synced video metadata. A video's detail page shows its transcript segments and detected mentions.
- **Mentions** — every detected asset mention with direction (bullish/bearish), classification quality, and a pump-risk score.
- **Backtests** — post-mention return analysis.
- **Signals** — the research signal feed built from high-quality classified mentions, labeled `watch`, `avoid`, or `manual_review`.

## How to trace a mention to its evidence

1. Open **Mentions** and pick a row.
2. Follow it to the video detail page — the mention links to the exact transcript segment (with timestamp) it was detected in.
3. Read the classification: direction, confidence, and the raw model output are stored alongside every normalized score, so you can always check the machine's work.

## How to run a post-mention backtest

1. Open the **Backtests** tab and choose the channels/mentions scope and horizons.
2. Run it. Entries are priced from real market data: minute bars for the entry and intraday (1h/6h) windows, daily closes for longer windows, and every result carries a 30-day SPY benchmark.
3. Read the per-mention results. Off-hours mentions enter at the next day's open (intraday windows are blank). Mentions with no price data are flagged `noPriceData` and excluded — never filled with synthetic prices.

## How to read pump-risk

The pump-risk badge is green below 40, amber to 70, red above. Elevated pump-risk signals are labeled for review rather than trusted — a confident-sounding mention of an illiquid name is the classic pump pattern. Creator win rates are computed only over measurable mentions, so a creator can't look good by mentioning untradeable coins.

## Tips & caveats

- Transcripts come from compliant manual uploads (plain text / SRT / VTT) — the module does not scrape YouTube. No transcript, no mentions.
- Creator alpha is attention vs. edge: a big channel moves prices *because it's big*. The backtest horizons exist to check whether the move sticks or mean-reverts.
- Any future bridge to live trading is gated behind an explicit flag (`YOUTUBE_LIVE_SIGNALS_ENABLED`), off by default.
