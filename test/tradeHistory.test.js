import test from 'node:test';
import assert from 'node:assert/strict';
import {
  db,
  insertDecision,
  insertOrder,
  insertSignal,
  listTradeHistory,
  matchClosedOrders,
} from '../server/db.js';

test('matchClosedOrders FIFO-matches a sell across multiple entry lots', () => {
  const outcomes = matchClosedOrders([
    { order_id: 1, fund: 'paper', ticker: 'ABC', side: 'buy', qty: 2, price: 10, filled_at: '2026-01-01T00:00:00Z' },
    { order_id: 2, fund: 'paper', ticker: 'ABC', side: 'buy', qty: 2, price: 20, filled_at: '2026-01-03T00:00:00Z' },
    { order_id: 3, fund: 'paper', ticker: 'ABC', side: 'sell', qty: 3, price: 30, filled_at: '2026-01-05T00:00:00Z' },
  ]);
  assert.deepEqual(outcomes.get(3), {
    entryPrice: 40 / 3,
    exitPrice: 30,
    realizedPnl: 50,
    returnPct: 125,
    matchedQty: 3,
    holdingDays: 3.33,
  });
});

test('matchClosedOrders isolates lots by fund and ticker', () => {
  const outcomes = matchClosedOrders([
    { order_id: 1, fund: 'one', ticker: 'ABC', side: 'buy', qty: 1, price: 10, filled_at: '2026-01-01T00:00:00Z' },
    { order_id: 2, fund: 'two', ticker: 'ABC', side: 'sell', qty: 1, price: 20, filled_at: '2026-01-02T00:00:00Z' },
    { order_id: 3, fund: 'one', ticker: 'XYZ', side: 'sell', qty: 1, price: 20, filled_at: '2026-01-02T00:00:00Z' },
  ]);
  assert.equal(outcomes.get(2).realizedPnl, null);
  assert.equal(outcomes.get(3).realizedPnl, null);
});

test('matchClosedOrders leaves an unmatched remainder open for later closes', () => {
  const outcomes = matchClosedOrders([
    { order_id: 1, fund: 'paper', ticker: 'ABC', side: 'buy', qty: 5, price: 10, filled_at: '2026-01-01T00:00:00Z' },
    { order_id: 2, fund: 'paper', ticker: 'ABC', side: 'sell', qty: 2, price: 15, filled_at: '2026-01-02T00:00:00Z' },
    { order_id: 3, fund: 'paper', ticker: 'ABC', side: 'sell', qty: 3, price: 20, filled_at: '2026-01-03T00:00:00Z' },
  ]);
  assert.equal(outcomes.get(2).realizedPnl, 10);
  assert.equal(outcomes.get(3).realizedPnl, 30);
});

test('listTradeHistory date filters use fill date, not decision date', () => {
  const fund = `trade-history-${Date.now()}`;
  const alpacaOrderId = `fill-date-${Date.now()}`;
  let signalId;
  let orderId;
  try {
    signalId = insertSignal({
      source: 'manual',
      ticker: 'TSLA',
      direction: 'buy',
      confidence: 1,
      rationale: 'date-filter test',
    });
    const decisionId = insertDecision({
      signalId,
      fund,
      approved: true,
      reason: 'approved for date-filter test',
      notionalUsd: 100,
    });
    // Backdate the decision so a decision-date filter would exclude this row.
    db.prepare(`UPDATE decisions SET created_at = '2026-01-01 12:00:00' WHERE id = ?`).run(decisionId);
    orderId = insertOrder({
      decisionId,
      fund,
      alpacaOrderId,
      ticker: 'TSLA',
      side: 'buy',
      notionalUsd: 100,
      status: 'filled',
    });
    db.prepare(`UPDATE orders SET submitted_at = '2026-01-01 12:05:00' WHERE id = ?`).run(orderId);
    db.prepare(
      `INSERT INTO fills (order_id, alpaca_order_id, filled_qty, filled_avg_price, filled_at)
       VALUES (?, ?, 1, 100, '2026-03-15 14:30:00')`
    ).run(orderId, alpacaOrderId);

    const byFillWindow = listTradeHistory({ fund, from: '2026-03-01', to: '2026-03-31', limit: 20 });
    assert.equal(byFillWindow.total, 1);
    assert.equal(byFillWindow.rows[0].orderId, orderId);
    assert.equal(byFillWindow.rows[0].filledAt, '2026-03-15 14:30:00');

    const byDecisionWindow = listTradeHistory({ fund, from: '2026-01-01', to: '2026-01-31', limit: 20 });
    assert.equal(byDecisionWindow.total, 0);
  } finally {
    if (orderId) {
      db.prepare(`DELETE FROM fills WHERE order_id = ?`).run(orderId);
      db.prepare(`DELETE FROM orders WHERE id = ?`).run(orderId);
    }
    if (signalId) {
      db.prepare(`DELETE FROM decisions WHERE signal_id = ?`).run(signalId);
      db.prepare(`DELETE FROM signals WHERE id = ?`).run(signalId);
    }
  }
});
