// Aggregate freshness reports over the congress_trades archive.

import { db } from '../db.js';
import { disclosureLagDays } from './freshness.js';

/** Median of a numeric array (assumed non-empty); averages the middle pair. */
export function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Percent of values ≤ `limit`, rounded to one decimal. */
export function pctWithin(nums, limit) {
  if (nums.length === 0) return 0;
  const n = nums.filter((v) => v <= limit).length;
  return Math.round((1000 * n) / nums.length) / 10;
}

/**
 * Per-politician filing-speed stats over all trades with a computable
 * disclosure lag: trade count, median lag, and % filed within 15/30/45 days.
 * Sorted fastest-median-first. Politicians with < minTrades are omitted.
 */
export function filingSpeedLeaderboard({ minTrades = 3 } = {}) {
  const rows = db
    .prepare(
      `SELECT politician, transaction_date, disclosure_date FROM congress_trades
       WHERE transaction_date IS NOT NULL AND disclosure_date IS NOT NULL`
    )
    .all();

  const byPolitician = new Map();
  for (const r of rows) {
    const lag = disclosureLagDays(r);
    if (lag == null || lag < 0) continue; // drop inconsistent dates
    if (!byPolitician.has(r.politician)) byPolitician.set(r.politician, []);
    byPolitician.get(r.politician).push(lag);
  }

  const out = [];
  for (const [politician, lags] of byPolitician) {
    if (lags.length < minTrades) continue;
    out.push({
      politician,
      tradeCount: lags.length,
      medianLagDays: median(lags),
      pctWithin15: pctWithin(lags, 15),
      pctWithin30: pctWithin(lags, 30),
      pctWithin45: pctWithin(lags, 45),
    });
  }
  out.sort((a, b) => a.medianLagDays - b.medianLagDays);
  return out;
}
