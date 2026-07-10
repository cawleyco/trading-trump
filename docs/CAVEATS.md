# Things to Watch Out For

Read this before going live. Read it again before setting `ALPACA_PAPER=false`.

## Financial risk

- **This can lose real money, quickly, without asking you first.** That is the entire point of an automated trader and its biggest danger. The safety rails cap the damage per trade and per day — they do not make the strategies profitable.
- **Neither strategy has proven edge.**
  - *Congress copying*: STOCK Act disclosures legally lag the actual trade by 30–45 days and are often filed late. By the time you copy, the market has had weeks to price it in. The backtester deliberately simulates entry at the **disclosure** date so you can measure what copying would actually have returned — trust that number, not headlines about politicians' returns.
  - *Sentiment trading*: market reactions to a single post are erratic, often reverse within hours, and the post may be stale by the time it's polled, classified, and traded (potentially minutes). This is the most speculative part of the system. Backtest it with realistic hold periods before believing in it.
- **Backtest honesty limits**: simulations ignore commissions (Alpaca is commission-free but there are SEC/TAF fees on sells) and ignore slippage and spread (real fills on market orders are worse than the printed price, especially on volatile names). Daily mode enters at next day-open and exits at close; intraday mode (minute bars) is more realistic for sentiment but relies on the free IEX feed, which is thinner than consolidated data — and stop-loss/take-profit fills assume the level (or the gap open) with no slippage. Compare every result against the SPY benchmark line before concluding a strategy "works". Treat backtest results as optimistic upper bounds.
- **Leaderboard results are ranking bait**: with many politicians and short windows, the top of the leaderboard is often luck (few trades, one lucky ticker). Prefer politicians with many trades across a long window, and check their win rate, not just return.
- **Survivorship gaps**: delisted/renamed tickers show up as "skipped — no price data" in backtests. If a politician's worst pick went to zero and got delisted, the backtest may quietly exclude their biggest loss. Check the skipped list.
- **Taxes**: frequent trading in a taxable account generates short-term capital gains and possible wash-sale complications. Every fill is in `trading.db` — export it for your records at tax time.
- **Day-trading rules**: frequent same-day round trips in a small margin account can trigger pattern-day-trader restrictions. Check Alpaca's current rules on this before running aggressive settings — do not assume.

## Intelligence-layer limitations (scores, stats, dashboards)

Phases 1–11 add a lot of derived numbers — copy scores, politician edge stats, relevance, conflict-risk indices, aggregate heatmaps. They organize the evidence; they do **not** manufacture edge. Read them as prompts for your own judgment, not verdicts.

- **The copy score is backward-looking and heuristic.** It blends freshness, historical politician edge, trade size, clustering, and committee relevance into a 0–100 number with fixed weights (`server/intel/copyScore.js`). None of those factors is proven to predict forward returns; the weights are hand-chosen, not fitted. A 90 means "checks the boxes we decided mattered," not "will make money." The `warnings` and the thesis card exist precisely so you never act on the number alone.
- **Politician edge stats suffer survivorship and small-sample bias.** `politician_stats` is computed from trades that resolved to a known ticker with price history; delisted/renamed names drop out (same survivorship gap as backtests), so a member's realized record can look better than reality. Members with few trades get noisy win rates and edge scores — the profile shows the trade count for exactly this reason. `edge_score` is a relative ranking within the current archive, not an absolute skill measure, and it shifts as the archive grows.
- **Relevance and conflict-risk are association, not causation.** Committee/bill/lobbying/contract links (`server/intel/relevance.js`, the Intel "exposed stocks" tab) show that a politician is *positioned* to know something — never that a specific trade used non-public information. Treat a high conflict-risk index as "worth a closer look," not an accusation.
- **Aggregate dashboards inherit every upstream gap.** The Intel heatmaps and "most active" tables are only as complete as ticker/sector resolution and bioguide linkage. Trades whose ticker didn't resolve to a sector, or whose politician didn't link to a committee, are silently absent from those grids — so a quiet cell can mean "no data," not "no activity."

### Fantasy vs. realistic backtests

The backtester runs in two spirits, and conflating them is the easiest way to fool yourself:

- **Fantasy** — entry at the **transaction** date (what a politician's own trade returned) with no costs. Useful only as a theoretical ceiling; you cannot trade on information you don't have yet.
- **Realistic** — entry at the **disclosure** date (the earliest you could actually copy), ideally with the slippage/spread/fee modeling and intraday fills enabled. This is the number to trust.

The compare-modes view exists to show the gap between the two, which for congressional copying is usually large. Any strategy that only looks good in fantasy mode does not work. Always read the SPY benchmark line alongside the return.

## Legal / terms-of-service

- **Truth Social scraping is a gray area.** There is no official API; the bot uses the platform's public Mastodon-style endpoints, unauthenticated. This may violate their ToS, may be rate-limited or IP-blocked at any time, and may simply stop working after a platform update. The bot degrades gracefully (logs errors, keeps running), but expect this source to be the first thing that breaks. The historical post archive used by the tweet backtester is a third-party GitHub project that could also go stale.
- **Senate eFD scraping** targets a public government website that publishes this data by law. The scraper accepts the site's access agreement, fetches politely in small batches, and caches for an hour. Still: it can rate-limit you (typically a temporary 403), and a site redesign will break the parser.
- **Congressional trading may be banned.** Multiple bills propose prohibiting members of Congress from trading stocks. If one passes, the congress signal source dries up permanently. The system is built so that source can die without affecting the sentiment source or the core engine.
- **This is a personal-use tool — and the mode ladder enforces that posture.** Fully automatic execution (`action.mode: "auto"`) is refused unless a fund explicitly opts in (`funds.json "allowAutoStrategies": true`) *and* `TRADING_MODE=live`; everything below that (research/watch, paper, manual approval) is the default. See `GET /api/posture` and the startup log for each fund's current rung.
- **Doing this for other people is a different legal universe.** In plain English: the moment you trade someone else's money, pool funds, publish these scores/cards as recommendations, or charge for signals, you are likely acting as an investment adviser and/or broker. That is registration territory (RIA/BD obligations, disclosures, recordkeeping, fiduciary duty) enforced by the SEC and state regulators — not something a hobby project satisfies. This tool is built and licensed for **your own** research and **your own** account. Keep it that way, or talk to a securities lawyer first.

## Operational gotchas

- **Restart ≠ replay.** On every startup, both pollers seed all currently-visible disclosures/posts as "seen" without trading. Anything disclosed/posted *while the bot was off* is never traded. This is deliberate (it prevents a burst of stale orders at startup) but means downtime = missed signals, silently.
- **The bot only trades while running.** It's a foreground process on your Mac — sleep, reboot, and crashes all stop it. If the Mac sleeps mid-day, nothing trades and nothing alerts you. Keep the machine awake during market hours (e.g. `caffeinate`) or accept the gaps.
- **Killing the process does not cancel open orders.** Already-submitted orders live at Alpaca. Use the dashboard kill switch (which cancels them) or Alpaca's own dashboard.
- **Config is read once at startup.** Editing `.env` does nothing until you restart. Always check the startup banner after a restart — it prints the trading mode and endpoint.
- **The circuit breaker measures whole-account equity change, not just bot losses.** Each fund's daily baseline is its account equity at the first observation of each Eastern-time day. If you hold positions from other activity in the same account, their moves count toward that fund's daily loss limit. This is why one Alpaca account = one fund is enforced — and why a dedicated account per fund is the clean setup.
- **Auto-exit knows entry prices, not intent.** It uses Alpaca's average entry price, so positions you opened manually in the same account are also subject to a fund's stop-loss/take-profit rules. The max-hold rule only applies to positions the bot itself opened (it needs the recorded buy date).
- **The Trump post archive lags.** The public historical archive stopped/can stop updating (as of this writing it ends 2026-05-02); tweet backtests warn when your date range falls outside coverage and report the available range. The bot supplements the archive with every post it collects while running — coverage of recent dates grows only while the bot is on.
- **Clock/timezone**: "the trading day" is US/Eastern. The market-hours check uses Alpaca's official market clock, so DST and holidays are handled — but your cron-based congress poll runs in local time.
- **One instance only.** Running two copies against the same `trading.db`/account will double-trade signals. There's no lock preventing it.
- **The dashboard has no login** because it binds to `127.0.0.1` only. Do not change the bind address or port-forward it — anyone who can reach it can trade with your account and read your positions.
- **The Pipeline Test button is real.** In `live` mode it places an actual order for the ticker you typed. It respects all risk caps, but it is not a toy in live mode.

## Cost watch

- **Claude API**: one small call per new Trump post (cheap, posts are short) — but a tweet **backtest** makes one call per post, up to `maxPosts`. Backtesting a year of posts at the 1000-post cap is real money. Start with small ranges/caps.
- **Quiver**: optional subscription; only needed for House trades and fast historical loads.
- **Alpaca**: trading is commission-free; the free market-data tier (IEX feed) is what backtests use. Historical coverage and quote quality are lower than the paid SIP feed — another reason backtest fills are approximate.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Startup error `Missing required env var ALPACA_API_KEY` | You haven't created/filled `.env`. Copy `.env.example` and fill it in. |
| Every signal rejected with `Request failed with status code 401` | Alpaca keys are wrong, or paper keys used with `ALPACA_PAPER=false` (or vice versa). Keys are endpoint-specific. |
| `Websocket error: bad key id or secret` at startup | Same as above — fix the Alpaca keys. |
| Status bar shows "Cannot reach bot server" | The server isn't running, or the dashboard build is stale — `npm start`, and rebuild with `npm run build:client` if you changed client code. |
| Politician dropdown empty / takes minutes | No Quiver key → Senate eFD scrape on first load (minutes). Cached for 1 h after. A persistent failure usually means eFD is rate-limiting you — wait and retry. |
| Congress poll logs `Failed to fetch congress trades` | Transient eFD/Quiver outage or rate limit. The poller retries on its next scheduled run; nothing is lost except timeliness. |
| Truth Social poller logs fetch failures | Rate-limited or blocked, or the account name in `TRUTH_SOCIAL_USERNAME` is wrong. If it persists for days, the endpoints may have changed — this is the expected failure mode of an unofficial source. |
| Sentiment source never emits signals | `ANTHROPIC_API_KEY` unset (check startup warnings), threshold too high, or — most commonly — the posts genuinely have no confident market read. Check the log: every classification and its reasoning is recorded. |
| Backtest trades all "skipped — no price data" | Alpaca keys invalid (bars come from Alpaca), date range before data coverage, or delisted tickers. |
| `no open position in X to sell (shorting disabled)` rejections | Working as intended: a sell signal arrived for something you don't hold. |
| Bot halted and won't trade | Check the fund chip's reason: circuit breaker (review losses, then Reset & Resume on that fund) or a leftover `HALT` file (`rm HALT`). |
| Everything looks approved but no orders at Alpaca | You're in `dry_run` (check the startup banner / status bar) — orders are recorded as `simulated`. |
| Tweet backtest: 0 trades but posts were classified | Working as intended — check the "What the classifier said" table: most posts have no confident market read. Lower the confidence threshold to see near-misses trade. |
| Tweet backtest warns about date coverage | Your range is outside the post archive's coverage (it lags). Backtest an earlier range, or let the bot run — it collects new posts itself. |
| Startup error about funds.json | The error says exactly what's wrong: duplicate name, missing env var, or two funds sharing a key pair (not allowed — one account per fund). |
| A signal shows no decision rows | No enabled fund subscribes to that signal's source — check each fund's `sources` in `funds.json`. |
| Intraday backtest trades marked "(daily)" | No minute data for that ticker/date on the IEX feed — those trades were simulated on daily bars instead. |
