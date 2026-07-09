import { enabledFunds } from './config.js';
import { db } from './db.js';
import { getFundClient, isMarketOpen } from './alpacaClient.js';
import { makeTradeSignal } from './signal.js';
import { processSignal, isFundHalted } from './riskManager.js';
import { notify } from './notifier.js';
import { log } from './logger.js';

// Auto-exit: without this, a position only ever closes if the politician
// sells or sentiment says sell. Each fund can set stopLossPct / takeProfitPct
// / maxHoldDays in funds.json; breaches close the position through the normal
// pipeline (respects kill switches and dry-run).

const CHECK_INTERVAL_MS = 5 * 60_000;

function positionAgeDays(fundName, ticker) {
  const row = db
    .prepare(
      `SELECT MIN(submitted_at) AS first_buy FROM orders
       WHERE fund = ? AND ticker = ? AND side = 'buy'
         AND status IN ('submitted', 'filled', 'partially_filled', 'simulated')`
    )
    .get(fundName, ticker);
  if (!row?.first_buy) return null; // position predates the bot / unknown
  return (Date.now() - new Date(row.first_buy + 'Z').getTime()) / 86400_000;
}

/**
 * Entry/current prices for an Alpaca position, or null when they can't be
 * established. A zero/absent qty with a nonzero market_value would otherwise
 * divide to Infinity, sail past a truthiness check, and trigger a phantom
 * take-profit — prices must be finite and positive or the position is skipped.
 */
export function _positionPrices(p) {
  const entry = Number(p.avg_entry_price);
  const qty = Number(p.qty);
  const current =
    p.current_price != null ? Number(p.current_price) : qty ? Number(p.market_value) / qty : NaN;
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(current) || current <= 0) return null;
  return { entry, current };
}

export function _exitReason({ entry, current, ageDays }, { stopLossPct, takeProfitPct, maxHoldDays }) {
  const movePct = ((current - entry) / entry) * 100;
  if (stopLossPct != null && movePct <= -stopLossPct) {
    return `stop-loss: ${movePct.toFixed(1)}% ≤ -${stopLossPct}%`;
  }
  if (takeProfitPct != null && movePct >= takeProfitPct) {
    return `take-profit: ${movePct.toFixed(1)}% ≥ +${takeProfitPct}%`;
  }
  if (maxHoldDays != null && Number.isFinite(ageDays) && ageDays > maxHoldDays) {
    return `max hold: ${Math.floor(ageDays)}d > ${maxHoldDays}d`;
  }
  return null;
}

async function checkFund(fund) {
  if (isFundHalted(fund.name)) return;
  const positions = await getFundClient(fund.name).getPositions();

  for (const p of positions) {
    const prices = _positionPrices(p);
    if (!prices) continue;
    const { entry, current } = prices;
    const movePct = ((current - entry) / entry) * 100;
    const ageDays = positionAgeDays(fund.name, p.symbol);

    const reason = _exitReason({ entry, current, ageDays }, fund.autoExit);
    if (!reason) continue;

    log.info('auto-exit', `[${fund.name}] closing ${p.symbol}: ${reason}`);
    const signal = makeTradeSignal({
      source: 'auto-exit',
      ticker: p.symbol,
      direction: 'sell',
      rationale: `auto-exit ${reason} (entry $${entry.toFixed(2)}, now $${current.toFixed(2)})`,
      rawReference: { fund: fund.name, entry, current, movePct, ageDays },
    });
    const outcomes = await processSignal(signal, { onlyFund: fund.name });
    if (outcomes.some((o) => o.approved)) {
      notify('Auto-exit', `[${fund.name}] closing ${p.symbol} — ${reason}`);
    }
  }
}

export async function runAutoExitCheck() {
  try {
    if (!(await isMarketOpen())) return;
  } catch (err) {
    log.error('auto-exit', `Market clock check failed: ${err.message}`);
    return;
  }
  for (const fund of enabledFunds) {
    if (!fund.autoExit) continue;
    try {
      await checkFund(fund);
    } catch (err) {
      log.error('auto-exit', `[${fund.name}] check failed: ${err.message}`);
    }
  }
}

export function startPositionManager() {
  const withAutoExit = enabledFunds.filter((f) => f.autoExit);
  if (withAutoExit.length === 0) {
    log.info('auto-exit', 'No funds have autoExit configured — position manager idle');
    return null;
  }
  log.info('auto-exit', `Position manager watching: ${withAutoExit.map((f) => f.name).join(', ')} (every 5 min during market hours)`);
  runAutoExitCheck();
  return setInterval(runAutoExitCheck, CHECK_INTERVAL_MS);
}
