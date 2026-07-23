import { config, enabledFunds } from './config.js';
import {
  beginPositionAction, finishPositionAction, getPositionAction, getPositionExitRule,
  insertDecision, insertOrder, insertSignal, upsertPositionExitRule,
} from './db.js';
import { getFundClient, isMarketOpen } from './alpacaClient.js';
import { isFundHalted, fundHaltReason } from './riskManager.js';

const ACTIONS = new Set(['close', 'reduce', 'update-exit', 'cancel-orders']);

export async function previewPositionAction(body, deps = {}) {
  const context = await validate(body, deps);
  return {
    approved: true,
    action: context.action,
    fund: context.fund.name,
    ticker: context.ticker,
    paper: !!context.fund.paper,
    executionMode: context.isLive ? 'broker' : 'simulated',
    position: snapshot(context.position),
    positionSide: context.positionSide,
    closeSide: context.closeSide,
    quantity: context.quantity,
    remainingQty: context.quantity == null ? null : round(context.positionQty - context.quantity, 8),
    exitRule: context.exitRule,
    warning: context.isLive && !context.fund.paper ? 'This confirmation can move real money.' : null,
  };
}

export async function confirmPositionAction(body, deps = {}) {
  if (body.confirmed !== true) throw new Error('confirmed=true is required');
  const key = String(body.idempotencyKey || '');
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(key)) throw new Error('a valid idempotencyKey is required');
  const existing = getPositionAction(key);
  if (existing?.status === 'completed') return { ...existing.response, idempotentReplay: true };
  if (existing?.status === 'pending') throw new Error('this position action is already in progress');
  if (existing?.status === 'failed') throw new Error(`the previous action with this idempotency key failed: ${existing.response?.error || 'unknown error'}; preview again`);

  const context = await validate(body, deps);
  const expectedQty = Number(body.expectedQty);
  if (!Number.isFinite(expectedQty) || Math.abs(expectedQty - context.positionQty) > 1e-8) {
    throw new Error(`position changed since preview (expected ${body.expectedQty}, now ${context.positionQty}); preview again`);
  }
  try {
    beginPositionAction({ idempotencyKey: key, fund: context.fund.name, ticker: context.ticker, action: context.action, request: body });
  } catch (error) {
    if (String(error.code).startsWith('SQLITE_CONSTRAINT')) {
      const raced = getPositionAction(key);
      if (raced?.status === 'completed') return { ...raced.response, idempotentReplay: true };
      throw new Error('this position action is already in progress');
    }
    throw error;
  }

  try {
    let response;
    if (context.action === 'update-exit') {
      const rule = upsertPositionExitRule({ fund: context.fund.name, ticker: context.ticker, ...context.exitRule });
      response = { action: context.action, fund: context.fund.name, ticker: context.ticker, status: 'completed', rule };
    } else if (context.action === 'cancel-orders') {
      const orders = await context.client.getOpenOrders(context.ticker);
      if (context.isLive) await Promise.all((orders || []).map((order) => context.client.cancelOrder(order.id)));
      response = { action: context.action, fund: context.fund.name, ticker: context.ticker, status: context.isLive ? 'submitted' : 'simulated', canceledOrders: (orders || []).map((order) => order.id) };
    } else {
      response = await executeReduction(context, key);
    }
    finishPositionAction(key, 'completed', response);
    return response;
  } catch (error) {
    finishPositionAction(key, 'failed', { error: error.message });
    throw error;
  }
}

async function executeReduction(context, key) {
  const side = context.closeSide; // sell to close long; buy to cover short
  const rationale = `manual ${context.action} of ${context.quantity} ${context.ticker} from Active Trades`;
  const signalId = insertSignal({ source: 'manual', ticker: context.ticker, direction: side, confidence: 1, rationale, rawReference: { positionAction: context.action, idempotencyKey: key, expectedQty: context.positionQty, positionSide: context.positionSide } });
  const decisionId = insertDecision({ signalId, fund: context.fund.name, approved: true, reason: `confirmed position action; position quantity verified at ${context.positionQty}`, notionalUsd: context.quantity * Number(context.position.current_price || 0), checks: [
    { check: 'halt', pass: true, detail: 'not halted' },
    { check: 'market-open', pass: true, detail: 'market is open' },
    { check: 'stale-position', pass: true, detail: `quantity remains ${context.positionQty}` },
    { check: 'confirmation', pass: true, detail: 'explicit preview and confirmation received' },
  ] });
  let brokerOrder = null;
  let status = 'simulated';
  try {
    if (context.isLive) {
      brokerOrder = await context.client.submitQuantityOrder({ ticker: context.ticker, side, qty: context.quantity, clientOrderId: `pa-${key}`.slice(0, 48) });
      status = 'submitted';
    }
    const orderId = insertOrder({ decisionId, fund: context.fund.name, alpacaOrderId: brokerOrder?.id, ticker: context.ticker, side, notionalUsd: context.quantity * Number(context.position.current_price || 0), status });
    return { action: context.action, fund: context.fund.name, ticker: context.ticker, quantity: context.quantity, remainingQty: round(context.positionQty - context.quantity, 8), status, signalId, decisionId, orderId, brokerOrderId: brokerOrder?.id || null, side };
  } catch (error) {
    insertOrder({ decisionId, fund: context.fund.name, alpacaOrderId: brokerOrder?.id, ticker: context.ticker, side, notionalUsd: context.quantity * Number(context.position.current_price || 0), status: 'error' });
    throw error;
  }
}

async function validate(body, deps) {
  const action = String(body.action || '');
  if (!ACTIONS.has(action)) throw new Error(`action must be one of: ${[...ACTIONS].join(', ')}`);
  const fund = (deps.funds || enabledFunds).find((item) => item.name === body.fund);
  if (!fund) throw new Error(`unknown fund "${body.fund}"`);
  const ticker = String(body.ticker || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) throw new Error('valid ticker is required');
  const halted = (deps.isFundHalted || isFundHalted)(fund.name);
  if (halted) throw new Error((deps.fundHaltReason || fundHaltReason)(fund.name) || 'fund is halted');
  const marketOpen = await (deps.isMarketOpen || isMarketOpen)();
  if (action !== 'update-exit' && !marketOpen) throw new Error('market is closed');
  const client = (deps.getFundClient || getFundClient)(fund.name);
  let position;
  try { position = await client.getPosition(ticker); } catch { throw new Error(`no open position in ${ticker}`); }
  const positionQty = Math.abs(Number(position.qty));
  if (!(positionQty > 0)) throw new Error(`no open position in ${ticker}`);
  const positionSide = Number(position.qty) < 0 || String(position.side || '').toLowerCase() === 'short' ? 'short' : 'long';
  const closeSide = positionSide === 'short' ? 'buy' : 'sell';
  let quantity = null;
  if (action === 'close') quantity = positionQty;
  if (action === 'reduce') {
    quantity = Number(body.quantity);
    if (!(quantity > 0) || quantity >= positionQty) throw new Error(`reduce quantity must be greater than zero and less than current quantity ${positionQty}`);
  }
  const exitRule = action === 'update-exit' ? normalizeRule(body) : getPositionExitRule(fund.name, ticker);
  return { action, fund, ticker, client, position, positionQty, positionSide, closeSide, quantity, exitRule, isLive: deps.isLive ?? config.isLive };
}

function normalizeRule(body) {
  const rule = {};
  for (const [input, output] of [['stopLossPct', 'stopLossPct'], ['takeProfitPct', 'takeProfitPct'], ['maxHoldDays', 'maxHoldDays']]) {
    const value = body[input];
    if (value == null || value === '') rule[output] = null;
    else {
      const number = Number(value);
      const max = input === 'maxHoldDays' ? 3650 : 100;
      if (!(number > 0) || number > max) throw new Error(`${input} must be greater than zero and at most ${max}`);
      rule[output] = number;
    }
  }
  return rule;
}
function snapshot(position) { return { qty: Math.abs(Number(position.qty)), avgEntry: Number(position.avg_entry_price), currentPrice: Number(position.current_price), marketValue: Math.abs(Number(position.market_value)) }; }
function round(value, digits) { return Number(Number(value).toFixed(digits)); }
