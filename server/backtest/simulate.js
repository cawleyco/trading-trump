import { getDailyBars, getMinuteBars } from '../alpacaClient.js';
import { log } from '../logger.js';

// Shared simulation core: given planned entries with exit rules, fetch price
// history once per ticker and compute per-trade and aggregate P&L, plus an
// optional SPY benchmark of the same deployments.

const BENCHMARK_TICKER = 'SPY';

const barsCache = new Map();

async function getBarsCached(ticker, startDate, endDate) {
  const key = `${ticker}|${startDate}|${endDate}`;
  if (!barsCache.has(key)) {
    try {
      barsCache.set(key, await getDailyBars(ticker, startDate, endDate));
    } catch (err) {
      log.warn('backtest', `No bars for ${ticker}: ${err.message}`);
      barsCache.set(key, []);
    }
  }
  return barsCache.get(key);
}

function firstBarOnOrAfter(bars, date) {
  return bars.find((b) => b.date >= date) || null;
}

function lastBarOnOrBefore(bars, date) {
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].date <= date) return bars[i];
  }
  return null;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Walk bars after entry looking for a stop-loss / take-profit hit.
 * Works for daily and minute bars alike. `dir` is +1 (long) or -1 (short).
 * If a bar gaps past a level, fill at the bar's open (honest about gaps).
 * If both levels are hit inside one bar, assume the stop hit first
 * (conservative). Returns { bar, price, exitReason } or null if never hit.
 */
export function findLevelExit(bars, entryIndex, entryPrice, dir, stopLossPct, takeProfitPct) {
  const stopPrice = stopLossPct != null ? entryPrice * (1 - dir * (stopLossPct / 100)) : null;
  const tpPrice = takeProfitPct != null ? entryPrice * (1 + dir * (takeProfitPct / 100)) : null;

  for (let i = entryIndex + 1; i < bars.length; i++) {
    const bar = bars[i];
    const stopHit =
      stopPrice != null && (dir > 0 ? bar.low <= stopPrice : bar.high >= stopPrice);
    const tpHit = tpPrice != null && (dir > 0 ? bar.high >= tpPrice : bar.low <= tpPrice);

    if (stopHit) {
      const gapped = dir > 0 ? bar.open <= stopPrice : bar.open >= stopPrice;
      return { bar, price: gapped ? bar.open : stopPrice, exitReason: 'stop-loss' };
    }
    if (tpHit) {
      const gapped = dir > 0 ? bar.open >= tpPrice : bar.open <= tpPrice;
      return { bar, price: gapped ? bar.open : tpPrice, exitReason: 'take-profit' };
    }
  }
  return null;
}

function finalizeTrade(plan, entryLabel, exitLabel, entryPrice, exitPrice, exitReason, notionalPerTrade) {
  const dir = plan.direction === 'sell' ? -1 : 1;
  const qty = notionalPerTrade / entryPrice;
  const pnl = (exitPrice - entryPrice) * qty * dir;
  return {
    ...plan,
    skipped: false,
    entryDate: entryLabel,
    exitDate: exitLabel,
    entryPrice,
    exitPrice,
    qty,
    pnl,
    exitReason,
    returnPct: ((exitPrice - entryPrice) / entryPrice) * 100 * dir,
  };
}

/** Daily-bar simulation of one plan. */
async function simulateDaily(plan, notionalPerTrade, today) {
  const targetExit = plan.exitDate || (plan.holdDays ? addDays(plan.entryDate, plan.holdDays) : today);
  const rangeEnd = targetExit > today ? today : targetExit;
  const bars = await getBarsCached(plan.ticker, plan.entryDate, addDays(rangeEnd, 7));
  if (bars.length === 0) return { ...plan, skipped: true, skipReason: 'no price data' };

  const entryIndex = bars.findIndex((b) => b.date >= plan.entryDate);
  if (entryIndex === -1) return { ...plan, skipped: true, skipReason: 'no bar at/after entry date' };
  const entryBar = bars[entryIndex];
  const entryPrice = entryBar.open || entryBar.close;

  // Stop-loss / take-profit first, if configured
  if (plan.stopLossPct != null || plan.takeProfitPct != null) {
    const dir = plan.direction === 'sell' ? -1 : 1;
    const levelExit = findLevelExit(bars, entryIndex, entryPrice, dir, plan.stopLossPct, plan.takeProfitPct);
    if (levelExit && levelExit.bar.date <= targetExit) {
      return finalizeTrade(plan, entryBar.date, levelExit.bar.date, entryPrice, levelExit.price, levelExit.exitReason, notionalPerTrade);
    }
  }

  let exitBar = firstBarOnOrAfter(bars, targetExit) || lastBarOnOrBefore(bars, today);
  if (!exitBar || exitBar.date <= entryBar.date) exitBar = bars[bars.length - 1];
  if (exitBar.date <= entryBar.date) {
    return { ...plan, skipped: true, skipReason: 'no exit bar after entry' };
  }
  return finalizeTrade(plan, entryBar.date, exitBar.date, entryPrice, exitBar.close, 'time', notionalPerTrade);
}

/** Minute-bar simulation of one plan (requires plan.entryTimestamp + holdHours). */
async function simulateIntraday(plan, notionalPerTrade, today) {
  const postMs = new Date(plan.entryTimestamp).getTime();
  // Fetch a generous window: post time + hold + 4 days (covers weekends —
  // a Saturday post enters at Monday's open)
  const endIso = new Date(Math.min(postMs + plan.holdHours * 3600_000 + 4 * 86400_000, Date.now())).toISOString();
  let bars;
  try {
    bars = await getMinuteBars(plan.ticker, plan.entryTimestamp, endIso);
  } catch (err) {
    bars = [];
  }
  if (bars.length < 2) {
    // No minute data (too old / thin ticker): fall back to daily with a flag
    const daily = await simulateDaily(
      { ...plan, entryDate: plan.entryTimestamp.slice(0, 10), holdDays: Math.max(1, Math.round(plan.holdHours / 24)) },
      notionalPerTrade,
      today
    );
    return { ...daily, fellBackToDaily: true };
  }

  const entryBar = bars[0];
  const entryPrice = entryBar.open || entryBar.close;
  // Hold clock starts at the actual entry (posts outside market hours enter
  // at the next open), not at the post timestamp.
  const exitTargetMs = new Date(entryBar.timestamp).getTime() + plan.holdHours * 3600_000;

  if (plan.stopLossPct != null || plan.takeProfitPct != null) {
    const dir = plan.direction === 'sell' ? -1 : 1;
    const levelExit = findLevelExit(bars, 0, entryPrice, dir, plan.stopLossPct, plan.takeProfitPct);
    if (levelExit && new Date(levelExit.bar.timestamp).getTime() <= exitTargetMs) {
      return finalizeTrade(plan, entryBar.timestamp, levelExit.bar.timestamp, entryPrice, levelExit.price, levelExit.exitReason, notionalPerTrade);
    }
  }

  let exitBar = bars.find((b) => new Date(b.timestamp).getTime() >= exitTargetMs);
  if (!exitBar) exitBar = bars[bars.length - 1];
  if (exitBar === entryBar) return { ...plan, skipped: true, skipReason: 'no exit bar after entry' };
  return finalizeTrade(plan, entryBar.timestamp, exitBar.timestamp, entryPrice, exitBar.close, 'time', notionalPerTrade);
}

/**
 * Simulate a set of trades.
 * @param {Array} plans  [{ ticker, direction, entryDate | entryTimestamp,
 *   exitDate|null, holdDays|null, holdHours|null, stopLossPct|null,
 *   takeProfitPct|null, label, meta }]
 * @param {number} notionalPerTrade  dollars per trade
 * @param {object} [opts]  { benchmark: true } adds a SPY comparison of the
 *   same deployments over the same dates.
 * @returns {{ trades, summary, curve, benchmark? }}
 */
export async function simulateTrades(plans, notionalPerTrade, opts = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const trades = [];

  for (const plan of plans) {
    const intraday = plan.holdHours != null && plan.entryTimestamp;
    trades.push(
      intraday
        ? await simulateIntraday(plan, notionalPerTrade, today)
        : await simulateDaily(plan, notionalPerTrade, today)
    );
  }

  const executed = trades.filter((t) => !t.skipped);
  const wins = executed.filter((t) => t.pnl > 0);
  const totalPnl = executed.reduce((s, t) => s + t.pnl, 0);
  const totalInvested = executed.length * notionalPerTrade;

  // Cumulative P&L curve ordered by exit date
  let running = 0;
  const curve = executed
    .slice()
    .sort((a, b) => String(a.exitDate).localeCompare(String(b.exitDate)))
    .map((t) => {
      running += t.pnl;
      return { date: String(t.exitDate).slice(0, 10), cumulativePnl: Number(running.toFixed(2)) };
    });

  const result = {
    trades,
    summary: {
      totalTrades: executed.length,
      skipped: trades.length - executed.length,
      wins: wins.length,
      losses: executed.length - wins.length,
      winRate: executed.length ? Number(((wins.length / executed.length) * 100).toFixed(1)) : 0,
      totalPnl: Number(totalPnl.toFixed(2)),
      totalInvested: Number(totalInvested.toFixed(2)),
      returnPct: totalInvested ? Number(((totalPnl / totalInvested) * 100).toFixed(2)) : 0,
    },
    curve,
  };

  // SPY benchmark: same $ amounts, same entry/exit dates, long-only
  if (opts.benchmark !== false && executed.length > 0) {
    const benchPlans = executed.map((t) => ({
      ticker: BENCHMARK_TICKER,
      direction: 'buy',
      entryDate: String(t.entryDate).slice(0, 10),
      exitDate: String(t.exitDate).slice(0, 10),
      label: `benchmark for ${t.ticker}`,
    }));
    const benchTrades = [];
    for (const plan of benchPlans) {
      benchTrades.push(await simulateDaily(plan, notionalPerTrade, today));
    }
    const benchExecuted = benchTrades.filter((t) => !t.skipped);
    const benchPnl = benchExecuted.reduce((s, t) => s + t.pnl, 0);
    let benchRunning = 0;
    result.benchmark = {
      ticker: BENCHMARK_TICKER,
      totalPnl: Number(benchPnl.toFixed(2)),
      returnPct: totalInvested ? Number(((benchPnl / totalInvested) * 100).toFixed(2)) : 0,
      curve: benchExecuted
        .slice()
        .sort((a, b) => String(a.exitDate).localeCompare(String(b.exitDate)))
        .map((t) => {
          benchRunning += t.pnl;
          return { date: String(t.exitDate).slice(0, 10), cumulativePnl: Number(benchRunning.toFixed(2)) };
        }),
    };
  }

  return result;
}
