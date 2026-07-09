import fs from 'node:fs';
import { config, enabledFunds } from './config.js';
import {
  countOrdersForFundSince,
  countRecentOrders,
  getCongressTradeByKey,
  insertDecision,
  insertOrder,
  insertSignal,
  getDailyPnl,
  getTickerMeta,
  isTradeInPendingReview,
  upsertDailyPnl,
  recordKillSwitchTrip,
  getActiveKillSwitchEvent,
} from './db.js';
import { getFundClient, getTradableAsset, isMarketOpen } from './alpacaClient.js';
import { avgDollarVolume } from './marketData.js';
import { notify } from './notifier.js';
import { log } from './logger.js';

function todayEt() {
  // Trading day keyed to US/Eastern
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function sqliteTimestamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function minutesAgoTimestamp(minutes) {
  return sqliteTimestamp(new Date(Date.now() - Number(minutes) * 60_000));
}

function etDayStartTimestamp() {
  return `${todayEt()} 00:00:00`;
}

function configured(value) {
  return value !== undefined && value !== null && value !== '';
}

function riskValue(fund, key) {
  return fund.risk?.[key];
}

function sourceTradeKey(signal) {
  return signal.rawReference?.tradeKey ?? signal.rawReference?.trade_key ?? null;
}

function strategyActionMode(signal) {
  return signal.rawReference?.strategy?.action?.mode ?? null;
}

export function checkSectorExposure({ capPct, tickerSector, positions = [], equity, buyNotionalUsd }) {
  if (!configured(capPct)) return { skipped: true, pass: true, detail: 'skipped: no maxSectorExposurePct configured' };
  if (!tickerSector) return { skipped: true, pass: true, detail: 'skipped: no sector metadata for ticker' };
  if (!(Number(equity) > 0)) return { pass: false, detail: 'equity is unavailable for sector exposure check' };
  const currentSectorExposure = positions
    .filter((p) => p.sector === tickerSector)
    .reduce((sum, p) => sum + Math.abs(Number(p.marketValue ?? p.market_value ?? 0)), 0);
  const afterUsd = currentSectorExposure + Math.max(Number(buyNotionalUsd) || 0, 0);
  const afterPct = (afterUsd / Number(equity)) * 100;
  return {
    pass: afterPct <= Number(capPct),
    detail: `${tickerSector} exposure would be ${afterPct.toFixed(2)}% ($${afterUsd.toFixed(2)}) vs cap ${capPct}%`,
  };
}

export function checkAvgDollarVolume({ minimum, observed }) {
  if (!configured(minimum)) return { skipped: true, pass: true, detail: 'skipped: no minAvgDollarVolume configured' };
  if (observed == null) return { pass: false, detail: 'average dollar volume unavailable' };
  return {
    pass: Number(observed) >= Number(minimum),
    detail: `ADV $${Number(observed).toFixed(0)} vs minimum $${Number(minimum).toFixed(0)}`,
  };
}

export function checkCooldown({ cooldownMinutes, recentOrders }) {
  if (!configured(cooldownMinutes)) return { skipped: true, pass: true, detail: 'skipped: no cooldownMinutes configured' };
  return {
    pass: Number(recentOrders) === 0,
    detail: `${recentOrders} order(s) for this ticker in the last ${cooldownMinutes} minute(s)`,
  };
}

export function checkMaxTradesPerDay({ maxTradesPerDay, tradesToday }) {
  if (!configured(maxTradesPerDay)) return { skipped: true, pass: true, detail: 'skipped: no maxTradesPerDay configured' };
  return {
    pass: Number(tradesToday) < Number(maxTradesPerDay),
    detail: `${tradesToday}/${maxTradesPerDay} approved order(s) today`,
  };
}

export function checkBlockOptions({ blockOptions = true, isOption }) {
  if (blockOptions === false) return { skipped: true, pass: true, detail: 'skipped: blockOptions disabled' };
  return {
    pass: !isOption,
    detail: isOption ? 'source congress trade is an option' : 'source congress trade is not an option',
  };
}

export function checkMinCopyScoreAuto({ minimum, mode, copyScore }) {
  if (mode !== 'auto') return { skipped: true, pass: true, detail: 'skipped: signal is not from an auto strategy' };
  if (!configured(minimum)) return { skipped: true, pass: true, detail: 'skipped: no minCopyScoreAuto configured' };
  return {
    pass: Number(copyScore) >= Number(minimum),
    detail: `auto copy score ${copyScore ?? 'missing'} vs minimum ${minimum}`,
  };
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
  const checks = [];
  const recordCheck = (check, result) => {
    checks.push({ check, pass: !!result.pass, detail: result.detail });
    return result;
  };
  const reject = (reason) => {
    insertDecision({ signalId, fund: fund.name, approved: false, reason, checks });
    log.info('risk', `[${fund.name}] REJECTED ${signal.ticker} ${signal.direction}: ${reason}`, { signalId });
    return { fund: fund.name, approved: false, reason, signalId };
  };

  try {
    // 1. Kill switches (global HALT file + this fund's circuit breaker)
    const haltReason = fundHaltReason(fund.name);
    recordCheck('halt', { pass: !haltReason, detail: haltReason || 'not halted' });
    if (haltReason) return reject(haltReason);

    // 2. Confidence gating with this fund's own threshold
    if (
      signal.source === 'sentiment' &&
      (signal.confidence ?? 0) < fund.sentimentConfidenceThreshold
    ) {
      recordCheck('confidence', {
        pass: false,
        detail: `confidence ${signal.confidence} below fund threshold ${fund.sentimentConfidenceThreshold}`,
      });
      return reject(
        `confidence ${signal.confidence} below fund threshold ${fund.sentimentConfidenceThreshold}`
      );
    }
    recordCheck('confidence', signal.source === 'sentiment'
      ? { pass: true, detail: `confidence ${signal.confidence} >= fund threshold ${fund.sentimentConfidenceThreshold}` }
      : { pass: true, detail: 'skipped: non-sentiment signal' });

    // 3. Market hours
    const marketOpen = await isMarketOpen();
    recordCheck('market-open', { pass: marketOpen, detail: marketOpen ? 'market is open' : 'market is closed' });
    if (!marketOpen) return reject('market is closed');

    // 4. Refresh this fund's P&L and re-check the breaker with fresh numbers
    await refreshFundPnl(fund);
    const freshHaltReason = fundHaltReason(fund.name);
    recordCheck('daily-pnl-circuit-breaker', { pass: !freshHaltReason, detail: freshHaltReason || 'daily loss within limits' });
    if (freshHaltReason) return reject(freshHaltReason);

    // 5. Symbol tradable on Alpaca?
    const asset = await getTradableAsset(signal.ticker);
    recordCheck('tradable', {
      pass: !!asset,
      detail: asset ? `ticker ${signal.ticker} is tradable on Alpaca` : `ticker ${signal.ticker} not tradable on Alpaca`,
    });
    if (!asset) return reject(`ticker ${signal.ticker} not tradable on Alpaca`);

    const client = getFundClient(fund.name);
    const account = await client.getAccount();
    const equity = Number(account.equity);
    const positions = await client.getPositions();
    const maxBuyNotional = Math.min(fund.risk.maxTradeNotionalUsd, (fund.risk.maxTradePctEquity / 100) * equity);

    // 6. Sells only close existing long positions — this system never shorts.
    const position = positions.find((p) => p.symbol === signal.ticker);
    if (signal.direction === 'sell' && !position) {
      recordCheck('no-shorting', { pass: false, detail: `no open position in ${signal.ticker} to sell` });
      return reject(`no open position in ${signal.ticker} to sell (shorting disabled)`);
    }
    recordCheck('no-shorting', signal.direction === 'sell'
      ? { pass: true, detail: `open ${signal.ticker} position exists` }
      : { pass: true, detail: 'skipped: buy signal' });

    // 7. Exposure caps (buys only; auto-exit sells always reduce exposure)
    if (signal.direction === 'buy') {
      if (positions.length >= fund.risk.maxOpenPositions) {
        recordCheck('max-open-positions', { pass: false, detail: `${positions.length}/${fund.risk.maxOpenPositions} positions open` });
        return reject(`max open positions reached (${fund.risk.maxOpenPositions})`);
      }
      recordCheck('max-open-positions', { pass: true, detail: `${positions.length}/${fund.risk.maxOpenPositions} positions open` });
      const totalExposure = positions.reduce((sum, p) => sum + Math.abs(Number(p.market_value)), 0);
      if (totalExposure >= fund.risk.maxTotalExposureUsd) {
        recordCheck('max-total-exposure', {
          pass: false,
          detail: `total exposure $${totalExposure.toFixed(2)} at/above cap $${fund.risk.maxTotalExposureUsd}`,
        });
        return reject(
          `total exposure $${totalExposure.toFixed(2)} at/above cap $${fund.risk.maxTotalExposureUsd}`
        );
      }
      recordCheck('max-total-exposure', {
        pass: true,
        detail: `total exposure $${totalExposure.toFixed(2)} below cap $${fund.risk.maxTotalExposureUsd}`,
      });

      const targetMeta = getTickerMeta(signal.ticker);
      const positionsWithSectors = positions.map((p) => ({
        ...p,
        marketValue: Number(p.market_value),
        sector: getTickerMeta(p.symbol)?.sector ?? null,
      }));
      const sectorResult = recordCheck('max-sector-exposure', checkSectorExposure({
        capPct: riskValue(fund, 'maxSectorExposurePct'),
        tickerSector: targetMeta?.sector ?? null,
        positions: positionsWithSectors,
        equity,
        buyNotionalUsd: maxBuyNotional,
      }));
      if (!sectorResult.pass && !sectorResult.skipped) return reject(sectorResult.detail);

      const adv = configured(riskValue(fund, 'minAvgDollarVolume'))
        ? await avgDollarVolume(signal.ticker)
        : null;
      const advResult = recordCheck('min-avg-dollar-volume', checkAvgDollarVolume({
        minimum: riskValue(fund, 'minAvgDollarVolume'),
        observed: adv,
      }));
      if (!advResult.pass && !advResult.skipped) return reject(advResult.detail);
    }
    if (signal.direction !== 'buy') {
      recordCheck('max-open-positions', { pass: true, detail: 'skipped: sell signal' });
      recordCheck('max-total-exposure', { pass: true, detail: 'skipped: sell signal' });
      recordCheck('max-sector-exposure', { pass: true, detail: 'skipped: sell signal' });
      recordCheck('min-avg-dollar-volume', { pass: true, detail: 'skipped: sell signal' });
    }

    const cooldownMinutes = riskValue(fund, 'cooldownMinutes');
    const cooldownResult = recordCheck('cooldown', checkCooldown({
      cooldownMinutes,
      recentOrders: configured(cooldownMinutes)
        ? countRecentOrders({ fund: fund.name, ticker: signal.ticker, since: minutesAgoTimestamp(cooldownMinutes) })
        : 0,
    }));
    if (!cooldownResult.pass && !cooldownResult.skipped) return reject(cooldownResult.detail);

    const maxTradesPerDay = riskValue(fund, 'maxTradesPerDay');
    const dailyTradesResult = recordCheck('max-trades-per-day', checkMaxTradesPerDay({
      maxTradesPerDay,
      tradesToday: configured(maxTradesPerDay)
        ? countOrdersForFundSince({ fund: fund.name, since: etDayStartTimestamp() })
        : 0,
    }));
    if (!dailyTradesResult.pass && !dailyTradesResult.skipped) return reject(dailyTradesResult.detail);

    const tradeKey = sourceTradeKey(signal);
    const sourceTrade = tradeKey ? getCongressTradeByKey(tradeKey) : null;
    const optionResult = recordCheck('block-options', sourceTrade
      ? checkBlockOptions({ blockOptions: riskValue(fund, 'blockOptions') ?? true, isOption: !!sourceTrade.is_option })
      : { skipped: true, pass: true, detail: 'skipped: no archived source trade' });
    if (!optionResult.pass && !optionResult.skipped) return reject(optionResult.detail);

    const mode = strategyActionMode(signal);
    if (mode === 'auto' && tradeKey && isTradeInPendingReview(tradeKey)) {
      recordCheck('pending-human-review', { pass: false, detail: 'auto strategy source trade is unresolved in review_queue' });
      return reject('pending-human-review');
    }
    recordCheck('pending-human-review', mode === 'auto'
      ? { pass: true, detail: 'auto strategy source trade is not pending human review' }
      : { pass: true, detail: 'skipped: signal is not from an auto strategy' });

    const minAutoResult = recordCheck('min-copy-score-auto', checkMinCopyScoreAuto({
      minimum: riskValue(fund, 'minCopyScoreAuto'),
      mode,
      copyScore: signal.rawReference?.copyScore,
    }));
    if (!minAutoResult.pass && !minAutoResult.skipped) return reject(minAutoResult.detail);

    // 8. Position sizing: smaller of hard $ cap and % of equity
    const pctCap = (fund.risk.maxTradePctEquity / 100) * equity;
    let notionalUsd = Math.min(fund.risk.maxTradeNotionalUsd, pctCap);
    if (signal.direction === 'sell') {
      // Close up to the whole position, never more than we hold
      notionalUsd = signal.source === 'auto-exit'
        ? Math.abs(Number(position.market_value))
        : Math.min(Math.abs(Number(position.market_value)), notionalUsd * 10);
    }
    const sizingPass = notionalUsd >= 1;
    recordCheck('position-sizing', {
      pass: sizingPass,
      detail: sizingPass ? `sized at $${notionalUsd.toFixed(2)}` : `computed notional $${notionalUsd.toFixed(2)} below $1 minimum`,
    });
    if (!sizingPass) return reject(`computed notional $${notionalUsd.toFixed(2)} below $1 minimum`);

    const decisionId = insertDecision({
      signalId,
      fund: fund.name,
      approved: true,
      reason: `passed all checks; sized at $${notionalUsd.toFixed(2)}`,
      notionalUsd,
      checks,
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
