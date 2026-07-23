import { enabledFunds } from './config.js';
import { db, listDailyPnl, matchClosedOrders } from './db.js';
import { getDailyCloses } from './marketData.js';

export async function getPerformanceAnalytics({ from, to, fund } = {}) {
  const selectedFund = fund || enabledFunds[0]?.name || null;
  const where = [`o.side = 'sell'`];
  const params = [];
  if (from) { where.push(`date(f.filled_at) >= date(?)`); params.push(from); }
  if (to) { where.push(`date(f.filled_at) <= date(?)`); params.push(to); }
  if (selectedFund) { where.push(`o.fund = ?`); params.push(selectedFund); }
  const allFills = latestFills();
  const outcomes = matchClosedOrders(allFills);
  const closed = db.prepare(
    `SELECT o.id AS order_id, o.fund, o.ticker, o.side, f.filled_at, f.filled_avg_price,
            s.source, s.raw_reference
     FROM orders o
     JOIN decisions d ON d.id = o.decision_id
     JOIN signals s ON s.id = d.signal_id
     JOIN fills f ON f.id = (SELECT MAX(f2.id) FROM fills f2 WHERE f2.order_id = o.id)
     WHERE ${where.join(' AND ')} ORDER BY f.filled_at ASC, o.id ASC`
  ).all(...params).map((row) => ({ ...row, ...outcomes.get(row.order_id), reference: parseJson(row.raw_reference) }))
    .filter((row) => row.realizedPnl != null);

  const daily = listDailyPnl({ from, to, fund: selectedFund });
  const curve = buildCurve(closed);
  const summary = summarize(closed, daily, curve);
  const start = from || closed[0]?.filled_at?.slice(0, 10) || daily[0]?.trade_date;
  const end = to || closed.at(-1)?.filled_at?.slice(0, 10) || daily.at(-1)?.trade_date;
  const benchmark = await spyBenchmark(start, end, summary.returnPct);
  return {
    fund: selectedFund,
    funds: enabledFunds.map((item) => ({ name: item.name, paper: !!item.paper })),
    from: start || null,
    to: end || null,
    summary,
    benchmark,
    curve,
    daily: daily.map((row) => ({ date: row.trade_date, fund: row.fund, pnl: Number(row.realized_pnl) + Number(row.unrealized_pnl), equityOpen: row.equity_open })),
    groups: {
      source: group(closed, (row) => row.source || 'unknown'),
      ticker: group(closed, (row) => row.ticker),
      strategy: group(closed, (row) => row.reference?.strategy?.name || 'Unattributed'),
      creator: group(closed, (row) => row.reference?.channelTitle || row.reference?.creator || (row.reference?.channelId ? `Channel #${row.reference.channelId}` : 'Unattributed')),
    },
  };
}

function latestFills() {
  return db.prepare(
    `SELECT o.id AS order_id, o.fund, o.ticker, o.side, f.filled_qty AS qty, f.filled_avg_price AS price, f.filled_at
     FROM orders o JOIN fills f ON f.id = (SELECT MAX(f2.id) FROM fills f2 WHERE f2.order_id = o.id)
     WHERE f.filled_qty > 0 AND f.filled_avg_price > 0 ORDER BY f.filled_at ASC, f.id ASC`
  ).all();
}

export function summarize(rows, daily = [], curve = buildCurve(rows)) {
  const wins = rows.filter((row) => row.realizedPnl > 0);
  const losses = rows.filter((row) => row.realizedPnl < 0);
  const grossProfit = wins.reduce((sum, row) => sum + row.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, row) => sum + row.realizedPnl, 0));
  const invested = rows.reduce((sum, row) => sum + Number(row.entryPrice || 0) * Number(row.matchedQty || 0), 0);
  const netPnl = grossProfit - grossLoss;
  const returns = daily.filter((row) => Number(row.equity_open) > 0).map((row) => (Number(row.realized_pnl) + Number(row.unrealized_pnl)) / Number(row.equity_open));
  return {
    closedTrades: rows.length,
    netPnl: round(netPnl), grossProfit: round(grossProfit), grossLoss: round(grossLoss),
    returnPct: invested ? round((netPnl / invested) * 100, 4) : null,
    winRate: rows.length ? round((wins.length / rows.length) * 100, 2) : null,
    averageWin: wins.length ? round(grossProfit / wins.length) : null,
    averageLoss: losses.length ? round(grossLoss / losses.length) : null,
    payoffRatio: wins.length && losses.length && grossLoss ? round((grossProfit / wins.length) / (grossLoss / losses.length), 3) : null,
    profitFactor: grossLoss ? round(grossProfit / grossLoss, 3) : grossProfit > 0 ? null : 0,
    maxDrawdown: curve.reduce((max, point) => Math.max(max, point.drawdown), 0),
    sharpe: returns.length >= 20 ? sharpe(returns) : null,
    sharpeSampleDays: returns.length,
  };
}

export function buildCurve(rows) {
  let cumulative = 0;
  let peak = 0;
  return rows.map((row) => {
    cumulative += Number(row.realizedPnl || 0);
    peak = Math.max(peak, cumulative);
    return { date: row.filled_at.slice(0, 10), orderId: row.order_id, pnl: row.realizedPnl, cumulativePnl: round(cumulative), drawdown: round(peak - cumulative) };
  });
}

function group(rows, keyFor) {
  const buckets = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  return [...buckets].map(([key, items]) => ({ key, ...summarize(items, [], buildCurve(items)) })).sort((a, b) => b.netPnl - a.netPnl);
}

async function spyBenchmark(from, to, botReturnPct) {
  if (!from || !to) return { symbol: 'SPY', returnPct: null, excessReturnPct: null, unavailable: true };
  const bars = await getDailyCloses('SPY', from, to);
  const usable = (bars || []).filter((bar) => Number(bar.close) > 0);
  if (usable.length < 2) return { symbol: 'SPY', returnPct: null, excessReturnPct: null, unavailable: true };
  const returnPct = round(((usable.at(-1).close - usable[0].close) / usable[0].close) * 100, 4);
  return { symbol: 'SPY', returnPct, excessReturnPct: botReturnPct == null ? null : round(botReturnPct - returnPct, 4), unavailable: false };
}

function sharpe(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return variance > 0 ? round((mean / Math.sqrt(variance)) * Math.sqrt(252), 3) : null;
}
function parseJson(value) { try { return JSON.parse(value || 'null'); } catch { return null; } }
function round(value, digits = 2) { return Number(Number(value).toFixed(digits)); }
