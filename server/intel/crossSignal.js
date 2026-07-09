import { db, getSeenPost } from '../db.js';

function json(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function basisDate(post) {
  return String(post?.created_at || new Date().toISOString()).slice(0, 10);
}

function tickerMeta(ticker) {
  return db.prepare(`SELECT * FROM ticker_meta WHERE ticker = ?`).get(String(ticker || '').toUpperCase()) || null;
}

function committeeExposure(politicianId, targetSectors) {
  if (!politicianId || targetSectors.length === 0) return [];
  const targets = new Set(targetSectors);
  return db
    .prepare(
      `SELECT c.*, cm.role
       FROM committee_memberships cm
       JOIN committees c ON c.committee_id = cm.committee_id
       WHERE cm.bioguide_id = ?`
    )
    .all(politicianId)
    .map((row) => ({ ...row, sectors: json(row.sectors, []) }))
    .filter((committee) => (committee.sectors || []).some((sector) => targets.has(sector)))
    .map((committee) => ({
      committee_id: committee.committee_id,
      name: committee.name,
      role: committee.role,
      sectors: committee.sectors.filter((sector) => targets.has(sector)),
    }));
}

function recentCongressBuys({ tickers, sectors, date }) {
  const where = [
    `ct.type = 'buy'`,
    `ct.disclosure_date >= date(?, '-30 days')`,
    `ct.disclosure_date <= date(?)`,
  ];
  const params = [date, date];
  const clauses = [];
  if (tickers.length > 0) {
    clauses.push(`ct.ticker IN (${tickers.map(() => '?').join(', ')})`);
    params.push(...tickers);
  }
  if (sectors.length > 0) {
    clauses.push(`tm.sector IN (${sectors.map(() => '?').join(', ')})`);
    params.push(...sectors);
  }
  if (clauses.length === 0) return [];
  where.push(`(${clauses.join(' OR ')})`);

  return db
    .prepare(
      `SELECT ct.trade_key, ct.politician, ct.politician_id, ct.ticker, ct.disclosure_date,
              ct.transaction_date, ct.amount_mid, tm.sector, ts.score, ts.recommendation
       FROM congress_trades ct
       LEFT JOIN ticker_meta tm ON tm.ticker = ct.ticker
       LEFT JOIN trade_scores ts ON ts.trade_key = ct.trade_key
       WHERE ${where.join(' AND ')}
       ORDER BY ct.disclosure_date DESC, ct.id DESC
       LIMIT 25`
    )
    .all(...params);
}

export function buildCrossSignalContext(postId, opts = {}) {
  const post = opts.post || getSeenPost(postId);
  if (!post) return null;
  const classification = opts.classification || post.classification;
  if (!classification) {
    return { postId, classification: null, corroboratingTrades: [], note: 'No persisted classification for this post yet.' };
  }

  const requestedTicker = opts.ticker ? String(opts.ticker).toUpperCase() : null;
  const tickers = unique(
    (requestedTicker ? [requestedTicker] : (classification.tickers || []).map((t) => String(t.ticker || '').toUpperCase()))
  );
  const tickerSectors = tickers.map((ticker) => tickerMeta(ticker)?.sector).filter(Boolean);
  const sectors = unique([...(classification.sectors || []), ...tickerSectors].map((s) => String(s || '').toLowerCase()));
  const date = basisDate(post);
  const trades = recentCongressBuys({ tickers, sectors, date }).map((trade) => ({
    ...trade,
    committeeExposure: committeeExposure(trade.politician_id, unique([trade.sector, ...sectors])),
  }));

  const tickerText = tickers.length ? tickers.join(', ') : 'no specific ticker';
  const sectorText = sectors.length ? sectors.join(', ') : 'no mapped sector';
  const note = trades.length
    ? `Found ${trades.length} recent congress buy(s) matching ${tickerText} / ${sectorText}.`
    : `No recent congress buys matched ${tickerText} / ${sectorText} in the prior 30 days.`;

  return {
    postId,
    classification,
    targets: { tickers, sectors },
    corroboratingTrades: trades,
    note,
  };
}
