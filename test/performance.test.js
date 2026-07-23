import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCurve, summarize } from '../server/performance.js';

test('performance summary computes wins, losses, profit factor and drawdown', () => {
  const rows = [
    { order_id: 1, filled_at: '2026-01-01', realizedPnl: 100, entryPrice: 10, matchedQty: 10 },
    { order_id: 2, filled_at: '2026-01-02', realizedPnl: -40, entryPrice: 20, matchedQty: 5 },
    { order_id: 3, filled_at: '2026-01-03', realizedPnl: 20, entryPrice: 10, matchedQty: 10 },
  ];
  const summary = summarize(rows, [], buildCurve(rows));
  assert.equal(summary.netPnl, 80);
  assert.equal(summary.winRate, 66.67);
  assert.equal(summary.profitFactor, 3);
  assert.equal(summary.maxDrawdown, 40);
  assert.equal(summary.returnPct, 26.6667);
});

test('Sharpe is withheld until at least twenty daily observations', () => {
  const summary = summarize([], [{ realized_pnl: 10, unrealized_pnl: 0, equity_open: 1000 }]);
  assert.equal(summary.sharpe, null);
  assert.equal(summary.sharpeSampleDays, 1);
});
