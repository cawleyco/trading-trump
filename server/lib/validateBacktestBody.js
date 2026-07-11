// Shared request-body validation for the backtest POST endpoints. Throws
// Error with a user-facing message; routes translate that into a 400. Keeps
// NaN/negative/malformed params out of the simulation core, where they would
// otherwise flow into applyCosts and produce NaN P&L.

export const EXIT_RULES = ['follow', 'hold_30', 'hold_90', 'hold_to_present'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function positiveNumber(value, name, { integer = false, max = null } = {}) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  if (integer && !Number.isInteger(n)) throw new Error(`${name} must be a whole number`);
  if (max != null && n > max) throw new Error(`${name} must be at most ${max}`);
  return n;
}

/**
 * Validate and normalize the fields shared by all backtest requests.
 * Returns normalized values; endpoint-specific defaults stay at the route.
 */
export function validateBacktestBody(body = {}) {
  const startDate = String(body.startDate ?? '');
  const endDate = String(body.endDate ?? '');
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    throw new Error('startDate and endDate must be YYYY-MM-DD');
  }
  if (startDate > endDate) throw new Error('startDate must be on or before endDate');

  const notionalPerTrade = positiveNumber(body.notionalPerTrade, 'notionalPerTrade');
  if (notionalPerTrade == null) throw new Error('notionalPerTrade must be a positive number');

  let exitRule = null;
  if (body.exitRule != null && body.exitRule !== '') {
    if (!EXIT_RULES.includes(body.exitRule)) {
      throw new Error(`exitRule must be one of ${EXIT_RULES.join(', ')}`);
    }
    exitRule = body.exitRule;
  }

  return {
    startDate,
    endDate,
    notionalPerTrade,
    exitRule,
    stopLossPct: positiveNumber(body.stopLossPct, 'stopLossPct'),
    takeProfitPct: positiveNumber(body.takeProfitPct, 'takeProfitPct'),
    holdDays: positiveNumber(body.holdDays, 'holdDays', { integer: true }),
    holdHours: positiveNumber(body.holdHours, 'holdHours'),
    maxPosts: positiveNumber(body.maxPosts, 'maxPosts', { integer: true }),
    minTrades: positiveNumber(body.minTrades, 'minTrades', { integer: true }),
    folds: positiveNumber(body.folds, 'folds', { integer: true }),
    topN: positiveNumber(body.topN, 'topN', { integer: true }),
    confidenceThreshold: positiveNumber(body.confidenceThreshold, 'confidenceThreshold', { max: 1 }),
  };
}
