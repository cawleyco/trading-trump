import fs from 'node:fs';
import { config, enabledFunds } from './config.js';
import {
  insertDecision,
  insertOrder,
  insertSignal,
  getDailyPnl,
  upsertDailyPnl,
  recordKillSwitchTrip,
  getActiveKillSwitchEvent,
} from './db.js';
import { getFundClient, getTradableAsset, isMarketOpen } from './alpacaClient.js';
import { notify } from './notifier.js';
import { log } from './logger.js';

function todayEt() {
  // Trading day keyed to US/Eastern
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export function isGloballyHalted() {
  return fs.existsSync(config.haltFilePath);
}

export function isFundHalted(fundName) {
  return isGloballyHalted() || !!getActiveKillSwitchEvent(fundName);
}

export function fundHaltReason(fundName) {
  if (isGloballyHalted()) return 'manual HALT file present (global)';
  const event = getActiveKillSwitchEvent(fundName);
  if (event) return `circuit breaker tripped: ${event.reason} (at ${event.tripped_at})`;
  return null;
}

/**
 * Update one fund's P&L and trip its circuit breaker if the daily loss limit
 * is breached. Returns the fund's day P&L in USD (negative = losing).
 */
export async function refreshFundPnl(fund) {
  const client = getFundClient(fund.name);
  const account = await client.getAccount();
  const equity = Number(account.equity);
  const lastEquity = Number(account.last_equity); // equity at previous close
  const tradeDate = todayEt();

  const existing = getDailyPnl(tradeDate, fund.name);
  const equityOpen = existing?.equity_open ?? lastEquity;
  const dayPnl = equity - equityOpen;

  upsertDailyPnl({
    tradeDate,
    fund: fund.name,
    realizedPnl: dayPnl, // combined day change; Alpaca doesn't split realized/unrealized cheaply
    unrealizedPnl: 0,
    equityOpen,
  });

  const lossUsd = -Math.min(dayPnl, 0);
  const lossPct = equityOpen > 0 ? (lossUsd / equityOpen) * 100 : 0;

  if (
    !getActiveKillSwitchEvent(fund.name) &&
    (lossUsd > fund.risk.maxDailyLossUsd || lossPct > fund.risk.maxDailyLossPct)
  ) {
    const reason = `daily loss $${lossUsd.toFixed(2)} (${lossPct.toFixed(2)}%) exceeded limit ` +
      `($${fund.risk.maxDailyLossUsd} / ${fund.risk.maxDailyLossPct}%)`;
    recordKillSwitchTrip(reason, fund.name);
    log.error('risk', `[${fund.name}] CIRCUIT BREAKER TRIPPED — ${reason}. Cancelling open orders.`);
    notify('Circuit breaker tripped', `Fund "${fund.name}": ${reason}`);
    try {
      await client.cancelAllOrders();
    } catch (err) {
      log.error('risk', `[${fund.name}] failed to cancel open orders after trip: ${err.message}`);
    }
  }

  return dayPnl;
}

export async function refreshAllFundsPnl() {
  for (const fund of enabledFunds) {
    try {
      await refreshFundPnl(fund);
    } catch (err) {
      log.error('risk', `[${fund.name}] P&L refresh failed: ${err.message}`);
    }
  }
}

/**
 * Evaluate a signal for ONE fund: run every safety check, persist the
 * decision, and (if approved) submit or simulate the order.
 */
async function processSignalForFund(signal, signalId, fund) {
  const reject = (reason) => {
    insertDecision({ signalId, fund: fund.name, approved: false, reason });
    log.info('risk', `[${fund.name}] REJECTED ${signal.ticker} ${signal.direction}: ${reason}`, { signalId });
    return { fund: fund.name, approved: false, reason, signalId };
  };

  try {
    // 1. Kill switches (global HALT file + this fund's circuit breaker)
    if (isFundHalted(fund.name)) return reject(fundHaltReason(fund.name));

    // 2. Confidence gating with this fund's own threshold
    if (
      signal.source === 'sentiment' &&
      (signal.confidence ?? 0) < fund.sentimentConfidenceThreshold
    ) {
      return reject(
        `confidence ${signal.confidence} below fund threshold ${fund.sentimentConfidenceThreshold}`
      );
    }

    // 3. Market hours
    if (!(await isMarketOpen())) return reject('market is closed');

    // 4. Refresh this fund's P&L and re-check the breaker with fresh numbers
    await refreshFundPnl(fund);
    if (isFundHalted(fund.name)) return reject(fundHaltReason(fund.name));

    // 5. Symbol tradable on Alpaca?
    const asset = await getTradableAsset(signal.ticker);
    if (!asset) return reject(`ticker ${signal.ticker} not tradable on Alpaca`);

    const client = getFundClient(fund.name);
    const account = await client.getAccount();
    const equity = Number(account.equity);
    const positions = await client.getPositions();

    // 6. Sells only close existing long positions — this system never shorts.
    const position = positions.find((p) => p.symbol === signal.ticker);
    if (signal.direction === 'sell' && !position) {
      return reject(`no open position in ${signal.ticker} to sell (shorting disabled)`);
    }

    // 7. Exposure caps (buys only; auto-exit sells always reduce exposure)
    if (signal.direction === 'buy') {
      if (positions.length >= fund.risk.maxOpenPositions) {
        return reject(`max open positions reached (${fund.risk.maxOpenPositions})`);
      }
      const totalExposure = positions.reduce((sum, p) => sum + Math.abs(Number(p.market_value)), 0);
      if (totalExposure >= fund.risk.maxTotalExposureUsd) {
        return reject(
          `total exposure $${totalExposure.toFixed(2)} at/above cap $${fund.risk.maxTotalExposureUsd}`
        );
      }
    }

    // 8. Position sizing: smaller of hard $ cap and % of equity
    const pctCap = (fund.risk.maxTradePctEquity / 100) * equity;
    let notionalUsd = Math.min(fund.risk.maxTradeNotionalUsd, pctCap);
    if (signal.direction === 'sell') {
      // Close up to the whole position, never more than we hold
      notionalUsd = signal.source === 'auto-exit'
        ? Math.abs(Number(position.market_value))
        : Math.min(Math.abs(Number(position.market_value)), notionalUsd * 10);
    }
    if (notionalUsd < 1) return reject(`computed notional $${notionalUsd.toFixed(2)} below $1 minimum`);

    const decisionId = insertDecision({
      signalId,
      fund: fund.name,
      approved: true,
      reason: `passed all checks; sized at $${notionalUsd.toFixed(2)}`,
      notionalUsd,
    });

    // 9. Dry-run gate — the last line before real money moves
    if (!config.isLive) {
      insertOrder({
        decisionId,
        fund: fund.name,
        ticker: signal.ticker,
        side: signal.direction,
        notionalUsd,
        status: 'simulated',
      });
      log.info('risk', `[${fund.name}] DRY RUN — would ${signal.direction} $${notionalUsd.toFixed(2)} of ${signal.ticker}`, { signalId });
      return { fund: fund.name, approved: true, simulated: true, notionalUsd, signalId };
    }

    const order = await client.submitNotionalOrder({
      ticker: signal.ticker,
      side: signal.direction,
      notionalUsd,
    });
    insertOrder({
      decisionId,
      fund: fund.name,
      alpacaOrderId: order.id,
      ticker: signal.ticker,
      side: signal.direction,
      notionalUsd,
      status: 'submitted',
    });
    log.info('risk', `[${fund.name}] LIVE ORDER submitted: ${signal.direction} $${notionalUsd.toFixed(2)} ${signal.ticker}`, {
      signalId,
      alpacaOrderId: order.id,
    });
    notify(
      'Order submitted',
      `[${fund.name}] ${signal.direction} $${notionalUsd.toFixed(2)} ${signal.ticker} (${signal.source})`
    );
    return { fund: fund.name, approved: true, simulated: false, notionalUsd, signalId, alpacaOrderId: order.id };
  } catch (err) {
    log.error('risk', `[${fund.name}] error processing signal for ${signal.ticker}: ${err.message}`, { signalId });
    return reject(`error during processing: ${err.message}`);
  }
}

/**
 * Persist a signal and fan it out to every enabled fund subscribed to its
 * source. `onlyFund` restricts routing (used by auto-exit and test signals).
 * Returns one outcome per fund evaluated.
 */
export async function processSignal(signal, { onlyFund } = {}) {
  const signalId = insertSignal({
    source: signal.source,
    ticker: signal.ticker,
    direction: signal.direction,
    confidence: signal.confidence,
    rationale: signal.rationale,
    rawReference: signal.rawReference,
  });

  const targets = enabledFunds.filter((f) => {
    if (onlyFund) return f.name === onlyFund;
    // auto-exit signals are always fund-targeted; never fan out
    if (signal.source === 'auto-exit') return false;
    return f.sources.includes(signal.source);
  });

  if (targets.length === 0) {
    insertDecision({
      signalId,
      fund: onlyFund || 'none',
      approved: false,
      reason: onlyFund ? `fund "${onlyFund}" not found/enabled` : 'no enabled fund subscribes to this source',
    });
    return [];
  }

  const outcomes = [];
  for (const fund of targets) {
    outcomes.push(await processSignalForFund(signal, signalId, fund));
  }
  return outcomes;
}
