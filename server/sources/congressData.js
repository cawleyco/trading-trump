import axios from 'axios';
import pRetry from 'p-retry';
import { config } from '../config.js';
import { fetchSenateTrades } from './senateEfd.js';
import { parseAmountRange } from '../lib/amountRange.js';
import { assessTrade } from '../lib/filingQuality.js';
import { resolveTicker } from './tickerMeta.js';
import { upsertCongressTrade, findAmendableTradeKey, enqueueReview } from '../db.js';

// Trades below this parse confidence are queued for human review and (later
// phases) barred from auto-trading / strategy auto modes.
export const REVIEW_CONFIDENCE_THRESHOLD = 0.8;

// Normalized congress trade shape used by both the live poller and the backtester:
// { politician, ticker, type: 'buy'|'sell', transactionDate, disclosureDate, amountRange, raw }
//
// Sources:
//  - Quiver Quantitative (paid API key): House + Senate, live + historical
//  - Senate eFD official site (free, no key): Senate only, scraped directly

const QUIVER_BASE = 'https://api.quiverquant.com/beta';

function normalizeType(raw) {
  const t = String(raw || '').toLowerCase();
  if (t.includes('purchase') || t.includes('buy')) return 'buy';
  if (t.includes('sale') || t.includes('sell') || t.includes('sold')) return 'sell';
  return null;
}

/** Source data carries stray whitespace/trailing commas ("Jerry Moran,") that
 * split one politician into several dropdown entries and break filters.
 * Applied at the backtest read path, NOT at ingest — trade keys already stored
 * in the archive embed the raw name, and rewriting keys would duplicate rows. */
export function cleanPoliticianName(name) {
  return String(name || '').replace(/\s+/g, ' ').replace(/[,\s]+$/, '').trim();
}

function normalizeQuiver(row) {
  const type = normalizeType(row.Transaction);
  if (!type || !row.Ticker) return null;
  return {
    politician: row.Representative || row.Senator || row.Name || 'Unknown',
    ticker: String(row.Ticker).trim().toUpperCase(),
    type,
    transactionDate: row.TransactionDate || row.Date || null,
    disclosureDate: row.ReportDate || row.Filed || row.TransactionDate || null,
    amountRange: row.Range || row.Amount || null,
    raw: row,
  };
}

async function fetchQuiver(path) {
  return pRetry(
    async () => {
      const resp = await axios.get(`${QUIVER_BASE}${path}`, {
        headers: {
          Authorization: `Bearer ${config.quiverApiKey}`,
          Accept: 'application/json',
        },
        timeout: 60000,
      });
      return resp.data;
    },
    { retries: 3, minTimeout: 2000 }
  );
}

/** Recent congress trades from Quiver (requires QUIVER_API_KEY). */
export async function fetchQuiverRecent() {
  const data = await fetchQuiver('/live/congresstrading');
  return (Array.isArray(data) ? data : []).map(normalizeQuiver).filter(Boolean);
}

/**
 * Historical trades for backtesting between two ISO dates.
 * Quiver when a key is configured (House + Senate); otherwise the official
 * Senate eFD site (Senate only, capped at maxFilings PTR pages).
 */
export async function fetchHistoricalCongressTrades(startDate, endDate, maxFilings = 300) {
  if (config.quiverApiKey) {
    const data = await fetchQuiver('/live/congresstrading');
    return (Array.isArray(data) ? data : [])
      .map(normalizeQuiver)
      .filter(Boolean)
      .filter((t) => t.disclosureDate && t.disclosureDate >= startDate && t.disclosureDate <= endDate);
  }
  return fetchSenateTrades(startDate, endDate, maxFilings);
}

/** Recent trades for the live poller. */
export async function fetchRecentCongressTrades() {
  if (config.quiverApiKey) {
    return fetchQuiverRecent();
  }
  const start = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
  return fetchSenateTrades(start, null, 60);
}

export function tradeKey(t) {
  return [t.politician, t.ticker, t.transactionDate, t.type, t.amountRange].join('|');
}

/**
 * Upsert one normalized trade into the congress_trades archive. Shared by the
 * live poller and the backfill script. `firstSeenAt` defaults to now; the
 * backfill passes the disclosure date (best available publish-time estimate).
 * Returns { id, isNew }.
 */
export function archiveTrade(trade, { firstSeenAt = null } = {}) {
  const { min, max, mid } = parseAmountRange(trade.amountRange);
  const raw = trade.raw || {};
  const isSenateEfd = raw.chamber === 'senate' && raw.docId;
  const key = tradeKey(trade);

  const quality = assessTrade(trade, { resolveTicker });

  // Amendment detection: filings whose title marks them an amendment point at
  // an earlier archived row for the same politician/ticker/transaction date.
  let amendmentOf = null;
  if (/\(?amendment/i.test(String(raw.reportTitle || ''))) {
    amendmentOf = findAmendableTradeKey({
      politician: trade.politician,
      ticker: trade.ticker,
      transactionDate: trade.transactionDate,
      excludeKey: key,
    });
  }

  const result = upsertCongressTrade({
    tradeKey: key,
    politician: trade.politician,
    ticker: trade.ticker,
    type: trade.type,
    transactionDate: trade.transactionDate,
    disclosureDate: trade.disclosureDate,
    firstSeenAt,
    amountRange: trade.amountRange,
    amountMin: min,
    amountMax: max,
    amountMid: mid,
    assetDescription: quality.assetDescription,
    owner: quality.owner,
    isOption: quality.isOption,
    optionDetail: quality.optionDetail,
    parseConfidence: quality.parseConfidence,
    amendmentOf,
    source: isSenateEfd ? 'senate-efd' : 'quiver',
    sourceUrl: raw.url ?? null,
    raw: { ...raw, _qualityFlags: quality.flags },
  });

  // Low-confidence filings are queued for human review at ingest.
  if (result.isNew && quality.parseConfidence < REVIEW_CONFIDENCE_THRESHOLD) {
    enqueueReview({
      tradeKey: key,
      reason: `parse_confidence ${quality.parseConfidence} < ${REVIEW_CONFIDENCE_THRESHOLD}` +
        (quality.flags.length ? ` (${quality.flags.join(', ')})` : ''),
    });
  }

  return result;
}
