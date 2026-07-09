import {
  db,
  getPoliticianStats,
  listArchivePoliticians,
  listCongressTrades,
  listPoliticianStats,
  upsertPoliticianStats,
} from '../db.js';
import { priceOn } from '../marketData.js';
import { getSectorForTicker } from '../sources/tickerMeta.js';
import { disclosureLagDays } from './freshness.js';
import { log } from '../logger.js';

const DAY_MS = 86400_000;
const HORIZONS = [7, 30, 90, 180];
const MIN_EDGE_BUYS = 10;

function addDays(dateStr, days) {
  return new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function avg(values) {
  const usable = values.filter((v) => Number.isFinite(v));
  if (usable.length === 0) return null;
  return usable.reduce((sum, v) => sum + v, 0) / usable.length;
}

function median(values) {
  const usable = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (usable.length === 0) return null;
  const mid = Math.floor(usable.length / 2);
  return usable.length % 2 ? usable[mid] : (usable[mid - 1] + usable[mid]) / 2;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function returnPct(entry, exit) {
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry === 0) return null;
  return ((exit - entry) / entry) * 100;
}

function hhiByTicker(trades) {
  if (trades.length === 0) return null;
  const counts = new Map();
  for (const t of trades) counts.set(t.ticker, (counts.get(t.ticker) || 0) + 1);
  return [...counts.values()].reduce((sum, n) => sum + (n / trades.length) ** 2, 0);
}

function bestHoldWindow(avgs) {
  let best = null;
  for (const horizon of HORIZONS) {
    const key = `${horizon}d`;
    const value = avgs[key];
    if (value == null) continue;
    if (!best || value > best.value) best = { key, value };
  }
  return best?.key ?? null;
}

function percentileScores(rows) {
  const eligible = rows
    .filter((r) => r.stats?.measurable_buys_90d >= MIN_EDGE_BUYS && r.avg_return_90d != null)
    .sort((a, b) => a.avg_return_90d - b.avg_return_90d);
  if (eligible.length === 0) return new Map();
  const scores = new Map();
  for (let i = 0; i < eligible.length; i++) {
    const score = eligible.length === 1 ? 100 : (i / (eligible.length - 1)) * 100;
    scores.set(eligible[i].politician, round(score, 1));
  }
  return scores;
}

/**
 * Pure-ish stats builder: callers inject price/sector lookups for tests.
 * Rows use the congress_trades DB shape.
 */
export async function buildPoliticianStats(politician, rows, {
  asOf = new Date().toISOString().slice(0, 10),
  priceFn,
  sectorFn,
} = {}) {
  const qualityRows = rows.filter((r) => !r.is_option && (r.parse_confidence ?? 1) >= 0.8);
  const buys = qualityRows.filter((r) => r.type === 'buy');
  const sells = qualityRows.filter((r) => r.type === 'sell');
  const measurable = [];

  for (const trade of buys) {
    if (!trade.disclosure_date) continue;
    const entry = await priceFn(trade.ticker, trade.disclosure_date);
    if (!Number.isFinite(entry) || entry === 0) {
      measurable.push({ trade, skipped: true, reason: 'no entry price' });
      continue;
    }
    const returns = {};
    for (const horizon of HORIZONS) {
      const exit = await priceFn(trade.ticker, addDays(trade.disclosure_date, horizon));
      returns[`${horizon}d`] = returnPct(entry, exit);
    }
    measurable.push({
      trade,
      skipped: false,
      sector: await sectorFn(trade.ticker),
      returns,
    });
  }

  const measured = measurable.filter((m) => !m.skipped);
  const avgReturns = Object.fromEntries(
    HORIZONS.map((h) => [`${h}d`, round(avg(measured.map((m) => m.returns[`${h}d`])))])
  );
  const winRate = (horizon) => {
    const values = measured.map((m) => m.returns[`${horizon}d`]).filter((v) => Number.isFinite(v));
    if (values.length === 0) return null;
    return round((values.filter((v) => v > 0).length / values.length) * 100, 1);
  };
  const sectorBuckets = {};
  for (const m of measured) {
    const sector = m.sector || 'other';
    if (!sectorBuckets[sector]) sectorBuckets[sector] = [];
    if (Number.isFinite(m.returns['30d'])) sectorBuckets[sector].push(m.returns['30d']);
  }
  const sector_returns = Object.fromEntries(
    Object.entries(sectorBuckets).map(([sector, values]) => [
      sector,
      { trades: values.length, avgReturn30d: round(avg(values)) },
    ])
  );
  const recentCutoff = addDays(asOf, -365);
  const recentAvg30 = avg(
    measured
      .filter((m) => m.trade.disclosure_date >= recentCutoff)
      .map((m) => m.returns['30d'])
  );
  const stats = {
    measured_buys: measured.length,
    measurable_buys_90d: measured.filter((m) => Number.isFinite(m.returns['90d'])).length,
    skipped_buys: measurable.filter((m) => m.skipped).length,
    min_edge_buys: MIN_EDGE_BUYS,
    returns_by_horizon: avgReturns,
  };

  return {
    politician,
    as_of: asOf,
    trade_count: qualityRows.length,
    buy_count: buys.length,
    sell_count: sells.length,
    median_disclosure_lag: round(median(qualityRows.map((t) => disclosureLagDays(t)))),
    avg_amount_mid: round(avg(qualityRows.map((t) => t.amount_mid))),
    win_rate_30d: winRate(30),
    win_rate_90d: winRate(90),
    avg_return_7d: avgReturns['7d'],
    avg_return_30d: avgReturns['30d'],
    avg_return_90d: avgReturns['90d'],
    avg_return_180d: avgReturns['180d'],
    best_hold_window: bestHoldWindow(avgReturns),
    sector_returns,
    concentration_hhi: round(hhiByTicker(qualityRows), 4),
    recent_avg_return_30d: round(recentAvg30),
    edge_score: null,
    stats,
  };
}

export async function computePoliticianStats(politician, opts = {}) {
  const rows = listCongressTrades({ politician, limit: 5000 });
  return buildPoliticianStats(politician, rows, {
    priceFn: opts.priceFn || priceOn,
    sectorFn: opts.sectorFn || getSectorForTicker,
    asOf: opts.asOf,
  });
}

export async function refreshAllPoliticianStats(opts = {}) {
  const politicians = opts.politicians || listArchivePoliticians();
  const rows = [];
  log.info('politician-stats', `Refreshing stats for ${politicians.length} politicians`);
  for (const politician of politicians) {
    rows.push(await computePoliticianStats(politician, opts));
  }
  const edges = percentileScores(rows);
  for (const row of rows) {
    row.edge_score = edges.get(row.politician) ?? null;
    row.stats.edge_score_basis = row.edge_score == null ? `requires ${MIN_EDGE_BUYS} measurable 90d buys` : 'avg_return_90d percentile';
    upsertPoliticianStats(row);
  }
  log.info('politician-stats', `Refreshed stats for ${rows.length} politicians`);
  return { refreshed: rows.length, asOf: rows[0]?.as_of ?? opts.asOf ?? new Date().toISOString().slice(0, 10) };
}

export function listStats(limit = 500) {
  return listPoliticianStats({ limit });
}

export function getStatsProfile(politician) {
  const stats = getPoliticianStats(politician);
  if (!stats) return null;
  const recentTrades = db
    .prepare(
      `SELECT trade_key, ticker, type, transaction_date, disclosure_date, amount_range,
              amount_mid, owner, is_option, parse_confidence, source_url
       FROM congress_trades
       WHERE politician = ?
       ORDER BY disclosure_date DESC, id DESC
       LIMIT 50`
    )
    .all(politician);
  return { ...stats, recentTrades };
}
