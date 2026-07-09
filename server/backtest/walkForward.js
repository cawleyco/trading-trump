import { getHistoricalTrades, rankByReturn, buildPlans } from './congressBacktest.js';
import { simulateTrades } from './simulate.js';
import { insertBacktest } from '../db.js';

// Walk-forward leaderboard: the overfitting guard. Rank politicians in each
// in-sample window, then measure only the top-N's returns in the *next*
// window (out of sample). A politician who ranks high in-sample and flops
// out-of-sample is noise, not edge.

const DAY_MS = 86400_000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Split [start,end] into `folds` contiguous, non-overlapping inclusive windows. */
export function splitWindows(startDate, endDate, folds) {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  folds = Math.floor(Number(folds));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    throw new Error('startDate must be on or before endDate');
  }
  if (!Number.isFinite(folds) || folds < 2) {
    throw new Error('folds must be at least 2');
  }
  const totalDays = Math.floor((end - start) / DAY_MS) + 1;
  if (folds > totalDays) {
    throw new Error('folds cannot exceed the number of days in the range');
  }

  const baseDays = Math.floor(totalDays / folds);
  const extraDays = totalDays % folds;
  const windows = [];
  let cursor = start;
  for (let i = 0; i < folds; i++) {
    const days = baseDays + (i < extraDays ? 1 : 0);
    const wStart = iso(cursor);
    const wEnd = iso(cursor + (days - 1) * DAY_MS);
    windows.push({ start: wStart, end: wEnd });
    cursor += days * DAY_MS;
  }
  return windows;
}

export async function runWalkForward({
  startDate, endDate, notionalPerTrade,
  folds = 4, topN = 5, exitRule = 'hold_90', minTrades = 3, entryBasis = 'disclosure',
}) {
  folds = Math.max(2, Math.floor(Number(folds) || 4));
  topN = Math.max(1, Math.floor(Number(topN) || 5));
  minTrades = Math.max(1, Math.floor(Number(minTrades) || 3));
  const all = await getHistoricalTrades(startDate, endDate);
  const windows = splitWindows(startDate, endDate, folds);

  const foldResults = [];
  const oosPlans = [];

  // For each in-sample window i (except the last), copy its top-N into window i+1.
  for (let i = 0; i < folds - 1; i++) {
    const train = windows[i];
    const test = windows[i + 1];
    const ranked = await rankByReturn(all, {
      startDate: train.start, endDate: train.end, notionalPerTrade, exitRule, minTrades, entryBasis,
    });
    const topPoliticians = ranked.rows.slice(0, topN).map((r) => r.politician);

    // Build the out-of-sample plans per politician (so 'follow' exits match
    // each member's own later sells, not another member's).
    const testPlans = [];
    for (const politician of topPoliticians) {
      const theirs = all.filter((t) => t.politician === politician);
      testPlans.push(...buildPlans(theirs, { startDate: test.start, endDate: test.end, exitRule, entryBasis }));
    }
    const oos = await simulateTrades(testPlans, notionalPerTrade, { benchmark: true });
    oosPlans.push(...testPlans);

    foldResults.push({
      fold: i + 1,
      trainWindow: train,
      testWindow: test,
      topPoliticians,
      inSample: ranked.rows.slice(0, topN),
      outOfSample: oos.summary,
      benchmark: oos.benchmark ? { returnPct: oos.benchmark.returnPct, totalPnl: oos.benchmark.totalPnl } : null,
    });
  }

  // Aggregate all out-of-sample deployments into one combined curve + benchmark.
  const combined = await simulateTrades(oosPlans, notionalPerTrade, { benchmark: true });

  const params = { startDate, endDate, notionalPerTrade, folds, topN, exitRule, minTrades, entryBasis };
  const results = {
    kind: 'walk-forward',
    folds,
    topN,
    entryBasis,
    foldResults,
    aggregate: {
      summary: combined.summary,
      curve: combined.curve,
      benchmark: combined.benchmark || null,
    },
  };
  const id = insertBacktest({ kind: 'walk-forward', params, results });
  return { id, params, results };
}
