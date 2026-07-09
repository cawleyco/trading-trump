# Changelog

## Unreleased

### Added

- Added the walk-forward congress backtest slice: reusable leaderboard ranking, a `/api/backtests/walk-forward` endpoint, a Backtest UI mode with fold controls, fold-by-fold results, and an aggregate out-of-sample curve.
- Documented the walk-forward backtest request and persisted result shape in `docs/API.md`.
- Added persistent politician alpha stats storage, computation, manual refresh, daily scheduled refresh, and list/profile API endpoints.
- Documented the politician stats endpoints in `docs/API.md`.
- Added a Politicians dashboard view with sortable/searchable alpha stats, manual refresh, return/sector/lag charts, and recent archived trades.
- Updated the functionality reference with politician stats behavior, storage, refresh cadence, and logging component details.

### Changed

- Hardened walk-forward window splitting to use contiguous inclusive-day folds and reject invalid fold/date ranges.
- Normalized walk-forward `folds`, `topN`, and `minTrades` parameters before simulation and added API validation for invalid values.
- Extended the fantasy-mode warning banner to walk-forward runs when `entryBasis` is `transaction`.
- Removed a stale closure in the Backtest view's initial politician selection effect.

### Tests

- Added focused walk-forward tests for short ranges and invalid fold requests.
- Added politician stats aggregation tests with injected market-data and sector fixtures.
