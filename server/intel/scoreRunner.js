import crypto from 'node:crypto';
import {
  countClusterTrades,
  countRepeatBuys,
  getCongressTradeByKey,
  getPoliticianStats,
  getTradeScore,
  listRecentTradeKeys,
  upsertTradeScore,
} from '../db.js';
import { avgDollarVolume, driftSincePct } from '../marketData.js';
import { log } from '../logger.js';
import { computeCopyScore } from './copyScore.js';
import { computeRelevance } from './relevance.js';

function hashInputs(input) {
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function scorePayload(trade, ctx) {
  return {
    trade: {
      trade_key: trade.trade_key,
      politician: trade.politician,
      ticker: trade.ticker,
      type: trade.type,
      transaction_date: trade.transaction_date,
      disclosure_date: trade.disclosure_date,
      first_seen_at: trade.first_seen_at,
      amount_mid: trade.amount_mid,
      owner: trade.owner,
      is_option: trade.is_option,
      parse_confidence: trade.parse_confidence,
    },
    ctx,
  };
}

async function buildScoreContext(trade, opts = {}) {
  const [driftPct, adv, relevance] = await Promise.all([
    opts.driftFn ? opts.driftFn(trade.ticker, trade.transaction_date) : driftSincePct(trade.ticker, trade.transaction_date),
    opts.avgDollarVolumeFn ? opts.avgDollarVolumeFn(trade.ticker) : avgDollarVolume(trade.ticker),
    opts.relevance ?? computeRelevance(trade),
  ]);
  return {
    now: opts.now ?? todayIso(),
    politicianStats: opts.politicianStats ?? getPoliticianStats(trade.politician),
    driftPct,
    avgDollarVolume: adv,
    clusterCount: opts.clusterCount ?? countClusterTrades({
      ticker: trade.ticker,
      type: trade.type,
      disclosureDate: trade.disclosure_date,
    }),
    repeatBuyCount: opts.repeatBuyCount ?? countRepeatBuys({
      tradeKey: trade.trade_key,
      politician: trade.politician,
      ticker: trade.ticker,
      transactionDate: trade.transaction_date,
    }),
    relevanceScore: relevance?.score,
    relevanceSignals: relevance?.signals ?? [],
    relevanceContext: {
      tickerSector: relevance?.tickerSector ?? null,
      committeeSectors: relevance?.committeeSectors ?? [],
    },
  };
}

export async function scoreTrade(tradeKey, opts = {}) {
  const trade = opts.trade ?? getCongressTradeByKey(tradeKey);
  if (!trade) throw new Error(`unknown trade key "${tradeKey}"`);

  const ctx = await buildScoreContext(trade, opts);
  const inputsHash = hashInputs(scorePayload(trade, ctx));
  const existing = getTradeScore(trade.trade_key);
  if (!opts.force && existing?.inputs_hash === inputsHash) return { ...existing, skipped: true };

  const result = computeCopyScore(trade, ctx);
  return {
    ...upsertTradeScore({
      tradeKey: trade.trade_key,
      ...result,
      inputsHash,
    }),
    skipped: false,
  };
}

export async function rescoreRecentTrades({ days = 60, limit, force = false } = {}) {
  const keys = listRecentTradeKeys(days).slice(0, limit || undefined);
  let scored = 0;
  let skipped = 0;
  let failed = 0;
  for (const key of keys) {
    try {
      const row = await scoreTrade(key, { force });
      if (row.skipped) skipped++;
      else scored++;
    } catch (err) {
      failed++;
      log.warn('copy-score', `Failed to score ${key}: ${err.message}`);
    }
  }
  log.info('copy-score', `Recent rescore complete: ${scored} scored, ${skipped} skipped, ${failed} failed`);
  return { considered: keys.length, scored, skipped, failed };
}
