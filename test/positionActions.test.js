import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmPositionAction, previewPositionAction } from '../server/positionActions.js';
import { db } from '../server/db.js';

const FUND = { name: 'position-action-test', paper: true, risk: {}, sources: [], autoExit: null };

function dependencies(position = { symbol: 'AAPL', qty: '10', current_price: '100', avg_entry_price: '90', market_value: '1000' }) {
  const submitted = [];
  return {
    submitted,
    funds: [FUND], isLive: false, isFundHalted: () => false, isMarketOpen: async () => true,
    getFundClient: () => ({
      getPosition: async () => position,
      submitQuantityOrder: async (order) => { submitted.push(order); return { id: 'broker-1' }; },
      getOpenOrders: async () => [], cancelOrder: async () => {},
    }),
  };
}

function cleanup(key) {
  const action = db.prepare(`SELECT response_json FROM position_actions WHERE idempotency_key = ?`).get(key);
  const response = action?.response_json ? JSON.parse(action.response_json) : null;
  if (response?.signalId) {
    db.prepare(`DELETE FROM orders WHERE decision_id IN (SELECT id FROM decisions WHERE signal_id = ?)`).run(response.signalId);
    db.prepare(`DELETE FROM decisions WHERE signal_id = ?`).run(response.signalId);
    db.prepare(`DELETE FROM signals WHERE id = ?`).run(response.signalId);
  }
  db.prepare(`DELETE FROM position_actions WHERE idempotency_key = ?`).run(key);
}

test('reduce preview and confirmation use the verified position quantity', async () => {
  const deps = dependencies();
  const key = `pa_test_${Date.now()}`;
  try {
    const preview = await previewPositionAction({ fund: FUND.name, ticker: 'AAPL', action: 'reduce', quantity: 3 }, deps);
    assert.equal(preview.position.qty, 10);
    assert.equal(preview.remainingQty, 7);
    const result = await confirmPositionAction({ fund: FUND.name, ticker: 'AAPL', action: 'reduce', quantity: 3, expectedQty: 10, confirmed: true, idempotencyKey: key }, deps);
    assert.equal(result.status, 'simulated');
    assert.equal(result.remainingQty, 7);
    assert.equal(deps.submitted.length, 0);
  } finally { cleanup(key); }
});

test('confirmation refuses a stale position snapshot', async () => {
  const deps = dependencies();
  await assert.rejects(
    confirmPositionAction({ fund: FUND.name, ticker: 'AAPL', action: 'close', expectedQty: 9, confirmed: true, idempotencyKey: `stale_${Date.now()}` }, deps),
    /position changed since preview/
  );
});

test('completed idempotency keys replay without a second action', async () => {
  const deps = dependencies();
  const key = `replay_${Date.now()}`;
  const body = { fund: FUND.name, ticker: 'AAPL', action: 'close', expectedQty: 10, confirmed: true, idempotencyKey: key };
  try {
    const first = await confirmPositionAction(body, deps);
    const second = await confirmPositionAction(body, deps);
    assert.equal(second.orderId, first.orderId);
    assert.equal(second.idempotentReplay, true);
  } finally { cleanup(key); }
});

test('closing a short submits buy-to-cover, not sell', async () => {
  const short = { symbol: 'AAPL', qty: '-4', side: 'short', current_price: '100', avg_entry_price: '110', market_value: '-400' };
  const deps = dependencies(short);
  deps.isLive = true;
  const key = `short_close_${Date.now()}`;
  try {
    const preview = await previewPositionAction({ fund: FUND.name, ticker: 'AAPL', action: 'close' }, deps);
    assert.equal(preview.positionSide, 'short');
    assert.equal(preview.closeSide, 'buy');
    const result = await confirmPositionAction({
      fund: FUND.name, ticker: 'AAPL', action: 'close', expectedQty: 4, confirmed: true, idempotencyKey: key,
    }, deps);
    assert.equal(result.side, 'buy');
    assert.equal(deps.submitted.length, 1);
    assert.equal(deps.submitted[0].side, 'buy');
    assert.equal(deps.submitted[0].qty, 4);
  } finally { cleanup(key); }
});

test('reducing a long still sells', async () => {
  const deps = dependencies();
  deps.isLive = true;
  const key = `long_reduce_${Date.now()}`;
  try {
    const result = await confirmPositionAction({
      fund: FUND.name, ticker: 'AAPL', action: 'reduce', quantity: 3, expectedQty: 10, confirmed: true, idempotencyKey: key,
    }, deps);
    assert.equal(result.side, 'sell');
    assert.equal(deps.submitted[0].side, 'sell');
  } finally { cleanup(key); }
});
