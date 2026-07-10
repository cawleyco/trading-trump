# Invest from Research — Implementation Plan

Bridge research surfaces (backtests, thesis cards, alerts, watchlists, influence,
pipeline) into the existing `makeTradeSignal` → `processSignal` → Alpaca path.

Decisions locked in design grilling (2026-07-10):

| Decision | Choice |
|---|---|
| Actions | One-shot **Invest** + **Promote** (congress/strategy backtests only) |
| Surfaces | Invest on every ticker surface |
| Confirm | Two-step: ephemeral risk preview → confirm |
| Size | Backtest `$/trade` when present; else fund default; editable, risk-capped |
| Promote | Always ask mode + fund; default **manual**; warn if `SIGNAL_ROUTING≠strategies` |
| Fund | Last-used sticky; paper-fund fallback |
| Audit | `source: manual` + `origin` (`backtest`, `thesis`, `alert`, …) |
| Direction | Pre-fill from context, editable |
| Preview | No DB writes until confirm |
| Ship | Full surface coverage in one pass |

---

## Architecture

```
UI (InvestButton / InvestModal / PromoteModal)
        │
        ├─ POST /api/invest/preview   ──► previewSignal()  (no DB writes)
        ├─ POST /api/invest/confirm   ──► makeTradeSignal(manual) → processSignal(onlyFund)
        └─ POST /api/strategies/promote ──► createStrategy(...) + routing warning
```

All one-shot trades use `source: 'manual'`. Provenance lives in
`rawReference.origin` (`kind`, optional ids, surface label). Automated congress /
sentiment P&L series stay clean; attribution still shows a `manual` bucket.

`onlyFund` bypasses fund `sources` subscription, so funds do not need
`"manual"` in `funds.json`.

---

## Backend tasks

### 1. Signal source `manual`
- Extend `SOURCES` in `server/signal.js`.
- Keep fund config `VALID_SOURCES` as congress/sentiment only.

### 2. Ephemeral preview + notional override
- Refactor `processSignalForFund` so evaluation can run without
  `insertSignal` / `insertDecision` / `insertOrder`.
- Accept `requestedNotionalUsd` (capped by fund max notional / % equity).
- Export `previewSignal(signal, { onlyFund, requestedNotionalUsd, ... })`.

### 3. Invest module + routes
- `server/invest.js`: validate body, build manual signal, preview/confirm helpers,
  promote-from-backtest definition builder.
- `POST /api/invest/preview` → checks + would-approve + sized notional + trading mode.
- `POST /api/invest/confirm` → real `processSignal`.
- `GET /api/invest/funds` → enabled funds (name, paper, risk caps) for the modal.
- `POST /api/strategies/promote` → create strategy; include
  `{ routing: config.signals.routing, routingWarning? }`.

### 4. Promote mapping
- Congress / politician backtest → filters `{ politicians: [name] }`, action from modal.
- Strategy backtest → clone that strategy’s filters; set action from modal.
- Tweet / YouTube → **no Promote** (Invest only).

---

## Frontend tasks

### 5. Shared components
- `client/src/components/InvestModal.jsx` — fund, direction, size, Preview, Confirm.
- `client/src/components/PromoteModal.jsx` — name, mode (default manual), fund, notional.
- `client/src/components/InvestButton.jsx` — opens InvestModal with context props.
- Sticky fund in `localStorage` (`invest.lastFund`); paper-fund fallback from status.

### 6. Wire every ticker surface
| Surface | Invest | Promote |
|---|---|---|
| Backtest trade rows / tweet ticker calls | yes | congress + strategy only |
| Trades / thesis cards | yes | — |
| Intel tables (most-active, exposed) | yes | — |
| Politicians recent trades | yes | — |
| Calendar related tickers | yes | — |
| Watchlist activity | yes | — |
| Alerts feed (when ticker present) | yes | — |
| Approvals | yes (optional shortcut) | — |
| Signal log / dashboard recent signals | yes | — |
| YouTube mentions / signals / backtests | yes | — |
| Pipeline test | keep existing; can also open Invest | — |

---

## Docs & tests

- Update `docs/API.md`, `docs/USAGE.md`, `docs/FUNCTIONALITY.md`.
- Tests: preview writes nothing; confirm writes signal with `source=manual` + origin;
  notional cap; promote creates strategy + routing warning when legacy.

---

## Out of scope (v1)

- Auto-flipping `SIGNAL_ROUTING` from the UI.
- New strategy types for tweet/YouTube.
- Persisting preview rows.
- Changing fund `autoExit` from backtest SL/TP on promote (fund rules still apply).
