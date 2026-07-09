# Changelog

## Unreleased

### Added

- Added the walk-forward congress backtest slice: reusable leaderboard ranking, a `/api/backtests/walk-forward` endpoint, a Backtest UI mode with fold controls, fold-by-fold results, and an aggregate out-of-sample curve.
- Documented the walk-forward backtest request and persisted result shape in `docs/API.md`.

### Changed

- Hardened walk-forward window splitting to use contiguous inclusive-day folds and reject invalid fold/date ranges.
- Normalized walk-forward `folds`, `topN`, and `minTrades` parameters before simulation and added API validation for invalid values.
- Extended the fantasy-mode warning banner to walk-forward runs when `entryBasis` is `transaction`.

### Tests

- Added focused walk-forward tests for short ranges and invalid fold requests.
