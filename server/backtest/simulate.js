import { _computeAdv, getDailyBarsCached, getMinuteBarsCached } from '../marketData.js';
import { log } from '../logger.js';

// Shared simulation core: given planned entries with exit rules, fetch price
// history once per ticker and compute per-trade and aggregate P&L, plus an
// optional SPY benchmark of the same deployments.

const BENCHMARK_TICKER = 'SPY';

// A provider failure (null) is not the same as "this ticker has no data" ([]).
// The distinction must survive to the skip reason, and failures must never be
// cached beyond the current run — marketData already handles cross-run
// memoization; caching here again once poisoned whole server processes.
export const SKIP_FETCH_FAILED = 'price fetch failed (provider error — retry)';
export const SKIP_NO_DATA = 'no price data for range';
export const SKIP_NO_ENTRY_PRICE = 'no usable entry price';

/** Per-run bar fetcher: dedupes identical fetches within one simulateTrades
 * call but holds nothing across runs. Returns bars[] or null on failure. */
function createFetcher(fetchFn) {
  const cache = new Map();
  return async (...args) => {
    const key = args.join('|');
    if (!cache.has(key)) {
      const bars = await fetchFn(...args);
      if (bars == null) log.warn('backtest', `bars fetch failed: ${key}`);
      cache.set(key, bars ?? null);
    }
    return cache.get(key);
  };
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

const NO_COSTS = { slippageBps: 0, feePerTradeUsd: 0, autoSlippage: false };

/**
 * Auto-slippage tier (basis points) from average dollar volume — thinner
 * names cost more to trade. Null ADV → null (caller keeps explicit slippage).
 */
export function slippageTierBps(adv) {
  if (adv == null) return null;
  if (adv >= 50e6) return 5;
  if (adv >= 10e6) return 15;
  if (adv >= 1e6) return 40;
  return 100;
}

/**
 * Apply slippage + fees to a raw fill pair. Slippage always worsens both
 * fills (entry by +bps, exit by −bps, mirrored for shorts); the fee is a flat
 * per-round-trip dollar cost. Pure — unit-tested directly.
 */
export function applyCosts(rawEntry, rawExit, dir, notionalPerTrade, slippageBps = 0, feePerTradeUsd = 0) {
  if (!Number.isFinite(rawEntry) || rawEntry <= 0 || !Number.isFinite(rawExit) || !Number.isFinite(notionalPerTrade) || notionalPerTrade <= 0) {
    throw new Error(`applyCosts: invalid inputs (entry=${rawEntry}, exit=${rawExit}, notional=${notionalPerTrade})`);
  }
  const s = (slippageBps || 0) / 10000;
  const entryPrice = rawEntry * (1 + dir * s);
  const exitPrice = rawExit * (1 - dir * s);
  const qty = notionalPerTrade / entryPrice;
  const pnl = (exitPrice - entryPrice) * qty * dir - (feePerTradeUsd || 0);
  return { entryPrice, exitPrice, qty, pnl, returnPct: (pnl / notionalPerTrade) * 100 };
}

/** Resolve the effective per-trade cost params (autoSlippage picks a tier). */
function resolveCosts(costOpts, bars, entryIndex) {
  let slippageBps = costOpts.slippageBps || 0;
  let slippageTier = slippageBps ? `${slippageBps}bps` : null;
  if (costOpts.autoSlippage) {
    const adv = _computeAdv(bars.slice(entryIndex, entryIndex + 20), 20);
    const tier = slippageTierBps(adv);
    if (tier != null) {
      slippageBps = tier;
      slippageTier = `auto:${tier}bps`;
    }
  }
  return { slippageBps, slippageTier, feePerTradeUsd: costOpts.feePerTradeUsd || 0 };
}

function finalizeTrade(plan, entryLabel, exitLabel, rawEntry, rawExit, exitReason, notionalPerTrade, costs = NO_COSTS) {
  const dir = plan.direction === 'sell' ? -1 : 1;
  const { entryPrice, exitPrice, qty, pnl, returnPct } = applyCosts(
    rawEntry, rawExit, dir, notionalPerTrade, costs.slippageBps, costs.feePerTradeUsd
  );
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
    returnPct,
    slippageBps: costs.slippageBps || 0,
    slippageTier: costs.slippageTier ?? null,
    feePerTradeUsd: costs.feePerTradeUsd || 0,
  };
}

/** Daily-bar simulation of one plan. */
async function simulateDaily(plan, notionalPerTrade, today, costOpts, ctx) {
  const targetExit = plan.exitDate || (plan.holdDays ? addDays(plan.entryDate, plan.holdDays) : today);
  const rangeEnd = targetExit > today ? today : targetExit;
  const bars = await ctx.getBars(plan.ticker, plan.entryDate, addDays(rangeEnd, 7));
  if (bars == null) return { ...plan, skipped: true, skipReason: SKIP_FETCH_FAILED };
  if (bars.length === 0) return { ...plan, skipped: true, skipReason: SKIP_NO_DATA };

  const entryIndex = bars.findIndex((b) => b.date >= plan.entryDate);
  if (entryIndex === -1) return { ...plan, skipped: true, skipReason: 'no bar at/after entry date' };
  const entryBar = bars[entryIndex];
  const entryPrice = entryBar.open ?? entryBar.close;
  if (entryPrice == null || entryPrice <= 0) return { ...plan, skipped: true, skipReason: SKIP_NO_ENTRY_PRICE };
  const costs = resolveCosts(costOpts, bars, entryIndex);

  // Stop-loss / take-profit first, if configured
  if (plan.stopLossPct != null || plan.takeProfitPct != null) {
    const dir = plan.direction === 'sell' ? -1 : 1;
    const levelExit = findLevelExit(bars, entryIndex, entryPrice, dir, plan.stopLossPct, plan.takeProfitPct);
    if (levelExit && levelExit.bar.date <= targetExit) {
      return finalizeTrade(plan, entryBar.date, levelExit.bar.date, entryPrice, levelExit.price, levelExit.exitReason, notionalPerTrade, costs);
    }
  }

  let exitBar = firstBarOnOrAfter(bars, targetExit) || lastBarOnOrBefore(bars, today);
  if (!exitBar || exitBar.date <= entryBar.date) exitBar = bars[bars.length - 1];
  if (exitBar.date <= entryBar.date) {
    return { ...plan, skipped: true, skipReason: 'no exit bar after entry' };
  }
  return finalizeTrade(plan, entryBar.date, exitBar.date, entryPrice, exitBar.close, 'time', notionalPerTrade, costs);
}

/** Minute-bar simulation of one plan (requires plan.entryTimestamp + holdHours). */
async function simulateIntraday(plan, notionalPerTrade, today, costOpts, ctx) {
  const postMs = new Date(plan.entryTimestamp).getTime();
  // Fetch a generous window: post time + hold + 4 days (covers weekends —
  // a Saturday post enters at Monday's open)
  const endIso = new Date(Math.min(postMs + plan.holdHours * 3600_000 + 4 * 86400_000, Date.now())).toISOString();
  const bars = (await ctx.getMinuteBars(plan.ticker, plan.entryTimestamp, endIso)) ?? [];
  if (bars.length < 2) {
    // No minute data (too old / thin ticker): fall back to daily with a flag.
    // Enter the NEXT day — the event day's open printed before the event.
    const daily = await simulateDaily(
      { ...plan, entryDate: addDays(plan.entryTimestamp.slice(0, 10), 1), holdDays: Math.max(1, Math.round(plan.holdHours / 24)) },
      notionalPerTrade,
      today,
      costOpts,
      ctx
    );
    return { ...daily, fellBackToDaily: true };
  }

  const entryBar = bars[0];
  const entryPrice = entryBar.open ?? entryBar.close;
  if (entryPrice == null || entryPrice <= 0) return { ...plan, skipped: true, skipReason: SKIP_NO_ENTRY_PRICE };
  // Minute bars rarely carry usable volume; auto-slippage falls back to the
  // explicit slippage bps here.
  const costs = resolveCosts(costOpts, bars, 0);
  // Hold clock starts at the actual entry (posts outside market hours enter
  // at the next open), not at the post timestamp.
  const exitTargetMs = new Date(entryBar.timestamp).getTime() + plan.holdHours * 3600_000;

  if (plan.stopLossPct != null || plan.takeProfitPct != null) {
    const dir = plan.direction === 'sell' ? -1 : 1;
    const levelExit = findLevelExit(bars, 0, entryPrice, dir, plan.stopLossPct, plan.takeProfitPct);
    if (levelExit && new Date(levelExit.bar.timestamp).getTime() <= exitTargetMs) {
      return finalizeTrade(plan, entryBar.timestamp, levelExit.bar.timestamp, entryPrice, levelExit.price, levelExit.exitReason, notionalPerTrade, costs);
    }
  }

  let exitBar = bars.find((b) => new Date(b.timestamp).getTime() >= exitTargetMs);
  if (!exitBar) exitBar = bars[bars.length - 1];
  if (exitBar === entryBar) return { ...plan, skipped: true, skipReason: 'no exit bar after entry' };
  return finalizeTrade(plan, entryBar.timestamp, exitBar.timestamp, entryPrice, exitBar.close, 'time', notionalPerTrade, costs);
}

/**
 * Simulate a set of trades.
 * @param {Array} plans  [{ ticker, direction, entryDate | entryTimestamp,
 *   exitDate|null, holdDays|null, holdHours|null, stopLossPct|null,
 *   takeProfitPct|null, label, meta }]
 * @param {number} notionalPerTrade  dollars per trade
 * @param {object} [opts]
 *   - benchmark {boolean=true}: add a SPY comparison of the same deployments.
 *   - slippageBps {number=0}: worsen every entry/exit fill by this many bps.
 *   - feePerTradeUsd {number=0}: flat cost subtracted from each round-trip P&L.
 *   - autoSlippage {boolean=false}: pick a slippage tier per trade from the
 *     ticker's average dollar volume (overrides slippageBps when ADV is known).
 *   - getBars / getMinuteBars: injectable price providers (default: cached
 *     marketData fetchers) — return bars[] or null on provider failure.
 *   Defaults are all zero/off, so results stay comparable to older backtests.
 * @returns {{ trades, summary, curve, benchmark? }}
 */
export async function simulateTrades(plans, notionalPerTrade, opts = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const costOpts = {
    slippageBps: opts.slippageBps || 0,
    feePerTradeUsd: opts.feePerTradeUsd || 0,
    autoSlippage: opts.autoSlippage || false,
  };
  const ctx = {
    getBars: createFetcher(opts.getBars ?? getDailyBarsCached),
    getMinuteBars: createFetcher(opts.getMinuteBars ?? getMinuteBarsCached),
  };
  const trades = [];

  for (const plan of plans) {
    const intraday = plan.holdHours != null && plan.entryTimestamp;
    trades.push(
      intraday
        ? await simulateIntraday(plan, notionalPerTrade, today, costOpts, ctx)
        : await simulateDaily(plan, notionalPerTrade, today, costOpts, ctx)
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
      fetchFailures: trades.filter((t) => t.skipReason === SKIP_FETCH_FAILED).length,
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
      benchTrades.push(await simulateDaily(plan, notionalPerTrade, today, NO_COSTS, ctx));
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
