import { fetchHistoricalCongressTrades } from '../sources/congressData.js';
import { simulateTrades } from './simulate.js';
import { insertBacktest, listCongressTrades } from '../db.js';
import { log } from '../logger.js';

// Historical pulls are slow (Quiver payload or per-filing eFD scrape); cache
// the most recent window for an hour and serve narrower requests from it.
let historicalCache = { data: null, startDate: null, fetchedAt: 0 };

/** Archived rows (congress_trades) mapped back to the normalized trade shape. */
function archivedTrades(startDate, endDate) {
  return listCongressTrades({ since: startDate, until: endDate }).map((r) => {
    let raw = null;
    try { raw = r.raw ? JSON.parse(r.raw) : null; } catch { /* keep null */ }
    return {
      politician: r.politician,
      ticker: r.ticker,
      type: r.type,
      transactionDate: r.transaction_date,
      disclosureDate: r.disclosure_date,
      firstSeenAt: r.first_seen_at,
      amountRange: r.amount_range,
      raw,
    };
  });
}

export async function getHistoricalTrades(startDate, endDate) {
  // The local archive (populated by the poller + backfill script) is the
  // preferred source; fall back to the network while it's still empty.
  const archived = archivedTrades(startDate, endDate);
  if (archived.length > 0) return archived;

  const fresh = Date.now() - historicalCache.fetchedAt < 3600_000;
  if (historicalCache.data && fresh && historicalCache.startDate <= startDate) {
    return historicalCache.data.filter(
      (t) => t.disclosureDate >= startDate && t.disclosureDate <= endDate
    );
  }
  const data = await fetchHistoricalCongressTrades(startDate, endDate);
  historicalCache = { data, startDate, fetchedAt: Date.now() };
  return data;
}

export async function listPoliticians(startDate, endDate) {
  const start = startDate || new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
  const end = endDate || new Date().toISOString().slice(0, 10);
  const trades = await getHistoricalTrades(start, end);
  const counts = new Map();
  for (const t of trades) {
    counts.set(t.politician, (counts.get(t.politician) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, tradeCount]) => ({ name, tradeCount }))
    .sort((a, b) => b.tradeCount - a.tradeCount);
}

/**
 * "If I had copied {politician}'s disclosed trades from {startDate} to {endDate}
 *  with ${notionalPerTrade} per trade, what would my P&L be?"
 *
 * Entry basis (which date becomes the entry) is one of:
 *  - 'transaction': the trade date itself — a fantasy upper bound, not
 *                   achievable (you can't know before disclosure)
 *  - 'disclosure' (default): first open after the disclosure date, matching
 *                   the live system's lag
 *  - 'first_seen': when our poller actually saw it (truest copy entry; only
 *                  meaningful for rows collected live, else ≈ disclosure)
 *
 * Exit rule:
 *  - 'follow': exit when the politician later discloses a sale of that ticker,
 *              otherwise hold to today
 *  - 'hold_30' / 'hold_90': fixed holding period in days
 *  - 'hold_to_present': never exit early
 */
export const ENTRY_BASES = ['transaction', 'disclosure', 'first_seen'];

function entryDateFor(t, entryBasis) {
  if (entryBasis === 'transaction') return t.transactionDate || null;
  if (entryBasis === 'first_seen') return (t.firstSeenAt || t.disclosureDate)?.slice(0, 10) || null;
  return t.disclosureDate || null; // disclosure (default)
}

export function buildPlans(theirs, { startDate, endDate, exitRule, stopLossPct, takeProfitPct, entryBasis = 'disclosure' }) {
  // The window is always a disclosure-date range (what a live copier could
  // have known about), so all entry bases compare the same set of trades.
  const buys = theirs.filter(
    (t) => t.type === 'buy' && t.disclosureDate >= startDate && t.disclosureDate <= endDate
  );
  const sells = theirs.filter((t) => t.type === 'sell');

  return buys
    .map((t) => {
      const entryDate = entryDateFor(t, entryBasis);
      if (!entryDate) return null; // e.g. transaction basis with no trade date
      let exitDate = null;
      let holdDays = null;
      if (exitRule === 'follow') {
        const laterSale = sells
          .filter((s) => s.ticker === t.ticker && s.disclosureDate > t.disclosureDate)
          .sort((a, b) => a.disclosureDate.localeCompare(b.disclosureDate))[0];
        exitDate = laterSale ? laterSale.disclosureDate : null;
      } else if (exitRule === 'hold_30') holdDays = 30;
      else if (exitRule === 'hold_90') holdDays = 90;
      // hold_to_present: leave both null
      return {
        ticker: t.ticker,
        direction: 'buy',
        entryDate,
        exitDate,
        holdDays,
        stopLossPct: stopLossPct ?? null,
        takeProfitPct: takeProfitPct ?? null,
        label: `${t.politician} ${t.ticker} (disclosed ${t.disclosureDate})`,
        meta: { amountRange: t.amountRange, transactionDate: t.transactionDate },
      };
    })
    .filter(Boolean);
}

export async function runCongressBacktest({ politician, startDate, endDate, notionalPerTrade, exitRule = 'follow', stopLossPct = null, takeProfitPct = null, entryBasis = 'disclosure' }) {
  const all = await getHistoricalTrades(startDate, endDate);
  const theirs = all.filter((t) => t.politician === politician && t.disclosureDate);
  const plans = buildPlans(theirs, { startDate, endDate, exitRule, stopLossPct, takeProfitPct, entryBasis });
  const results = await simulateTrades(plans, notionalPerTrade);
  results.entryBasis = entryBasis;
  const params = { politician, startDate, endDate, notionalPerTrade, exitRule, stopLossPct, takeProfitPct, entryBasis };
  const id = insertBacktest({ kind: 'congress', params, results });
  return { id, params, results };
}

/**
 * Run the same params under 'transaction' (fantasy) and 'disclosure'
 * (realistic) bases — the gap between them is the product insight.
 */
export async function runEntryBasisComparison(opts) {
  const transaction = await runCongressBacktest({ ...opts, entryBasis: 'transaction' });
  const disclosure = await runCongressBacktest({ ...opts, entryBasis: 'disclosure' });
  return {
    transaction,
    disclosure,
    gapPct: Number(
      (transaction.results.summary.returnPct - disclosure.results.summary.returnPct).toFixed(2)
    ),
  };
}

/**
 * Backtest EVERY politician over the period and rank them by return —
 * "who is actually worth copying?" Shares one historical fetch and the
 * module-level bars cache across all politicians.
 */
/**
 * Rank politicians by return over a disclosure-date window, given an already
 * fetched trade array. No fetch, no persistence — reused by the leaderboard
 * and the walk-forward engine. Returns { rows, politiciansConsidered }.
 */
export async function rankByReturn(all, { startDate, endDate, notionalPerTrade, exitRule = 'hold_90', minTrades = 3, entryBasis = 'disclosure' }) {
  const byPolitician = new Map();
  for (const t of all) {
    if (!t.disclosureDate) continue;
    if (!byPolitician.has(t.politician)) byPolitician.set(t.politician, []);
    byPolitician.get(t.politician).push(t);
  }

  const rows = [];
  for (const [politician, theirs] of byPolitician) {
    const plans = buildPlans(theirs, { startDate, endDate, exitRule, entryBasis });
    if (plans.length < minTrades) continue;
    // Skip the SPY benchmark per politician — one shared benchmark row instead
    const results = await simulateTrades(plans, notionalPerTrade, { benchmark: false });
    if (results.summary.totalTrades < minTrades) continue;
    rows.push({
      politician,
      trades: results.summary.totalTrades,
      skipped: results.summary.skipped,
      winRate: results.summary.winRate,
      totalPnl: results.summary.totalPnl,
      totalInvested: results.summary.totalInvested,
      returnPct: results.summary.returnPct,
    });
  }
  rows.sort((a, b) => b.returnPct - a.returnPct);
  return { rows, politiciansConsidered: byPolitician.size };
}

export async function runCongressLeaderboard({ startDate, endDate, notionalPerTrade, exitRule = 'hold_90', minTrades = 3, entryBasis = 'disclosure' }) {
  const all = await getHistoricalTrades(startDate, endDate);
  const { rows, politiciansConsidered } = await rankByReturn(all, {
    startDate, endDate, notionalPerTrade, exitRule, minTrades, entryBasis,
  });
  const params = { startDate, endDate, notionalPerTrade, exitRule, minTrades, entryBasis };
  const results = { leaderboard: rows, politiciansConsidered, entryBasis };
  const id = insertBacktest({ kind: 'leaderboard', params, results });
  return { id, params, results };
}
