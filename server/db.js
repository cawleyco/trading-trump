import Database from 'better-sqlite3';
import { config } from './config.js';

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,             -- 'congress' | 'sentiment'
  ticker TEXT NOT NULL,
  direction TEXT NOT NULL,          -- 'buy' | 'sell'
  confidence REAL,
  rationale TEXT,
  raw_reference TEXT,               -- JSON payload of the source data
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL REFERENCES signals(id),
  fund TEXT NOT NULL DEFAULT 'default',
  approved INTEGER NOT NULL,
  reason TEXT NOT NULL,
  notional_usd REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id INTEGER NOT NULL REFERENCES decisions(id),
  fund TEXT NOT NULL DEFAULT 'default',
  alpaca_order_id TEXT,
  ticker TEXT NOT NULL,
  side TEXT NOT NULL,
  notional_usd REAL,
  status TEXT NOT NULL,             -- 'simulated' | 'submitted' | 'filled' | 'canceled' | 'rejected' | 'error'
  submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER REFERENCES orders(id),
  alpaca_order_id TEXT,
  filled_qty REAL,
  filled_avg_price REAL,
  filled_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_pnl (
  trade_date TEXT NOT NULL,         -- YYYY-MM-DD
  fund TEXT NOT NULL DEFAULT 'default',
  realized_pnl REAL NOT NULL DEFAULT 0,
  unrealized_pnl REAL NOT NULL DEFAULT 0,
  equity_open REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (trade_date, fund)
);

CREATE TABLE IF NOT EXISTS kill_switch_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fund TEXT NOT NULL DEFAULT 'default',
  reason TEXT NOT NULL,
  tripped_at TEXT NOT NULL DEFAULT (datetime('now')),
  reset_at TEXT
);

CREATE TABLE IF NOT EXISTS seen_congress_trades (
  trade_key TEXT PRIMARY KEY,       -- politician|ticker|transaction_date|type|amount
  seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS seen_posts (
  post_id TEXT PRIMARY KEY,
  text TEXT,                        -- kept so recent posts are backtestable
  created_at TEXT,
  seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS backtests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,               -- 'congress' | 'tweet'
  params TEXT NOT NULL,             -- JSON of the request parameters
  results TEXT NOT NULL,            -- JSON: summary + per-trade breakdown + curve
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS congress_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_key TEXT UNIQUE NOT NULL,        -- same key as seen_congress_trades
  politician TEXT NOT NULL,
  politician_id TEXT,                    -- bioguide id, filled by Phase 6; NULL ok
  ticker TEXT NOT NULL,
  type TEXT NOT NULL,                    -- 'buy' | 'sell'
  transaction_date TEXT,                 -- YYYY-MM-DD
  disclosure_date TEXT,                  -- YYYY-MM-DD (filing date)
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),  -- when WE first saw it (publish time)
  amount_range TEXT,                     -- raw band string e.g. "$15,001 - $50,000"
  amount_min REAL, amount_max REAL, amount_mid REAL,      -- parsed from the band
  asset_description TEXT,                -- raw asset text when available
  owner TEXT,                            -- 'self' | 'spouse' | 'dependent' | NULL
  is_option INTEGER NOT NULL DEFAULT 0,
  option_detail TEXT,                    -- JSON {type,strike,expiry} when parseable
  source TEXT NOT NULL,                  -- 'quiver' | 'senate-efd'
  source_url TEXT,                       -- link to the original filing when known
  parse_confidence REAL NOT NULL DEFAULT 1.0,  -- Phase 1 fills this
  amendment_of TEXT,                     -- trade_key this row amends, if any
  raw TEXT                               -- original JSON row
);
CREATE INDEX IF NOT EXISTS idx_ct_ticker ON congress_trades(ticker);
CREATE INDEX IF NOT EXISTS idx_ct_politician ON congress_trades(politician);
CREATE INDEX IF NOT EXISTS idx_ct_disclosure ON congress_trades(disclosure_date);

CREATE TABLE IF NOT EXISTS ticker_meta (
  ticker TEXT PRIMARY KEY,
  company_name TEXT,
  cik TEXT,
  sic TEXT,
  sector TEXT,           -- coarse bucket from server/lib/sicSectors.js
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS review_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_key TEXT NOT NULL REFERENCES congress_trades(trade_key),
  reason TEXT NOT NULL,             -- e.g. 'parse_confidence 0.5 < 0.8'
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected'
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rq_status ON review_queue(status);
`);

// --- migrations for databases created before multi-fund support ---
function hasColumn(table, column) {
  return db.pragma(`table_info(${table})`).some((c) => c.name === column);
}

for (const table of ['decisions', 'orders', 'kill_switch_events']) {
  if (!hasColumn(table, 'fund')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN fund TEXT NOT NULL DEFAULT 'default'`);
  }
}

for (const col of ['text', 'created_at']) {
  if (!hasColumn('seen_posts', col)) {
    db.exec(`ALTER TABLE seen_posts ADD COLUMN ${col} TEXT`);
  }
}

if (!hasColumn('daily_pnl', 'fund')) {
  // PK is changing from (trade_date) to (trade_date, fund): rebuild the table
  db.exec(`
    ALTER TABLE daily_pnl RENAME TO daily_pnl_v1;
    CREATE TABLE daily_pnl (
      trade_date TEXT NOT NULL,
      fund TEXT NOT NULL DEFAULT 'default',
      realized_pnl REAL NOT NULL DEFAULT 0,
      unrealized_pnl REAL NOT NULL DEFAULT 0,
      equity_open REAL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (trade_date, fund)
    );
    INSERT INTO daily_pnl (trade_date, fund, realized_pnl, unrealized_pnl, equity_open, updated_at)
      SELECT trade_date, 'default', realized_pnl, unrealized_pnl, equity_open, updated_at FROM daily_pnl_v1;
    DROP TABLE daily_pnl_v1;
  `);
}

export function insertSignal({ source, ticker, direction, confidence, rationale, rawReference }) {
  const res = db
    .prepare(
      `INSERT INTO signals (source, ticker, direction, confidence, rationale, raw_reference)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(source, ticker, direction, confidence ?? null, rationale ?? null,
         rawReference ? JSON.stringify(rawReference) : null);
  return res.lastInsertRowid;
}

export function insertDecision({ signalId, fund, approved, reason, notionalUsd }) {
  const res = db
    .prepare(
      `INSERT INTO decisions (signal_id, fund, approved, reason, notional_usd) VALUES (?, ?, ?, ?, ?)`
    )
    .run(signalId, fund || 'default', approved ? 1 : 0, reason, notionalUsd ?? null);
  return res.lastInsertRowid;
}

export function insertOrder({ decisionId, fund, alpacaOrderId, ticker, side, notionalUsd, status }) {
  const res = db
    .prepare(
      `INSERT INTO orders (decision_id, fund, alpaca_order_id, ticker, side, notional_usd, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(decisionId, fund || 'default', alpacaOrderId ?? null, ticker, side, notionalUsd ?? null, status);
  return res.lastInsertRowid;
}

export function updateOrderStatus(alpacaOrderId, status) {
  db.prepare(`UPDATE orders SET status = ? WHERE alpaca_order_id = ?`).run(status, alpacaOrderId);
}

export function insertFill({ alpacaOrderId, filledQty, filledAvgPrice }) {
  const order = db
    .prepare(`SELECT id FROM orders WHERE alpaca_order_id = ?`)
    .get(alpacaOrderId);
  db.prepare(
    `INSERT INTO fills (order_id, alpaca_order_id, filled_qty, filled_avg_price)
     VALUES (?, ?, ?, ?)`
  ).run(order?.id ?? null, alpacaOrderId, filledQty, filledAvgPrice);
}

export function upsertDailyPnl({ tradeDate, fund, realizedPnl, unrealizedPnl, equityOpen }) {
  db.prepare(
    `INSERT INTO daily_pnl (trade_date, fund, realized_pnl, unrealized_pnl, equity_open, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(trade_date, fund) DO UPDATE SET
       realized_pnl = excluded.realized_pnl,
       unrealized_pnl = excluded.unrealized_pnl,
       equity_open = COALESCE(daily_pnl.equity_open, excluded.equity_open),
       updated_at = datetime('now')`
  ).run(tradeDate, fund || 'default', realizedPnl, unrealizedPnl, equityOpen ?? null);
}

export function getDailyPnl(tradeDate, fund) {
  return db
    .prepare(`SELECT * FROM daily_pnl WHERE trade_date = ? AND fund = ?`)
    .get(tradeDate, fund || 'default');
}

export function recordKillSwitchTrip(reason, fund) {
  db.prepare(`INSERT INTO kill_switch_events (fund, reason) VALUES (?, ?)`)
    .run(fund || 'default', reason);
}

/** Reset active kill-switch events; fund omitted = all funds. */
export function resetKillSwitch(fund) {
  if (fund) {
    db.prepare(
      `UPDATE kill_switch_events SET reset_at = datetime('now') WHERE reset_at IS NULL AND fund = ?`
    ).run(fund);
  } else {
    db.prepare(
      `UPDATE kill_switch_events SET reset_at = datetime('now') WHERE reset_at IS NULL`
    ).run();
  }
}

export function getActiveKillSwitchEvent(fund) {
  return db
    .prepare(
      `SELECT * FROM kill_switch_events WHERE reset_at IS NULL AND fund = ? ORDER BY id DESC LIMIT 1`
    )
    .get(fund || 'default');
}

/**
 * Insert a trade into the congress_trades archive (INSERT OR IGNORE by
 * trade_key). Returns { id, isNew }. `firstSeenAt` null = now (live poller);
 * backfill passes the disclosure date as the best available estimate.
 */
export function upsertCongressTrade(t) {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO congress_trades
         (trade_key, politician, ticker, type, transaction_date, disclosure_date,
          first_seen_at, amount_range, amount_min, amount_max, amount_mid,
          asset_description, owner, is_option, option_detail, source, source_url,
          parse_confidence, amendment_of, raw)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 1.0), ?, ?)`
    )
    .run(
      t.tradeKey, t.politician, t.ticker, t.type,
      t.transactionDate ?? null, t.disclosureDate ?? null, t.firstSeenAt ?? null,
      t.amountRange ?? null, t.amountMin ?? null, t.amountMax ?? null, t.amountMid ?? null,
      t.assetDescription ?? null, t.owner ?? null, t.isOption ? 1 : 0,
      t.optionDetail ? JSON.stringify(t.optionDetail) : null,
      t.source, t.sourceUrl ?? null,
      t.parseConfidence ?? null, t.amendmentOf ?? null,
      t.raw ? JSON.stringify(t.raw) : null
    );
  if (res.changes > 0) return { id: res.lastInsertRowid, isNew: true };
  const existing = db.prepare(`SELECT id FROM congress_trades WHERE trade_key = ?`).get(t.tradeKey);
  return { id: existing?.id ?? null, isNew: false };
}

export function getCongressTradeByKey(tradeKey) {
  return db.prepare(`SELECT * FROM congress_trades WHERE trade_key = ?`).get(tradeKey) || null;
}

/**
 * Find an existing archived trade this row could be an amendment of: same
 * politician + ticker + transaction date, a different trade_key. Returns the
 * earliest such row's trade_key, or null.
 */
export function findAmendableTradeKey({ politician, ticker, transactionDate, excludeKey }) {
  if (!politician || !ticker || !transactionDate) return null;
  const row = db
    .prepare(
      `SELECT trade_key FROM congress_trades
       WHERE politician = ? AND ticker = ? AND transaction_date = ? AND trade_key != ?
       ORDER BY id ASC LIMIT 1`
    )
    .get(politician, ticker, transactionDate, excludeKey ?? '');
  return row?.trade_key ?? null;
}

export function listCongressTrades({ politician, ticker, since, until, limit } = {}) {
  const where = [];
  const params = [];
  if (politician) { where.push('politician = ?'); params.push(politician); }
  if (ticker) { where.push('ticker = ?'); params.push(ticker); }
  if (since) { where.push('disclosure_date >= ?'); params.push(since); }
  if (until) { where.push('disclosure_date <= ?'); params.push(until); }
  let sql = `SELECT * FROM congress_trades` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY disclosure_date DESC, id DESC`;
  if (limit) { sql += ` LIMIT ?`; params.push(limit); }
  return db.prepare(sql).all(...params);
}

/**
 * Queue a trade for human review (idempotent — skips if a pending row for the
 * same trade_key already exists). Returns true if a new row was inserted.
 */
export function enqueueReview({ tradeKey, reason }) {
  const existing = db
    .prepare(`SELECT 1 FROM review_queue WHERE trade_key = ? AND status = 'pending'`)
    .get(tradeKey);
  if (existing) return false;
  db.prepare(`INSERT INTO review_queue (trade_key, reason) VALUES (?, ?)`).run(tradeKey, reason);
  return true;
}

/** Review-queue items joined with their archived trade (raw filing + source URL). */
export function listReviewQueue(status = 'pending', limit = 200) {
  return db
    .prepare(
      `SELECT rq.id, rq.trade_key, rq.reason, rq.status, rq.resolved_at, rq.created_at,
              ct.politician, ct.ticker, ct.type, ct.transaction_date, ct.disclosure_date,
              ct.amount_range, ct.parse_confidence, ct.is_option, ct.owner,
              ct.source, ct.source_url, ct.raw
       FROM review_queue rq
       JOIN congress_trades ct ON ct.trade_key = rq.trade_key
       ${status ? 'WHERE rq.status = ?' : ''}
       ORDER BY rq.id DESC LIMIT ?`
    )
    .all(...(status ? [status, limit] : [limit]));
}

export function resolveReviewItem(id, status) {
  const res = db
    .prepare(
      `UPDATE review_queue SET status = ?, resolved_at = datetime('now')
       WHERE id = ? AND status = 'pending'`
    )
    .run(status, id);
  return res.changes > 0;
}

export function hasSeenCongressTrade(tradeKey) {
  return !!db.prepare(`SELECT 1 FROM seen_congress_trades WHERE trade_key = ?`).get(tradeKey);
}

export function markCongressTradeSeen(tradeKey) {
  db.prepare(
    `INSERT OR IGNORE INTO seen_congress_trades (trade_key) VALUES (?)`
  ).run(tradeKey);
}

export function hasSeenPost(postId) {
  return !!db.prepare(`SELECT 1 FROM seen_posts WHERE post_id = ?`).get(postId);
}

export function markPostSeen(postId, text, createdAt) {
  db.prepare(
    `INSERT OR IGNORE INTO seen_posts (post_id, text, created_at) VALUES (?, ?, ?)`
  ).run(postId, text ?? null, createdAt ?? null);
}

/** Posts collected by the live poller — supplements the historical archive. */
export function listSeenPosts() {
  return db
    .prepare(
      `SELECT post_id, text, created_at FROM seen_posts
       WHERE text IS NOT NULL AND created_at IS NOT NULL ORDER BY created_at ASC`
    )
    .all();
}

export function insertBacktest({ kind, params, results }) {
  const res = db
    .prepare(`INSERT INTO backtests (kind, params, results) VALUES (?, ?, ?)`)
    .run(kind, JSON.stringify(params), JSON.stringify(results));
  return res.lastInsertRowid;
}

export function listBacktests() {
  return db
    .prepare(`SELECT id, kind, params, created_at FROM backtests ORDER BY id DESC LIMIT 100`)
    .all()
    .map((row) => ({ ...row, params: JSON.parse(row.params) }));
}

export function getBacktest(id) {
  const row = db.prepare(`SELECT * FROM backtests WHERE id = ?`).get(id);
  if (!row) return null;
  return { ...row, params: JSON.parse(row.params), results: JSON.parse(row.results) };
}

export function listSignalsWithDecisions(limit = 100) {
  // One row per (signal, fund decision); a signal routed to N funds shows N rows.
  return db
    .prepare(
      `SELECT s.*, d.fund, d.approved, d.reason AS decision_reason, d.notional_usd,
              o.status AS order_status, o.alpaca_order_id
       FROM signals s
       LEFT JOIN decisions d ON d.signal_id = s.id
       LEFT JOIN orders o ON o.decision_id = d.id
       ORDER BY s.id DESC, d.id DESC LIMIT ?`
    )
    .all(limit);
}
