// Ticker metadata: company name + CIK from the SEC ticker universe, and
// SIC-derived coarse sector, cached in the ticker_meta table. Also the
// entity-resolution entry point (resolveTicker) used by data quality and,
// later, the knowledge graph.
//
// SEC data changes slowly; raw responses are cached on disk under
// data-cache/ with a TTL, and the table itself is only refreshed weekly.

import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import pRetry from 'p-retry';
import { db } from '../db.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { sicToSector } from '../lib/sicSectors.js';
import { resolveWithPrecedence } from '../lib/tickerOverrides.js';

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SUBMISSIONS_URL = (cik10) => `https://data.sec.gov/submissions/CIK${cik10}.json`;
const UNIVERSE_TTL_MS = 7 * 86400_000;
const SUBMISSIONS_TTL_MS = 30 * 86400_000;

const USER_AGENT =
  `trading-bot personal research${config.secContactEmail ? ` ${config.secContactEmail}` : ''}`;

// ---------------------------------------------------------------------------
// Disk cache for raw SEC responses (data-cache/, gitignored)
// ---------------------------------------------------------------------------

function cachePath(name) {
  return path.join(config.dataCacheDir, name);
}

function readCache(name, ttlMs) {
  try {
    const file = cachePath(name);
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > ttlMs) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(name, data) {
  try {
    fs.mkdirSync(config.dataCacheDir, { recursive: true });
    fs.writeFileSync(cachePath(name), JSON.stringify(data));
  } catch (err) {
    log.warn('ticker-meta', `Failed to write data-cache/${name}: ${err.message}`);
  }
}

async function fetchSecJson(url, cacheName, ttlMs) {
  const cached = readCache(cacheName, ttlMs);
  if (cached) return cached;
  const data = await pRetry(
    async () => {
      const resp = await axios.get(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        timeout: 60000,
      });
      return resp.data;
    },
    { retries: 3, minTimeout: 2000 }
  );
  writeCache(cacheName, data);
  return data;
}

// ---------------------------------------------------------------------------
// Ticker universe (ticker → company name + CIK)
// ---------------------------------------------------------------------------

const upsertMeta = db.prepare(
  `INSERT INTO ticker_meta (ticker, company_name, cik, updated_at)
   VALUES (?, ?, ?, datetime('now'))
   ON CONFLICT(ticker) DO UPDATE SET
     company_name = excluded.company_name,
     cik = excluded.cik,
     updated_at = datetime('now')`
);

/** Download the SEC ticker universe and upsert ticker → name/CIK. */
export async function refreshTickerUniverse() {
  const data = await fetchSecJson(TICKERS_URL, 'company_tickers.json', UNIVERSE_TTL_MS);
  // shape: { "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." }, ... }
  const rows = Object.values(data || {}).filter((r) => r && r.ticker);
  const insertAll = db.transaction((all) => {
    for (const r of all) {
      upsertMeta.run(String(r.ticker).toUpperCase(), r.title ?? null, String(r.cik_str ?? ''));
    }
  });
  insertAll(rows);
  log.info('ticker-meta', `Ticker universe refreshed: ${rows.length} tickers`);
  return rows.length;
}

/**
 * Refresh at startup when the table is empty or older than 7 days.
 * Runs in the background; failures are logged, never thrown.
 */
export async function ensureTickerUniverse() {
  try {
    const newest = db.prepare(`SELECT MAX(updated_at) AS m FROM ticker_meta`).get().m;
    const stale = !newest || Date.now() - new Date(`${newest.replace(' ', 'T')}Z`).getTime() > UNIVERSE_TTL_MS;
    if (stale) await refreshTickerUniverse();
  } catch (err) {
    log.warn('ticker-meta', `Ticker universe refresh failed (will retry next start): ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Sector lookup (SIC via SEC submissions, cached in the table)
// ---------------------------------------------------------------------------

/** Coarse sector for a ticker, fetching + caching the SIC on first use. Null when unknown. */
export async function getSectorForTicker(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!t) return null;
  const row = db.prepare(`SELECT * FROM ticker_meta WHERE ticker = ?`).get(t);
  if (!row) return null;
  if (row.sector) return row.sector;
  if (!row.cik) return null;
  try {
    const cik10 = String(row.cik).padStart(10, '0');
    const data = await fetchSecJson(
      SUBMISSIONS_URL(cik10),
      `submissions-CIK${cik10}.json`,
      SUBMISSIONS_TTL_MS
    );
    const sector = sicToSector(data?.sic);
    if (sector) {
      db.prepare(
        `UPDATE ticker_meta SET sic = ?, sector = ?, updated_at = datetime('now') WHERE ticker = ?`
      ).run(String(data.sic ?? ''), sector, t);
    }
    return sector;
  } catch (err) {
    log.warn('ticker-meta', `Sector lookup for ${t} failed: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Entity resolution (name or ticker → ticker)
// ---------------------------------------------------------------------------

/**
 * Resolve a ticker symbol or company name to a known ticker, or null.
 * Precedence: manual override map → exact ticker match → case-insensitive
 * company-name match (shortest matching name wins).
 */
export function resolveTicker(nameOrTicker) {
  return resolveWithPrecedence(nameOrTicker, {
    byTicker: (t) =>
      db.prepare(`SELECT ticker FROM ticker_meta WHERE ticker = ?`).get(t)?.ticker ?? null,
    byName: (name) =>
      db
        .prepare(
          `SELECT ticker FROM ticker_meta WHERE company_name LIKE ?
           ORDER BY LENGTH(company_name) ASC LIMIT 1`
        )
        .get(`%${name}%`)?.ticker ?? null,
  });
}
