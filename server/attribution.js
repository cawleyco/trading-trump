import { db } from './db.js';

// Realized P&L per signal source per fund: FIFO-match sell fills against buy
// fills for each (fund, ticker), attributing each closed lot's P&L to the
// source of the BUY's originating signal. Answers "is congress-copying or
// sentiment actually making me money?"

export function getAttribution() {
  const fills = db
    .prepare(
      `SELECT f.filled_qty AS qty, f.filled_avg_price AS price, f.filled_at,
              o.fund, o.ticker, o.side, s.source
       FROM fills f
       JOIN orders o ON o.id = f.order_id
       JOIN decisions d ON d.id = o.decision_id
       JOIN signals s ON s.id = d.signal_id
       WHERE f.filled_qty > 0 AND f.filled_avg_price > 0
       ORDER BY f.filled_at ASC, f.id ASC`
    )
    .all();

  // FIFO lots per fund+ticker
  const lots = new Map(); // key -> [{qty, price, source}]
  const realized = []; // {fund, source, week, pnl}

  for (const f of fills) {
    const key = `${f.fund}|${f.ticker}`;
    if (f.side === 'buy') {
      if (!lots.has(key)) lots.set(key, []);
      lots.get(key).push({ qty: f.qty, price: f.price, source: f.source });
    } else {
      let remaining = f.qty;
      const queue = lots.get(key) || [];
      while (remaining > 1e-9 && queue.length > 0) {
        const lot = queue[0];
        const matched = Math.min(lot.qty, remaining);
        realized.push({
          fund: f.fund,
          source: lot.source, // attribute to the ENTRY signal's source
          week: isoWeekStart(f.filled_at),
          pnl: (f.price - lot.price) * matched,
        });
        lot.qty -= matched;
        remaining -= matched;
        if (lot.qty <= 1e-9) queue.shift();
      }
      // Sells with no matched buy (position predates the bot) are ignored.
    }
  }

  // Aggregate: cumulative weekly series per fund per source
  const buckets = new Map(); // fund|source -> Map(week -> pnl)
  for (const r of realized) {
    const key = `${r.fund}|${r.source}`;
    if (!buckets.has(key)) buckets.set(key, new Map());
    const weekMap = buckets.get(key);
    weekMap.set(r.week, (weekMap.get(r.week) || 0) + r.pnl);
  }

  const series = [];
  for (const [key, weekMap] of buckets) {
    const [fund, source] = key.split('|');
    let cumulative = 0;
    const points = [...weekMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([week, pnl]) => {
        cumulative += pnl;
        return { week, pnl: Number(pnl.toFixed(2)), cumulativePnl: Number(cumulative.toFixed(2)) };
      });
    series.push({
      fund,
      source,
      totalRealizedPnl: Number(cumulative.toFixed(2)),
      closedLots: realized.filter((r) => r.fund === fund && r.source === source).length,
      points,
    });
  }

  return { series, totalClosedLots: realized.length };
}

function isoWeekStart(dateStr) {
  const d = new Date(dateStr.includes('T') ? dateStr : dateStr + 'Z');
  const day = d.getUTCDay() || 7; // Monday = 1
  d.setUTCDate(d.getUTCDate() - day + 1);
  return d.toISOString().slice(0, 10);
}
