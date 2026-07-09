// Phase 11 — aggregate dashboards over the intelligence archive.
// Each exported query backs one tab of the Intel view (GET /api/intel/agg/...).
// Pure helpers are kept separate so they can be unit-tested without a database.

import { db } from '../db.js';
import { filingSpeedLeaderboard } from './freshnessReports.js';

/** ISO date (YYYY-MM-DD) for `days` before `now` (UTC). */
export function sinceDaysAgo(days, now = new Date()) {
  const d = new Date(now.getTime());
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// SQLite expression that snaps a YYYY-MM-DD column to the Monday of its week.
const weekStartSql = (col) =>
  `date(${col}, '-' || ((cast(strftime('%w', ${col}) as integer) + 6) % 7) || ' days')`;

/**
 * Pivot flat {row, col, ...cell} records into a dense matrix for grid rendering.
 * Returns { rows: sorted row keys, cols: sorted col keys, cells: {row: {col: cell}} }.
 */
export function buildMatrix(records, { rowKey, colKey }) {
  const rows = new Set();
  const cols = new Set();
  const cells = {};
  for (const rec of records) {
    const r = rec[rowKey];
    const c = rec[colKey];
    if (r == null || c == null) continue;
    rows.add(r);
    cols.add(c);
    (cells[r] ||= {})[c] = rec;
  }
  return {
    rows: [...rows].sort(),
    cols: [...cols].sort(),
    cells,
  };
}

/**
 * Composite "conflict-risk index" (0–100) for a politically exposed ticker.
 * Blends recent Congress trading activity with lobbying and federal-contract
 * signals — the more of each within the window, the higher the exposure.
 */
export function conflictRiskIndex({ tradeCount = 0, politicianCount = 0, lobbyingCount = 0, contractCount = 0 } = {}) {
  const raw = 7 * tradeCount + 5 * politicianCount + 6 * lobbyingCount + 6 * contractCount;
  return Math.min(100, Math.round(raw));
}

/**
 * Tab 1 — most bought/sold tickers over the window, with buy/sell counts,
 * distinct politicians, net sentiment (buys − sells), and average copy score.
 */
export function mostActive({ days = 30, limit = 25 } = {}) {
  const since = sinceDaysAgo(days);
  return db
    .prepare(
      `SELECT ct.ticker AS ticker,
              MAX(tm.company_name) AS companyName,
              MAX(tm.sector) AS sector,
              SUM(CASE WHEN ct.type = 'buy' THEN 1 ELSE 0 END) AS buyCount,
              SUM(CASE WHEN ct.type = 'sell' THEN 1 ELSE 0 END) AS sellCount,
              COUNT(*) AS tradeCount,
              COUNT(DISTINCT ct.politician) AS politicianCount,
              ROUND(AVG(ts.score), 1) AS avgScore
       FROM congress_trades ct
       LEFT JOIN ticker_meta tm ON tm.ticker = ct.ticker
       LEFT JOIN trade_scores ts ON ts.trade_key = ct.trade_key
       WHERE ct.disclosure_date >= ?
       GROUP BY ct.ticker
       ORDER BY tradeCount DESC, ct.ticker ASC
       LIMIT ?`
    )
    .all(since, limit)
    .map((r) => ({ ...r, netSentiment: r.buyCount - r.sellCount }));
}

/**
 * Tab 2 — net buys (buys − sells) per sector per week over the window.
 * Returns a matrix (sector rows × week columns) for a colored grid/heatmap.
 */
export function sectorHeatmap({ days = 90 } = {}) {
  const since = sinceDaysAgo(days);
  const records = db
    .prepare(
      `SELECT tm.sector AS sector,
              ${weekStartSql('ct.disclosure_date')} AS week,
              SUM(CASE WHEN ct.type = 'buy' THEN 1 ELSE 0 END) AS buys,
              SUM(CASE WHEN ct.type = 'sell' THEN 1 ELSE 0 END) AS sells
       FROM congress_trades ct
       JOIN ticker_meta tm ON tm.ticker = ct.ticker
       WHERE ct.disclosure_date >= ? AND tm.sector IS NOT NULL AND tm.sector != ''
       GROUP BY tm.sector, week`
    )
    .all(since)
    .map((r) => ({ ...r, net: r.buys - r.sells }));
  return buildMatrix(records, { rowKey: 'sector', colKey: 'week' });
}

/**
 * Tab 3 — committee × sector trade counts, joining trades to their member's
 * committee assignments (requires linked bioguide ids + committee memberships).
 */
export function committeeHeatmap({ days = 180 } = {}) {
  const since = sinceDaysAgo(days);
  const records = db
    .prepare(
      `SELECT c.name AS committee,
              tm.sector AS sector,
              COUNT(*) AS trades
       FROM congress_trades ct
       JOIN committee_memberships cm ON cm.bioguide_id = ct.politician_id
       JOIN committees c ON c.committee_id = cm.committee_id
       JOIN ticker_meta tm ON tm.ticker = ct.ticker
       WHERE ct.disclosure_date >= ? AND tm.sector IS NOT NULL AND tm.sector != ''
       GROUP BY c.committee_id, tm.sector`
    )
    .all(since);
  return buildMatrix(records, { rowKey: 'committee', colKey: 'sector' });
}

/**
 * Tab 4 — politically exposed stocks ranked by a composite conflict-risk index
 * built from recent Congress trades, lobbying filings, and federal contracts.
 */
export function exposedStocks({ days = 180, limit = 25 } = {}) {
  const since = sinceDaysAgo(days);

  const byTicker = new Map();
  const bucket = (ticker) => {
    if (!ticker) return null;
    if (!byTicker.has(ticker)) {
      byTicker.set(ticker, {
        ticker,
        companyName: null,
        sector: null,
        tradeCount: 0,
        politicianCount: 0,
        avgScore: null,
        lobbyingCount: 0,
        lobbyingAmount: 0,
        contractCount: 0,
        contractAmount: 0,
      });
    }
    return byTicker.get(ticker);
  };

  for (const r of db
    .prepare(
      `SELECT ct.ticker AS ticker,
              MAX(tm.company_name) AS companyName,
              MAX(tm.sector) AS sector,
              COUNT(*) AS tradeCount,
              COUNT(DISTINCT ct.politician) AS politicianCount,
              ROUND(AVG(ts.score), 1) AS avgScore
       FROM congress_trades ct
       LEFT JOIN ticker_meta tm ON tm.ticker = ct.ticker
       LEFT JOIN trade_scores ts ON ts.trade_key = ct.trade_key
       WHERE ct.disclosure_date >= ?
       GROUP BY ct.ticker`
    )
    .all(since)) {
    const e = bucket(r.ticker);
    e.companyName = r.companyName;
    e.sector = r.sector;
    e.tradeCount = r.tradeCount;
    e.politicianCount = r.politicianCount;
    e.avgScore = r.avgScore;
  }

  for (const r of db
    .prepare(
      `SELECT ticker, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
       FROM lobbying_filings
       WHERE ticker IS NOT NULL AND ticker != '' AND filed_at >= ?
       GROUP BY ticker`
    )
    .all(since)) {
    const e = bucket(r.ticker);
    e.lobbyingCount = r.n;
    e.lobbyingAmount = r.total;
  }

  for (const r of db
    .prepare(
      `SELECT ticker, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
       FROM gov_contracts
       WHERE ticker IS NOT NULL AND ticker != '' AND action_date >= ?
       GROUP BY ticker`
    )
    .all(since)) {
    const e = bucket(r.ticker);
    e.contractCount = r.n;
    e.contractAmount = r.total;
  }

  return [...byTicker.values()]
    .map((e) => ({ ...e, riskIndex: conflictRiskIndex(e) }))
    .sort((a, b) => b.riskIndex - a.riskIndex || b.tradeCount - a.tradeCount)
    .slice(0, limit);
}

/** Tab 5 — the Phase 1 filing-speed leaderboard, surfaced inside Intel. */
export function disclosureQuality({ minTrades = 3 } = {}) {
  return filingSpeedLeaderboard({ minTrades });
}

function jsonOrNull(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Tab 6 — copy performance: realized results of the most recent disclosure-basis
 * Congress backtests (return vs SPY) plus a summary of live strategy matches.
 */
export function copyPerformance({ limit = 10 } = {}) {
  const backtests = db
    .prepare(`SELECT id, params, results, created_at FROM backtests WHERE kind = 'congress' ORDER BY id DESC LIMIT 100`)
    .all()
    .map((row) => ({ ...row, params: jsonOrNull(row.params), results: jsonOrNull(row.results) }))
    .filter((row) => (row.params?.entryBasis ?? 'disclosure') === 'disclosure' && row.results?.summary)
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      politician: row.params?.politician ?? 'all',
      startDate: row.params?.startDate ?? null,
      endDate: row.params?.endDate ?? null,
      exitRule: row.params?.exitRule ?? null,
      totalTrades: row.results.summary.totalTrades ?? null,
      winRate: row.results.summary.winRate ?? null,
      returnPct: row.results.summary.returnPct ?? null,
      spyReturnPct: row.results.benchmark?.returnPct ?? null,
      alphaPct:
        row.results.summary.returnPct != null && row.results.benchmark?.returnPct != null
          ? Number((row.results.summary.returnPct - row.results.benchmark.returnPct).toFixed(2))
          : null,
    }));

  const matchRows = db
    .prepare(
      `SELECT s.name AS strategy, COUNT(*) AS total,
              SUM(CASE WHEN sm.matched = 1 THEN 1 ELSE 0 END) AS matched,
              SUM(CASE WHEN sm.signal_id IS NOT NULL THEN 1 ELSE 0 END) AS traded
       FROM strategy_matches sm
       JOIN strategies s ON s.id = sm.strategy_id
       GROUP BY sm.strategy_id
       ORDER BY matched DESC, total DESC`
    )
    .all();

  return { backtests, strategyMatches: matchRows };
}
