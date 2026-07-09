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

CREATE TABLE IF NOT EXISTS politician_stats (
  politician TEXT PRIMARY KEY,
  as_of TEXT NOT NULL,
  trade_count INTEGER,
  buy_count INTEGER,
  sell_count INTEGER,
  median_disclosure_lag REAL,
  avg_amount_mid REAL,
  win_rate_30d REAL,
  win_rate_90d REAL,
  avg_return_7d REAL,
  avg_return_30d REAL,
  avg_return_90d REAL,
  avg_return_180d REAL,
  best_hold_window TEXT,
  sector_returns TEXT,
  concentration_hhi REAL,
  recent_avg_return_30d REAL,
  edge_score REAL,
  stats TEXT
);

CREATE TABLE IF NOT EXISTS trade_scores (
  trade_key TEXT PRIMARY KEY REFERENCES congress_trades(trade_key),
  score REAL NOT NULL,
  confidence REAL NOT NULL,
  recommendation TEXT NOT NULL,
  factors TEXT NOT NULL,
  warnings TEXT NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  inputs_hash TEXT
);

CREATE TABLE IF NOT EXISTS politicians (
  bioguide_id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  chamber TEXT,
  party TEXT,
  state TEXT,
  name_variants TEXT
);
CREATE INDEX IF NOT EXISTS idx_politicians_name ON politicians(full_name);

CREATE TABLE IF NOT EXISTS committees (
  committee_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  chamber TEXT,
  sectors TEXT
);

CREATE TABLE IF NOT EXISTS committee_memberships (
  bioguide_id TEXT NOT NULL REFERENCES politicians(bioguide_id),
  committee_id TEXT NOT NULL REFERENCES committees(committee_id),
  role TEXT,
  PRIMARY KEY (bioguide_id, committee_id)
);
CREATE INDEX IF NOT EXISTS idx_cm_bioguide ON committee_memberships(bioguide_id);
CREATE INDEX IF NOT EXISTS idx_cm_committee ON committee_memberships(committee_id);

CREATE TABLE IF NOT EXISTS bills (
  bill_id TEXT PRIMARY KEY,
  title TEXT,
  policy_area TEXT,
  latest_action TEXT,
  latest_action_date TEXT,
  committees TEXT,
  sectors TEXT,
  source_url TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bills_latest_action ON bills(latest_action_date);

CREATE TABLE IF NOT EXISTS lobbying_filings (
  filing_id TEXT PRIMARY KEY,
  client_name TEXT,
  registrant_name TEXT,
  ticker TEXT,
  amount REAL,
  filing_period TEXT,
  filed_at TEXT,
  issues TEXT,
  source_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_lobbying_ticker ON lobbying_filings(ticker);
CREATE INDEX IF NOT EXISTS idx_lobbying_filed ON lobbying_filings(filed_at);

CREATE TABLE IF NOT EXISTS gov_contracts (
  contract_id TEXT PRIMARY KEY,
  recipient_name TEXT,
  ticker TEXT,
  awarding_agency TEXT,
  amount REAL,
  action_date TEXT,
  source_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_contracts_ticker ON gov_contracts(ticker);
CREATE INDEX IF NOT EXISTS idx_contracts_action ON gov_contracts(action_date);

CREATE TABLE IF NOT EXISTS thesis_cards (
  trade_key TEXT PRIMARY KEY REFERENCES congress_trades(trade_key),
  card TEXT NOT NULL,                -- deterministic card JSON
  polished TEXT,                     -- optional LLM analyst note
  score_computed_at TEXT,            -- score's computed_at when built (cache invalidation)
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_type TEXT NOT NULL,
  symbol TEXT NOT NULL UNIQUE,
  canonical_name TEXT NOT NULL,
  exchange TEXT,
  market TEXT,
  coingecko_id TEXT,
  coinmarketcap_id TEXT,
  isin TEXT,
  cusip TEXT,
  figi TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS asset_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES assets(id),
  alias TEXT NOT NULL,
  alias_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(asset_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_asset_aliases_alias ON asset_aliases(alias);

CREATE TABLE IF NOT EXISTS youtube_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  youtube_channel_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  handle TEXT,
  custom_url TEXT,
  description TEXT,
  thumbnail_url TEXT,
  uploads_playlist_id TEXT,
  subscriber_count INTEGER,
  video_count INTEGER,
  view_count INTEGER,
  country TEXT,
  language TEXT,
  category TEXT,
  influence_tier TEXT,
  tracking_enabled INTEGER NOT NULL DEFAULT 1,
  risk_notes TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS youtube_channel_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES youtube_channels(id),
  captured_at TEXT NOT NULL DEFAULT (datetime('now')),
  subscriber_count INTEGER,
  video_count INTEGER,
  view_count INTEGER
);

CREATE TABLE IF NOT EXISTS youtube_videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  youtube_video_id TEXT UNIQUE NOT NULL,
  channel_id INTEGER NOT NULL REFERENCES youtube_channels(id),
  title TEXT NOT NULL,
  description TEXT,
  published_at TEXT NOT NULL,
  duration_seconds INTEGER,
  thumbnail_url TEXT,
  url TEXT,
  has_captions INTEGER,
  has_paid_product_placement INTEGER,
  default_language TEXT,
  default_audio_language TEXT,
  live_broadcast_content TEXT,
  ingestion_status TEXT NOT NULL DEFAULT 'pending',
  transcript_status TEXT NOT NULL DEFAULT 'not_requested',
  analysis_status TEXT NOT NULL DEFAULT 'not_started',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_youtube_videos_channel ON youtube_videos(channel_id);
CREATE INDEX IF NOT EXISTS idx_youtube_videos_published ON youtube_videos(published_at);

CREATE TABLE IF NOT EXISTS youtube_video_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES youtube_videos(id),
  captured_at TEXT NOT NULL DEFAULT (datetime('now')),
  view_count INTEGER,
  like_count INTEGER,
  comment_count INTEGER
);

CREATE TABLE IF NOT EXISTS content_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  provider_name TEXT NOT NULL,
  language TEXT,
  raw_text TEXT NOT NULL,
  source_format TEXT,
  authorization_status TEXT NOT NULL DEFAULT 'unknown',
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_content_documents_source ON content_documents(source_type, source_id);

CREATE TABLE IF NOT EXISTS content_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES content_documents(id),
  segment_index INTEGER NOT NULL,
  start_seconds REAL,
  end_seconds REAL,
  text TEXT NOT NULL,
  token_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(document_id, segment_index)
);

CREATE TABLE IF NOT EXISTS asset_mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES assets(id),
  source_type TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  video_id INTEGER REFERENCES youtube_videos(id),
  channel_id INTEGER REFERENCES youtube_channels(id),
  segment_id INTEGER REFERENCES content_segments(id),
  mention_text TEXT NOT NULL,
  surrounding_text TEXT,
  mention_start_seconds REAL,
  mention_end_seconds REAL,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  event_time TEXT NOT NULL,
  detection_method TEXT NOT NULL,
  entity_confidence REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(asset_id, source_type, source_id, mention_text, mention_start_seconds)
);
CREATE INDEX IF NOT EXISTS idx_asset_mentions_video ON asset_mentions(video_id);
CREATE INDEX IF NOT EXISTS idx_asset_mentions_asset ON asset_mentions(asset_id);

CREATE TABLE IF NOT EXISTS mention_classifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mention_id INTEGER NOT NULL REFERENCES asset_mentions(id),
  direction TEXT NOT NULL,
  conviction_score REAL NOT NULL,
  relevance_score REAL NOT NULL,
  directness_score REAL NOT NULL,
  sponsorship_risk_score REAL NOT NULL,
  pump_risk_score REAL NOT NULL,
  time_horizon TEXT,
  mention_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence TEXT,
  should_create_signal INTEGER NOT NULL DEFAULT 0,
  mention_quality_score REAL,
  model_name TEXT,
  model_version TEXT,
  prompt_version TEXT,
  raw_model_output TEXT,
  is_manual_override INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mention_classifications_mention ON mention_classifications(mention_id);

CREATE TABLE IF NOT EXISTS youtube_backtest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  module_key TEXT NOT NULL DEFAULT 'youtube',
  strategy_config TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS youtube_backtest_signal_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_run_id INTEGER NOT NULL REFERENCES youtube_backtest_runs(id),
  signal_event_id INTEGER,
  mention_id INTEGER REFERENCES asset_mentions(id),
  asset_id INTEGER NOT NULL REFERENCES assets(id),
  entry_time TEXT NOT NULL,
  entry_price REAL,
  exit_1h_price REAL,
  exit_6h_price REAL,
  exit_24h_price REAL,
  exit_7d_price REAL,
  exit_30d_price REAL,
  exit_90d_price REAL,
  return_1h REAL,
  return_6h REAL,
  return_24h REAL,
  return_7d REAL,
  return_30d REAL,
  return_90d REAL,
  max_drawdown_30d REAL,
  max_runup_30d REAL,
  volume_change_24h REAL,
  benchmark_return_30d REAL,
  result_metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS creator_alpha_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES youtube_channels(id),
  asset_type TEXT,
  direction TEXT,
  mention_type TEXT,
  sample_size INTEGER NOT NULL,
  avg_return_1h REAL,
  avg_return_6h REAL,
  avg_return_24h REAL,
  avg_return_7d REAL,
  avg_return_30d REAL,
  avg_return_90d REAL,
  win_rate_24h REAL,
  win_rate_7d REAL,
  win_rate_30d REAL,
  median_return_30d REAL,
  volatility_30d REAL,
  pump_dump_rate REAL,
  fade_score REAL,
  alpha_score REAL,
  label TEXT,
  calculated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_creator_alpha_channel ON creator_alpha_metrics(channel_id);

CREATE TABLE IF NOT EXISTS influence_signal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  module_key TEXT NOT NULL,
  asset_id INTEGER NOT NULL REFERENCES assets(id),
  event_time TEXT NOT NULL,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  direction TEXT NOT NULL,
  confidence REAL NOT NULL,
  strength_score REAL NOT NULL,
  actionability_score REAL NOT NULL,
  suggested_action TEXT NOT NULL,
  title TEXT NOT NULL,
  explanation TEXT NOT NULL,
  evidence TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_type, source_id, module_key, asset_id, direction)
);
CREATE INDEX IF NOT EXISTS idx_influence_signal_events_module ON influence_signal_events(module_key, created_at);

CREATE TABLE IF NOT EXISTS market_candles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES assets(id),
  interval TEXT NOT NULL,
  candle_time TEXT NOT NULL,
  open REAL,
  high REAL,
  low REAL,
  close REAL,
  volume REAL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(asset_id, interval, candle_time, source)
);
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

if (!hasColumn('congress_trades', 'politician_id')) {
  db.exec(`ALTER TABLE congress_trades ADD COLUMN politician_id TEXT`);
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

export function listArchivePoliticians() {
  return db
    .prepare(`SELECT DISTINCT politician FROM congress_trades WHERE politician IS NOT NULL ORDER BY politician`)
    .all()
    .map((r) => r.politician);
}

export function upsertPolitician(row) {
  db.prepare(
    `INSERT INTO politicians (bioguide_id, full_name, chamber, party, state, name_variants)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(bioguide_id) DO UPDATE SET
       full_name = excluded.full_name,
       chamber = excluded.chamber,
       party = excluded.party,
       state = excluded.state,
       name_variants = excluded.name_variants`
  ).run(
    row.bioguide_id,
    row.full_name,
    row.chamber ?? null,
    row.party ?? null,
    row.state ?? null,
    JSON.stringify(row.name_variants ?? [])
  );
}

export function upsertCommittee(row) {
  db.prepare(
    `INSERT INTO committees (committee_id, name, chamber, sectors)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(committee_id) DO UPDATE SET
       name = excluded.name,
       chamber = excluded.chamber,
       sectors = excluded.sectors`
  ).run(row.committee_id, row.name, row.chamber ?? null, JSON.stringify(row.sectors ?? []));
}

export function replaceCommitteeMemberships(rows) {
  const tx = db.transaction((memberships) => {
    db.prepare(`DELETE FROM committee_memberships`).run();
    const insert = db.prepare(
      `INSERT OR REPLACE INTO committee_memberships (bioguide_id, committee_id, role)
       VALUES (?, ?, ?)`
    );
    for (const row of memberships) {
      insert.run(row.bioguide_id, row.committee_id, row.role ?? 'member');
    }
  });
  tx(rows);
}

export function listPoliticianIdentities() {
  return db.prepare(`SELECT * FROM politicians ORDER BY full_name`).all().map((row) => ({
    ...row,
    name_variants: row.name_variants ? JSON.parse(row.name_variants) : [],
  }));
}

export function listUnlinkedArchivePoliticianNames() {
  return db
    .prepare(
      `SELECT politician, COUNT(*) AS trades
       FROM congress_trades
       WHERE politician_id IS NULL AND politician IS NOT NULL
       GROUP BY politician ORDER BY trades DESC, politician ASC`
    )
    .all();
}

export function linkArchivePoliticianName(politician, bioguideId) {
  const res = db
    .prepare(`UPDATE congress_trades SET politician_id = ? WHERE politician = ? AND politician_id IS NULL`)
    .run(bioguideId, politician);
  return res.changes;
}

export function addPoliticianNameVariant(bioguideId, variant) {
  const row = db.prepare(`SELECT name_variants FROM politicians WHERE bioguide_id = ?`).get(bioguideId);
  if (!row) return;
  const variants = new Set(row.name_variants ? JSON.parse(row.name_variants) : []);
  if (variant) variants.add(variant);
  db.prepare(`UPDATE politicians SET name_variants = ? WHERE bioguide_id = ?`)
    .run(JSON.stringify([...variants].sort()), bioguideId);
}

export function upsertBill(row) {
  db.prepare(
    `INSERT INTO bills (
       bill_id, title, policy_area, latest_action, latest_action_date, committees,
       sectors, source_url, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
     ON CONFLICT(bill_id) DO UPDATE SET
       title = excluded.title,
       policy_area = excluded.policy_area,
       latest_action = excluded.latest_action,
       latest_action_date = excluded.latest_action_date,
       committees = excluded.committees,
       sectors = excluded.sectors,
       source_url = excluded.source_url,
       updated_at = COALESCE(excluded.updated_at, datetime('now'))`
  ).run(
    row.bill_id,
    row.title ?? null,
    row.policy_area ?? null,
    row.latest_action ?? null,
    row.latest_action_date ?? null,
    JSON.stringify(row.committees ?? []),
    JSON.stringify(row.sectors ?? []),
    row.source_url ?? null,
    row.updated_at ?? null
  );
}

export function upsertLobbyingFiling(row) {
  db.prepare(
    `INSERT INTO lobbying_filings (
       filing_id, client_name, registrant_name, ticker, amount, filing_period,
       filed_at, issues, source_url
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(filing_id) DO UPDATE SET
       client_name = excluded.client_name,
       registrant_name = excluded.registrant_name,
       ticker = excluded.ticker,
       amount = excluded.amount,
       filing_period = excluded.filing_period,
       filed_at = excluded.filed_at,
       issues = excluded.issues,
       source_url = excluded.source_url`
  ).run(
    row.filing_id,
    row.client_name ?? null,
    row.registrant_name ?? null,
    row.ticker ?? null,
    row.amount ?? null,
    row.filing_period ?? null,
    row.filed_at ?? null,
    JSON.stringify(row.issues ?? []),
    row.source_url ?? null
  );
}

export function upsertGovContract(row) {
  db.prepare(
    `INSERT INTO gov_contracts (
       contract_id, recipient_name, ticker, awarding_agency, amount, action_date, source_url
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(contract_id) DO UPDATE SET
       recipient_name = excluded.recipient_name,
       ticker = excluded.ticker,
       awarding_agency = excluded.awarding_agency,
       amount = excluded.amount,
       action_date = excluded.action_date,
       source_url = excluded.source_url`
  ).run(
    row.contract_id,
    row.recipient_name ?? null,
    row.ticker ?? null,
    row.awarding_agency ?? null,
    row.amount ?? null,
    row.action_date ?? null,
    row.source_url ?? null
  );
}

export function listTradedCompanyMeta() {
  return db
    .prepare(
      `SELECT DISTINCT tm.ticker, tm.company_name, tm.cik, tm.sector
       FROM congress_trades ct
       JOIN ticker_meta tm ON tm.ticker = ct.ticker
       WHERE tm.company_name IS NOT NULL
       ORDER BY tm.ticker`
    )
    .all();
}

export function upsertPoliticianStats(row) {
  db.prepare(
    `INSERT INTO politician_stats (
       politician, as_of, trade_count, buy_count, sell_count, median_disclosure_lag,
       avg_amount_mid, win_rate_30d, win_rate_90d, avg_return_7d, avg_return_30d,
       avg_return_90d, avg_return_180d, best_hold_window, sector_returns,
       concentration_hhi, recent_avg_return_30d, edge_score, stats
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(politician) DO UPDATE SET
       as_of = excluded.as_of,
       trade_count = excluded.trade_count,
       buy_count = excluded.buy_count,
       sell_count = excluded.sell_count,
       median_disclosure_lag = excluded.median_disclosure_lag,
       avg_amount_mid = excluded.avg_amount_mid,
       win_rate_30d = excluded.win_rate_30d,
       win_rate_90d = excluded.win_rate_90d,
       avg_return_7d = excluded.avg_return_7d,
       avg_return_30d = excluded.avg_return_30d,
       avg_return_90d = excluded.avg_return_90d,
       avg_return_180d = excluded.avg_return_180d,
       best_hold_window = excluded.best_hold_window,
       sector_returns = excluded.sector_returns,
       concentration_hhi = excluded.concentration_hhi,
       recent_avg_return_30d = excluded.recent_avg_return_30d,
       edge_score = excluded.edge_score,
       stats = excluded.stats`
  ).run(
    row.politician, row.as_of, row.trade_count, row.buy_count, row.sell_count,
    row.median_disclosure_lag, row.avg_amount_mid, row.win_rate_30d, row.win_rate_90d,
    row.avg_return_7d, row.avg_return_30d, row.avg_return_90d, row.avg_return_180d,
    row.best_hold_window, JSON.stringify(row.sector_returns ?? {}),
    row.concentration_hhi, row.recent_avg_return_30d, row.edge_score,
    JSON.stringify(row.stats ?? {})
  );
}

function parsePoliticianStatsRow(row) {
  if (!row) return null;
  return {
    ...row,
    sector_returns: row.sector_returns ? JSON.parse(row.sector_returns) : {},
    stats: row.stats ? JSON.parse(row.stats) : {},
  };
}

export function listPoliticianStats({ limit = 500 } = {}) {
  return db
    .prepare(`SELECT * FROM politician_stats ORDER BY edge_score IS NULL, edge_score DESC, trade_count DESC LIMIT ?`)
    .all(limit)
    .map(parsePoliticianStatsRow);
}

export function getPoliticianStats(politician) {
  return parsePoliticianStatsRow(
    db.prepare(`SELECT * FROM politician_stats WHERE politician = ?`).get(politician)
  );
}

function parseTradeScoreRow(row) {
  if (!row) return null;
  return {
    ...row,
    factors: row.factors ? JSON.parse(row.factors) : {},
    warnings: row.warnings ? JSON.parse(row.warnings) : [],
  };
}

export function upsertTradeScore({ tradeKey, score, confidence, recommendation, factors, warnings, inputsHash }) {
  db.prepare(
    `INSERT INTO trade_scores
       (trade_key, score, confidence, recommendation, factors, warnings, computed_at, inputs_hash)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(trade_key) DO UPDATE SET
       score = excluded.score,
       confidence = excluded.confidence,
       recommendation = excluded.recommendation,
       factors = excluded.factors,
       warnings = excluded.warnings,
       computed_at = datetime('now'),
       inputs_hash = excluded.inputs_hash`
  ).run(
    tradeKey,
    score,
    confidence,
    recommendation,
    JSON.stringify(factors ?? {}),
    JSON.stringify(warnings ?? []),
    inputsHash ?? null
  );
  return getTradeScore(tradeKey);
}

export function getTradeScore(tradeKey) {
  return parseTradeScoreRow(db.prepare(`SELECT * FROM trade_scores WHERE trade_key = ?`).get(tradeKey));
}

function parseThesisCardRow(row) {
  if (!row) return null;
  return { ...row, card: row.card ? JSON.parse(row.card) : null };
}

export function getThesisCard(tradeKey) {
  return parseThesisCardRow(db.prepare(`SELECT * FROM thesis_cards WHERE trade_key = ?`).get(tradeKey));
}

export function upsertThesisCard({ tradeKey, card, polished, scoreComputedAt }) {
  db.prepare(
    `INSERT INTO thesis_cards (trade_key, card, polished, score_computed_at, computed_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(trade_key) DO UPDATE SET
       card = excluded.card,
       polished = excluded.polished,
       score_computed_at = excluded.score_computed_at,
       computed_at = datetime('now')`
  ).run(tradeKey, JSON.stringify(card ?? {}), polished ?? null, scoreComputedAt ?? null);
  return getThesisCard(tradeKey);
}

export function listRecentTradeKeys(days = 60) {
  return db
    .prepare(
      `SELECT trade_key FROM congress_trades
       WHERE COALESCE(first_seen_at, disclosure_date, transaction_date) >= date('now', ?)
       ORDER BY disclosure_date DESC, id DESC`
    )
    .all(`-${days} days`)
    .map((r) => r.trade_key);
}

export function countClusterTrades({ ticker, type, disclosureDate, days = 30 }) {
  if (!ticker || !type || !disclosureDate) return 1;
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT politician) AS n
       FROM congress_trades
       WHERE ticker = ?
         AND type = ?
         AND disclosure_date BETWEEN date(?, ?) AND ?`
    )
    .get(ticker, type, disclosureDate, `-${days} days`, disclosureDate);
  return Math.max(1, Number(row?.n ?? 0));
}

export function countRepeatBuys({ tradeKey, politician, ticker, transactionDate, days = 90 }) {
  if (!politician || !ticker || !transactionDate) return 0;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM congress_trades
       WHERE politician = ?
         AND ticker = ?
         AND type = 'buy'
         AND trade_key != ?
         AND transaction_date BETWEEN date(?, ?) AND ?`
    )
    .get(politician, ticker, tradeKey ?? '', transactionDate, `-${days} days`, transactionDate);
  return Number(row?.n ?? 0);
}

export function listTradesWithScores({ since, minScore, recommendation, politician, ticker, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (since) { where.push('ct.disclosure_date >= ?'); params.push(since); }
  if (minScore != null) { where.push('ts.score >= ?'); params.push(minScore); }
  if (recommendation) { where.push('ts.recommendation = ?'); params.push(recommendation); }
  if (politician) { where.push('ct.politician = ?'); params.push(politician); }
  if (ticker) { where.push('ct.ticker = ?'); params.push(String(ticker).toUpperCase()); }
  const sql =
    `SELECT ct.*, ts.score, ts.confidence, ts.recommendation, ts.factors,
            ts.warnings, ts.computed_at AS score_computed_at
     FROM congress_trades ct
     LEFT JOIN trade_scores ts ON ts.trade_key = ct.trade_key
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ct.disclosure_date DESC, ct.id DESC
     LIMIT ?`;
  return db.prepare(sql).all(...params, limit).map((row) => ({
    ...row,
    factors: row.factors ? JSON.parse(row.factors) : null,
    warnings: row.warnings ? JSON.parse(row.warnings) : [],
  }));
}

function parseCommittee(row) {
  if (!row) return null;
  return { ...row, sectors: jsonOrNull(row.sectors) ?? [] };
}

function parseBill(row) {
  if (!row) return null;
  return {
    ...row,
    committees: jsonOrNull(row.committees) ?? [],
    sectors: jsonOrNull(row.sectors) ?? [],
  };
}

function parseLobbyingFiling(row) {
  if (!row) return null;
  return { ...row, issues: jsonOrNull(row.issues) ?? [] };
}

export function getTradeGraphContext(tradeKey) {
  const trade = getCongressTradeByKey(tradeKey);
  if (!trade) return null;
  const politician = trade.politician_id
    ? db.prepare(`SELECT * FROM politicians WHERE bioguide_id = ?`).get(trade.politician_id)
    : null;
  const committees = trade.politician_id
    ? db
      .prepare(
        `SELECT c.*, cm.role
         FROM committee_memberships cm
         JOIN committees c ON c.committee_id = cm.committee_id
         WHERE cm.bioguide_id = ?
         ORDER BY c.name`
      )
      .all(trade.politician_id)
      .map(parseCommittee)
    : [];
  const committeeIds = committees.map((c) => c.committee_id);
  const committeeSectors = new Set(committees.flatMap((c) => c.sectors || []));
  const tickerMeta = db.prepare(`SELECT * FROM ticker_meta WHERE ticker = ?`).get(trade.ticker) || null;
  const tickerSector = tickerMeta?.sector ?? null;
  const bills = db
    .prepare(
      `SELECT * FROM bills
       WHERE latest_action_date >= date(COALESCE(?, 'now'), '-180 days')
       ORDER BY latest_action_date DESC LIMIT 100`
    )
    .all(trade.disclosure_date || trade.transaction_date || null)
    .map(parseBill)
    .filter((bill) => {
      const billCommittees = new Set(bill.committees || []);
      const billSectors = new Set(bill.sectors || []);
      return (
        committeeIds.some((id) => billCommittees.has(id)) ||
        (tickerSector && billSectors.has(tickerSector)) ||
        [...billSectors].some((sector) => committeeSectors.has(sector))
      );
    });
  const lobbyingFilings = db
    .prepare(
      `SELECT * FROM lobbying_filings
       WHERE ticker = ?
         AND filed_at >= date(COALESCE(?, 'now'), '-365 days')
       ORDER BY filed_at DESC LIMIT 50`
    )
    .all(trade.ticker, trade.disclosure_date || trade.transaction_date || null)
    .map(parseLobbyingFiling);
  const contracts = db
    .prepare(
      `SELECT * FROM gov_contracts
       WHERE ticker = ?
         AND action_date >= date(COALESCE(?, 'now'), '-365 days')
       ORDER BY action_date DESC LIMIT 50`
    )
    .all(trade.ticker, trade.disclosure_date || trade.transaction_date || null);
  return {
    trade,
    politician: politician
      ? { ...politician, name_variants: jsonOrNull(politician.name_variants) ?? [] }
      : null,
    tickerMeta,
    committees,
    bills,
    lobbyingFilings,
    contracts,
  };
}

export function getPoliticianGraphContext(nameOrBioguideId) {
  const politician =
    db.prepare(`SELECT * FROM politicians WHERE bioguide_id = ?`).get(nameOrBioguideId) ||
    db.prepare(`SELECT * FROM politicians WHERE full_name = ?`).get(nameOrBioguideId);
  if (!politician) return null;
  const committees = db
    .prepare(
      `SELECT c.*, cm.role
       FROM committee_memberships cm
       JOIN committees c ON c.committee_id = cm.committee_id
       WHERE cm.bioguide_id = ?
       ORDER BY c.name`
    )
    .all(politician.bioguide_id)
    .map(parseCommittee);
  const committeeIds = new Set(committees.map((c) => c.committee_id));
  const committeeSectors = new Set(committees.flatMap((c) => c.sectors || []));
  const bills = db
    .prepare(`SELECT * FROM bills ORDER BY latest_action_date DESC LIMIT 200`)
    .all()
    .map(parseBill)
    .filter((bill) => (
      (bill.committees || []).some((id) => committeeIds.has(id)) ||
      (bill.sectors || []).some((sector) => committeeSectors.has(sector))
    ))
    .slice(0, 50);
  return {
    politician: { ...politician, name_variants: jsonOrNull(politician.name_variants) ?? [] },
    committees,
    bills,
  };
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

function jsonOrNull(value) {
  if (value == null) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function boolInt(value) {
  return value ? 1 : 0;
}

function parseYoutubeChannel(row) {
  if (!row) return null;
  return {
    ...row,
    tracking_enabled: !!row.tracking_enabled,
  };
}

function parseYoutubeVideo(row) {
  if (!row) return null;
  return {
    ...row,
    has_captions: row.has_captions == null ? null : !!row.has_captions,
    has_paid_product_placement: row.has_paid_product_placement == null ? null : !!row.has_paid_product_placement,
  };
}

function parseAsset(row) {
  if (!row) return null;
  return { ...row, is_active: !!row.is_active };
}

function parseMentionClassification(row) {
  if (!row) return null;
  return {
    ...row,
    evidence: row.evidence ? JSON.parse(row.evidence) : [],
    raw_model_output: jsonOrNull(row.raw_model_output),
    should_create_signal: !!row.should_create_signal,
    is_manual_override: !!row.is_manual_override,
  };
}

function parseInfluenceSignal(row) {
  if (!row) return null;
  return { ...row, evidence: jsonOrNull(row.evidence) ?? {} };
}

export function seedInfluenceDefaults() {
  const modules = [
    ['politics', 'Politics', 'Political trading and market-intelligence signals'],
    ['influence', 'Influence Signals', 'Public figure and public-source market influence signals'],
    ['youtube', 'YouTube', 'YouTube creator market-impact tracking'],
  ];
  const insertModule = db.prepare(
    `INSERT OR IGNORE INTO app_modules (key, name, description) VALUES (?, ?, ?)`
  );
  for (const m of modules) insertModule.run(...m);

  const assets = [
    ['equity', 'AAPL', 'Apple Inc.', 'NASDAQ', 'US', ['Apple', 'Apple stock', '$AAPL']],
    ['equity', 'TSLA', 'Tesla Inc.', 'NASDAQ', 'US', ['Tesla', 'Tesla stock', '$TSLA']],
    ['equity', 'NVDA', 'Nvidia Corp.', 'NASDAQ', 'US', ['Nvidia', 'NVIDIA', 'Nvidia stock', '$NVDA']],
    ['equity', 'MSFT', 'Microsoft Corp.', 'NASDAQ', 'US', ['Microsoft', 'Microsoft stock', '$MSFT']],
    ['crypto', 'BTC', 'Bitcoin', null, 'crypto', ['Bitcoin', 'BTC', '$BTC']],
    ['crypto', 'ETH', 'Ethereum', null, 'crypto', ['Ethereum', 'Ether', 'ETH', '$ETH']],
    ['crypto', 'SOL', 'Solana', null, 'crypto', ['Solana', 'SOL', '$SOL']],
  ];
  for (const [assetType, symbol, canonicalName, exchange, market, aliases] of assets) {
    const res = db.prepare(
      `INSERT OR IGNORE INTO assets (asset_type, symbol, canonical_name, exchange, market)
       VALUES (?, ?, ?, ?, ?)`
    ).run(assetType, symbol, canonicalName, exchange, market);
    const asset = res.changes > 0
      ? { id: res.lastInsertRowid }
      : db.prepare(`SELECT id FROM assets WHERE symbol = ?`).get(symbol);
    for (const alias of aliases) {
      db.prepare(
        `INSERT OR IGNORE INTO asset_aliases (asset_id, alias, alias_type, confidence)
         VALUES (?, ?, ?, ?)`
      ).run(asset.id, alias, alias.startsWith('$') ? 'cashtag' : 'common_name', 1);
    }
  }
}

seedInfluenceDefaults();

export function createYoutubeChannel(input) {
  const res = db.prepare(
    `INSERT INTO youtube_channels (
       youtube_channel_id, title, handle, custom_url, description, thumbnail_url,
       uploads_playlist_id, subscriber_count, video_count, view_count, country,
       language, category, influence_tier, tracking_enabled, risk_notes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.youtube_channel_id,
    input.title,
    input.handle ?? null,
    input.custom_url ?? null,
    input.description ?? null,
    input.thumbnail_url ?? null,
    input.uploads_playlist_id ?? null,
    input.subscriber_count ?? null,
    input.video_count ?? null,
    input.view_count ?? null,
    input.country ?? null,
    input.language ?? null,
    input.category ?? null,
    input.influence_tier ?? null,
    input.tracking_enabled === false ? 0 : 1,
    input.risk_notes ?? null
  );
  return getYoutubeChannel(res.lastInsertRowid);
}

export function upsertYoutubeChannel(input) {
  db.prepare(
    `INSERT INTO youtube_channels (
       youtube_channel_id, title, handle, custom_url, description, thumbnail_url,
       uploads_playlist_id, subscriber_count, video_count, view_count, country,
       language, category, influence_tier, tracking_enabled, risk_notes, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(youtube_channel_id) DO UPDATE SET
       title = excluded.title,
       handle = excluded.handle,
       custom_url = excluded.custom_url,
       description = excluded.description,
       thumbnail_url = excluded.thumbnail_url,
       uploads_playlist_id = excluded.uploads_playlist_id,
       subscriber_count = excluded.subscriber_count,
       video_count = excluded.video_count,
       view_count = excluded.view_count,
       country = excluded.country,
       language = excluded.language,
       category = COALESCE(excluded.category, youtube_channels.category),
       influence_tier = COALESCE(excluded.influence_tier, youtube_channels.influence_tier),
       tracking_enabled = excluded.tracking_enabled,
       risk_notes = COALESCE(excluded.risk_notes, youtube_channels.risk_notes),
       updated_at = datetime('now')`
  ).run(
    input.youtube_channel_id,
    input.title,
    input.handle ?? null,
    input.custom_url ?? null,
    input.description ?? null,
    input.thumbnail_url ?? null,
    input.uploads_playlist_id ?? null,
    input.subscriber_count ?? null,
    input.video_count ?? null,
    input.view_count ?? null,
    input.country ?? null,
    input.language ?? null,
    input.category ?? null,
    input.influence_tier ?? null,
    input.tracking_enabled === false ? 0 : 1,
    input.risk_notes ?? null
  );
  return getYoutubeChannelByYoutubeId(input.youtube_channel_id);
}

export function listYoutubeChannels({ limit = 500 } = {}) {
  return db.prepare(
    `SELECT yc.*,
            (SELECT COUNT(*) FROM youtube_videos yv WHERE yv.channel_id = yc.id) AS videos_analyzed,
            (SELECT COUNT(*) FROM asset_mentions am WHERE am.channel_id = yc.id) AS mentions_detected,
            (SELECT alpha_score FROM creator_alpha_metrics cam WHERE cam.channel_id = yc.id ORDER BY cam.calculated_at DESC LIMIT 1) AS alpha_score,
            (SELECT win_rate_30d FROM creator_alpha_metrics cam WHERE cam.channel_id = yc.id ORDER BY cam.calculated_at DESC LIMIT 1) AS win_rate_30d,
            (SELECT avg_return_30d FROM creator_alpha_metrics cam WHERE cam.channel_id = yc.id ORDER BY cam.calculated_at DESC LIMIT 1) AS avg_return_30d,
            (SELECT pump_dump_rate FROM creator_alpha_metrics cam WHERE cam.channel_id = yc.id ORDER BY cam.calculated_at DESC LIMIT 1) AS pump_risk_score
     FROM youtube_channels yc
     ORDER BY yc.title ASC LIMIT ?`
  ).all(limit).map(parseYoutubeChannel);
}

export function getYoutubeChannel(id) {
  return parseYoutubeChannel(db.prepare(`SELECT * FROM youtube_channels WHERE id = ?`).get(id));
}

export function getYoutubeChannelByYoutubeId(youtubeChannelId) {
  return parseYoutubeChannel(
    db.prepare(`SELECT * FROM youtube_channels WHERE youtube_channel_id = ?`).get(youtubeChannelId)
  );
}

export function updateYoutubeChannel(id, input) {
  const existing = getYoutubeChannel(id);
  if (!existing) return null;
  const next = { ...existing, ...input };
  db.prepare(
    `UPDATE youtube_channels SET
       youtube_channel_id = ?, title = ?, handle = ?, custom_url = ?, description = ?,
       thumbnail_url = ?, uploads_playlist_id = ?, subscriber_count = ?, video_count = ?,
       view_count = ?, country = ?, language = ?, category = ?, influence_tier = ?,
       tracking_enabled = ?, risk_notes = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    next.youtube_channel_id,
    next.title,
    next.handle ?? null,
    next.custom_url ?? null,
    next.description ?? null,
    next.thumbnail_url ?? null,
    next.uploads_playlist_id ?? null,
    next.subscriber_count ?? null,
    next.video_count ?? null,
    next.view_count ?? null,
    next.country ?? null,
    next.language ?? null,
    next.category ?? null,
    next.influence_tier ?? null,
    next.tracking_enabled === false ? 0 : 1,
    next.risk_notes ?? null,
    id
  );
  return getYoutubeChannel(id);
}

export function insertYoutubeChannelSnapshot(channelId, counts = {}) {
  db.prepare(
    `INSERT INTO youtube_channel_snapshots (channel_id, subscriber_count, video_count, view_count)
     VALUES (?, ?, ?, ?)`
  ).run(channelId, counts.subscriber_count ?? null, counts.video_count ?? null, counts.view_count ?? null);
}

export function markYoutubeChannelSynced(id) {
  db.prepare(`UPDATE youtube_channels SET last_synced_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
}

export function upsertYoutubeVideo(input) {
  db.prepare(
    `INSERT INTO youtube_videos (
       youtube_video_id, channel_id, title, description, published_at, duration_seconds,
       thumbnail_url, url, has_captions, has_paid_product_placement, default_language,
       default_audio_language, live_broadcast_content, ingestion_status, transcript_status,
       analysis_status, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(youtube_video_id) DO UPDATE SET
       channel_id = excluded.channel_id,
       title = excluded.title,
       description = excluded.description,
       published_at = excluded.published_at,
       duration_seconds = COALESCE(excluded.duration_seconds, youtube_videos.duration_seconds),
       thumbnail_url = COALESCE(excluded.thumbnail_url, youtube_videos.thumbnail_url),
       url = COALESCE(excluded.url, youtube_videos.url),
       has_captions = COALESCE(excluded.has_captions, youtube_videos.has_captions),
       has_paid_product_placement = COALESCE(excluded.has_paid_product_placement, youtube_videos.has_paid_product_placement),
       default_language = COALESCE(excluded.default_language, youtube_videos.default_language),
       default_audio_language = COALESCE(excluded.default_audio_language, youtube_videos.default_audio_language),
       live_broadcast_content = COALESCE(excluded.live_broadcast_content, youtube_videos.live_broadcast_content),
       ingestion_status = excluded.ingestion_status,
       updated_at = datetime('now')`
  ).run(
    input.youtube_video_id,
    input.channel_id,
    input.title,
    input.description ?? '',
    input.published_at,
    input.duration_seconds ?? null,
    input.thumbnail_url ?? null,
    input.url ?? `https://www.youtube.com/watch?v=${input.youtube_video_id}`,
    input.has_captions == null ? null : boolInt(input.has_captions),
    input.has_paid_product_placement == null ? null : boolInt(input.has_paid_product_placement),
    input.default_language ?? null,
    input.default_audio_language ?? null,
    input.live_broadcast_content ?? null,
    input.ingestion_status ?? 'metadata_fetched',
    input.transcript_status ?? 'not_requested',
    input.analysis_status ?? 'not_started'
  );
  return getYoutubeVideoByYoutubeId(input.youtube_video_id);
}

export function listYoutubeVideos({ channelId, limit = 200 } = {}) {
  const params = [];
  let where = '';
  if (channelId) { where = 'WHERE yv.channel_id = ?'; params.push(channelId); }
  params.push(limit);
  return db.prepare(
    `SELECT yv.*, yc.title AS channel_title
     FROM youtube_videos yv
     JOIN youtube_channels yc ON yc.id = yv.channel_id
     ${where}
     ORDER BY yv.published_at DESC, yv.id DESC LIMIT ?`
  ).all(...params).map(parseYoutubeVideo);
}

export function getYoutubeVideo(id) {
  return parseYoutubeVideo(db.prepare(
    `SELECT yv.*, yc.title AS channel_title
     FROM youtube_videos yv JOIN youtube_channels yc ON yc.id = yv.channel_id
     WHERE yv.id = ?`
  ).get(id));
}

export function getYoutubeVideoByYoutubeId(youtubeVideoId) {
  return parseYoutubeVideo(db.prepare(`SELECT * FROM youtube_videos WHERE youtube_video_id = ?`).get(youtubeVideoId));
}

export function insertYoutubeVideoSnapshot(videoId, stats = {}) {
  db.prepare(
    `INSERT INTO youtube_video_snapshots (video_id, view_count, like_count, comment_count)
     VALUES (?, ?, ?, ?)`
  ).run(videoId, stats.view_count ?? null, stats.like_count ?? null, stats.comment_count ?? null);
}

export function updateYoutubeVideoStatuses(id, statuses = {}) {
  const sets = [];
  const params = [];
  for (const key of ['ingestion_status', 'transcript_status', 'analysis_status']) {
    if (statuses[key]) { sets.push(`${key} = ?`); params.push(statuses[key]); }
  }
  if (sets.length === 0) return getYoutubeVideo(id);
  params.push(id);
  db.prepare(`UPDATE youtube_videos SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...params);
  return getYoutubeVideo(id);
}

export function createContentDocument({ source_type, source_id, provider_name, language, raw_text, source_format, authorization_status }) {
  const res = db.prepare(
    `INSERT INTO content_documents
       (source_type, source_id, provider_name, language, raw_text, source_format, authorization_status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(source_type, source_id, provider_name, language ?? null, raw_text, source_format ?? null, authorization_status ?? 'unknown');
  return res.lastInsertRowid;
}

export function insertContentSegments(documentId, segments) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO content_segments
       (document_id, segment_index, start_seconds, end_seconds, text, token_count)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      stmt.run(
        documentId,
        row.segment_index,
        row.start_seconds ?? null,
        row.end_seconds ?? null,
        row.text,
        row.token_count ?? Math.ceil(row.text.split(/\s+/).filter(Boolean).length)
      );
    }
  });
  tx(segments);
}

export function listContentDocumentsForVideo(videoId) {
  return db.prepare(
    `SELECT * FROM content_documents WHERE source_type = 'youtube_video' AND source_id = ? ORDER BY id DESC`
  ).all(videoId);
}

export function listContentSegmentsForVideo(videoId) {
  return db.prepare(
    `SELECT cs.*, cd.provider_name, cd.language, cd.source_format
     FROM content_segments cs
     JOIN content_documents cd ON cd.id = cs.document_id
     WHERE cd.source_type = 'youtube_video' AND cd.source_id = ?
     ORDER BY cd.id DESC, cs.segment_index ASC`
  ).all(videoId);
}

export function listAssets() {
  return db.prepare(`SELECT * FROM assets WHERE is_active = 1 ORDER BY asset_type, symbol`).all().map(parseAsset);
}

export function listAssetAliases() {
  return db.prepare(
    `SELECT aa.*, a.symbol, a.canonical_name, a.asset_type
     FROM asset_aliases aa JOIN assets a ON a.id = aa.asset_id
     WHERE a.is_active = 1 ORDER BY length(aa.alias) DESC`
  ).all();
}

export function getAsset(id) {
  return parseAsset(db.prepare(`SELECT * FROM assets WHERE id = ?`).get(id));
}

export function getAssetBySymbol(symbol) {
  return parseAsset(db.prepare(`SELECT * FROM assets WHERE symbol = ?`).get(String(symbol || '').toUpperCase()));
}

export function createAssetMention(input) {
  const res = db.prepare(
    `INSERT OR IGNORE INTO asset_mentions (
       asset_id, source_type, source_id, video_id, channel_id, segment_id, mention_text,
       surrounding_text, mention_start_seconds, mention_end_seconds, event_time,
       detection_method, entity_confidence
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.asset_id,
    input.source_type,
    input.source_id,
    input.video_id ?? null,
    input.channel_id ?? null,
    input.segment_id ?? null,
    input.mention_text,
    input.surrounding_text ?? null,
    input.mention_start_seconds ?? null,
    input.mention_end_seconds ?? null,
    input.event_time,
    input.detection_method ?? 'hybrid',
    input.entity_confidence
  );
  if (res.changes > 0) return res.lastInsertRowid;
  const existing = db.prepare(
    `SELECT id FROM asset_mentions
     WHERE asset_id = ? AND source_type = ? AND source_id = ? AND mention_text = ?
       AND (mention_start_seconds IS ? OR mention_start_seconds = ?)
     ORDER BY id DESC LIMIT 1`
  ).get(input.asset_id, input.source_type, input.source_id, input.mention_text, input.mention_start_seconds ?? null, input.mention_start_seconds ?? null);
  return existing?.id ?? null;
}

export function listAssetMentions({ videoId, channelId, assetId, limit = 500 } = {}) {
  const where = [];
  const params = [];
  if (videoId) { where.push('am.video_id = ?'); params.push(videoId); }
  if (channelId) { where.push('am.channel_id = ?'); params.push(channelId); }
  if (assetId) { where.push('am.asset_id = ?'); params.push(assetId); }
  params.push(limit);
  return db.prepare(
    `SELECT am.*, a.symbol, a.canonical_name, a.asset_type, yc.title AS channel_title, yv.title AS video_title,
            mc.direction, mc.mention_type, mc.mention_quality_score, mc.summary,
            mc.pump_risk_score, mc.relevance_score, mc.conviction_score
     FROM asset_mentions am
     JOIN assets a ON a.id = am.asset_id
     LEFT JOIN youtube_channels yc ON yc.id = am.channel_id
     LEFT JOIN youtube_videos yv ON yv.id = am.video_id
     LEFT JOIN mention_classifications mc ON mc.id = (
       SELECT id FROM mention_classifications WHERE mention_id = am.id ORDER BY id DESC LIMIT 1
     )
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY am.event_time DESC, am.id DESC LIMIT ?`
  ).all(...params);
}

export function getAssetMention(id) {
  return db.prepare(
    `SELECT am.*, a.symbol, a.canonical_name, a.asset_type, yc.title AS channel_title, yv.title AS video_title
     FROM asset_mentions am
     JOIN assets a ON a.id = am.asset_id
     LEFT JOIN youtube_channels yc ON yc.id = am.channel_id
     LEFT JOIN youtube_videos yv ON yv.id = am.video_id
     WHERE am.id = ?`
  ).get(id) || null;
}

export function createMentionClassification(input) {
  const res = db.prepare(
    `INSERT INTO mention_classifications (
       mention_id, direction, conviction_score, relevance_score, directness_score,
       sponsorship_risk_score, pump_risk_score, time_horizon, mention_type, summary,
       evidence, should_create_signal, mention_quality_score, model_name, model_version,
       prompt_version, raw_model_output, is_manual_override
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.mention_id,
    input.direction,
    input.conviction_score,
    input.relevance_score,
    input.directness_score,
    input.sponsorship_risk_score,
    input.pump_risk_score,
    input.time_horizon ?? 'unknown',
    input.mention_type,
    input.summary,
    JSON.stringify(input.evidence ?? []),
    boolInt(input.should_create_signal),
    input.mention_quality_score ?? null,
    input.model_name ?? null,
    input.model_version ?? null,
    input.prompt_version ?? null,
    input.raw_model_output ? JSON.stringify(input.raw_model_output) : null,
    boolInt(input.is_manual_override)
  );
  return parseMentionClassification(db.prepare(`SELECT * FROM mention_classifications WHERE id = ?`).get(res.lastInsertRowid));
}

export function listMentionClassifications(mentionId) {
  return db.prepare(`SELECT * FROM mention_classifications WHERE mention_id = ? ORDER BY id DESC`)
    .all(mentionId)
    .map(parseMentionClassification);
}

export function createYoutubeBacktestRun({ name, strategy_config, start_date, end_date, status = 'queued' }) {
  const res = db.prepare(
    `INSERT INTO youtube_backtest_runs (name, strategy_config, start_date, end_date, status)
     VALUES (?, ?, ?, ?, ?)`
  ).run(name, JSON.stringify(strategy_config ?? {}), start_date ?? null, end_date ?? null, status);
  return res.lastInsertRowid;
}

export function updateYoutubeBacktestRun(id, { status, completed_at } = {}) {
  db.prepare(
    `UPDATE youtube_backtest_runs SET status = COALESCE(?, status), completed_at = COALESCE(?, completed_at) WHERE id = ?`
  ).run(status ?? null, completed_at ?? null, id);
}

export function insertYoutubeBacktestSignalResult(input) {
  db.prepare(
    `INSERT INTO youtube_backtest_signal_results (
       backtest_run_id, signal_event_id, mention_id, asset_id, entry_time, entry_price,
       exit_1h_price, exit_6h_price, exit_24h_price, exit_7d_price, exit_30d_price,
       exit_90d_price, return_1h, return_6h, return_24h, return_7d, return_30d,
       return_90d, max_drawdown_30d, max_runup_30d, volume_change_24h,
       benchmark_return_30d, result_metadata
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.backtest_run_id,
    input.signal_event_id ?? null,
    input.mention_id ?? null,
    input.asset_id,
    input.entry_time,
    input.entry_price ?? null,
    input.exit_1h_price ?? null,
    input.exit_6h_price ?? null,
    input.exit_24h_price ?? null,
    input.exit_7d_price ?? null,
    input.exit_30d_price ?? null,
    input.exit_90d_price ?? null,
    input.return_1h ?? null,
    input.return_6h ?? null,
    input.return_24h ?? null,
    input.return_7d ?? null,
    input.return_30d ?? null,
    input.return_90d ?? null,
    input.max_drawdown_30d ?? null,
    input.max_runup_30d ?? null,
    input.volume_change_24h ?? null,
    input.benchmark_return_30d ?? null,
    JSON.stringify(input.result_metadata ?? {})
  );
}

function parseBacktestRun(row) {
  if (!row) return null;
  return { ...row, strategy_config: JSON.parse(row.strategy_config) };
}

export function listYoutubeBacktestRuns() {
  return db.prepare(`SELECT * FROM youtube_backtest_runs ORDER BY id DESC LIMIT 100`).all().map(parseBacktestRun);
}

export function getYoutubeBacktestRun(id) {
  const run = parseBacktestRun(db.prepare(`SELECT * FROM youtube_backtest_runs WHERE id = ?`).get(id));
  if (!run) return null;
  const results = db.prepare(
    `SELECT r.*, a.symbol, a.canonical_name, am.mention_text
     FROM youtube_backtest_signal_results r
     JOIN assets a ON a.id = r.asset_id
     LEFT JOIN asset_mentions am ON am.id = r.mention_id
     WHERE r.backtest_run_id = ? ORDER BY r.id ASC`
  ).all(id).map((r) => ({ ...r, result_metadata: jsonOrNull(r.result_metadata) ?? {} }));
  return { ...run, results };
}

export function replaceCreatorAlphaMetric(input) {
  db.prepare(
    `INSERT INTO creator_alpha_metrics (
       channel_id, asset_type, direction, mention_type, sample_size, avg_return_1h,
       avg_return_6h, avg_return_24h, avg_return_7d, avg_return_30d, avg_return_90d,
       win_rate_24h, win_rate_7d, win_rate_30d, median_return_30d, volatility_30d,
       pump_dump_rate, fade_score, alpha_score, label
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.channel_id,
    input.asset_type ?? null,
    input.direction ?? null,
    input.mention_type ?? null,
    input.sample_size,
    input.avg_return_1h ?? null,
    input.avg_return_6h ?? null,
    input.avg_return_24h ?? null,
    input.avg_return_7d ?? null,
    input.avg_return_30d ?? null,
    input.avg_return_90d ?? null,
    input.win_rate_24h ?? null,
    input.win_rate_7d ?? null,
    input.win_rate_30d ?? null,
    input.median_return_30d ?? null,
    input.volatility_30d ?? null,
    input.pump_dump_rate ?? null,
    input.fade_score ?? null,
    input.alpha_score ?? null,
    input.label ?? null
  );
}

export function getCreatorAlpha(channelId) {
  return db.prepare(
    `SELECT * FROM creator_alpha_metrics WHERE channel_id = ? ORDER BY calculated_at DESC, id DESC LIMIT 20`
  ).all(channelId);
}

export function upsertInfluenceSignalEvent(input) {
  db.prepare(
    `INSERT OR IGNORE INTO influence_signal_events (
       source_type, source_id, module_key, asset_id, event_time, direction, confidence,
       strength_score, actionability_score, suggested_action, title, explanation, evidence, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.source_type,
    input.source_id,
    input.module_key,
    input.asset_id,
    input.event_time,
    input.direction,
    input.confidence,
    input.strength_score,
    input.actionability_score,
    input.suggested_action,
    input.title,
    input.explanation,
    JSON.stringify(input.evidence ?? {}),
    input.status ?? 'active'
  );
  return db.prepare(
    `SELECT * FROM influence_signal_events
     WHERE source_type = ? AND source_id = ? AND module_key = ? AND asset_id = ? AND direction = ?`
  ).get(input.source_type, input.source_id, input.module_key, input.asset_id, input.direction);
}

export function listInfluenceSignals({ moduleKey, limit = 100 } = {}) {
  const params = [];
  let where = '';
  if (moduleKey) { where = 'WHERE ise.module_key = ?'; params.push(moduleKey); }
  params.push(limit);
  return db.prepare(
    `SELECT ise.*, a.symbol, a.canonical_name, a.asset_type
     FROM influence_signal_events ise
     JOIN assets a ON a.id = ise.asset_id
     ${where}
     ORDER BY ise.id DESC LIMIT ?`
  ).all(...params).map(parseInfluenceSignal);
}

export function getInfluenceSignal(id) {
  return parseInfluenceSignal(db.prepare(
    `SELECT ise.*, a.symbol, a.canonical_name, a.asset_type
     FROM influence_signal_events ise JOIN assets a ON a.id = ise.asset_id
     WHERE ise.id = ?`
  ).get(id));
}

export function updateInfluenceSignal(id, input) {
  const existing = getInfluenceSignal(id);
  if (!existing) return null;
  db.prepare(
    `UPDATE influence_signal_events SET status = COALESCE(?, status), suggested_action = COALESCE(?, suggested_action)
     WHERE id = ?`
  ).run(input.status ?? null, input.suggested_action ?? null, id);
  return getInfluenceSignal(id);
}

export function getYoutubeDashboardStats() {
  const one = (sql) => db.prepare(sql).get();
  return {
    videosAnalyzedToday: one(`SELECT COUNT(*) AS n FROM youtube_videos WHERE date(created_at) = date('now')`)?.n ?? 0,
    newAssetMentions: one(`SELECT COUNT(*) AS n FROM asset_mentions WHERE date(created_at) = date('now')`)?.n ?? 0,
    highQualityBullishMentions: one(
      `SELECT COUNT(*) AS n FROM mention_classifications WHERE direction = 'bullish' AND mention_quality_score >= 70`
    )?.n ?? 0,
    highQualityBearishMentions: one(
      `SELECT COUNT(*) AS n FROM mention_classifications WHERE direction = 'bearish' AND mention_quality_score >= 70`
    )?.n ?? 0,
    highPumpRiskMentions: one(`SELECT COUNT(*) AS n FROM mention_classifications WHERE pump_risk_score >= 70`)?.n ?? 0,
    channelsTracked: one(`SELECT COUNT(*) AS n FROM youtube_channels WHERE tracking_enabled = 1`)?.n ?? 0,
    topCreators: db.prepare(
      `SELECT yc.id, yc.title, cam.alpha_score, cam.sample_size, cam.label
       FROM creator_alpha_metrics cam JOIN youtube_channels yc ON yc.id = cam.channel_id
       ORDER BY cam.alpha_score DESC LIMIT 5`
    ).all(),
    trendingAssets: db.prepare(
      `SELECT a.id, a.symbol, a.canonical_name, COUNT(*) AS mentions
       FROM asset_mentions am JOIN assets a ON a.id = am.asset_id
       GROUP BY a.id ORDER BY mentions DESC LIMIT 10`
    ).all(),
  };
}
