// Assemble the context a thesis card needs, build it, optionally polish it with
// Claude, and cache it in thesis_cards keyed by the trade's score computed_at.
// The card is rebuilt whenever the underlying score is newer than the cached card,
// so cards never drift out of sync with the scoring engine.

import {
  countClusterTrades,
  countRepeatBuys,
  getCongressTradeByKey,
  getThesisCard,
  getPoliticianStats,
  getTradeScore,
  upsertThesisCard,
} from '../db.js';
import { driftSincePct } from '../marketData.js';
import { scoreTrade } from './scoreRunner.js';
import { buildThesisCard, polishCard } from './thesisCard.js';
import { computeRelevance } from './relevance.js';

async function buildCardContext(trade) {
  const [driftPct, sinceDisclosurePct, relevance] = await Promise.all([
    driftSincePct(trade.ticker, trade.transaction_date),
    driftSincePct(trade.ticker, trade.disclosure_date),
    computeRelevance(trade),
  ]);
  return {
    driftPct,
    sinceDisclosurePct,
    politicianStats: getPoliticianStats(trade.politician),
    clusterCount: countClusterTrades({
      ticker: trade.ticker,
      type: trade.type,
      disclosureDate: trade.disclosure_date,
    }),
    repeatBuyCount: countRepeatBuys({
      tradeKey: trade.trade_key,
      politician: trade.politician,
      ticker: trade.ticker,
      transactionDate: trade.transaction_date,
    }),
    relevanceSignals: relevance.signals || [],
  };
}

/**
 * Return the thesis card for a trade, building (and scoring, if needed) on demand.
 * Cached in thesis_cards; the cache is reused only while it is at least as fresh as
 * the trade's persisted score. Pass { force: true } to always rebuild.
 */
export async function getOrBuildThesisCard(tradeKey, { force = false } = {}) {
  const trade = getCongressTradeByKey(tradeKey);
  if (!trade) throw new Error(`unknown trade key "${tradeKey}"`);

  let score = getTradeScore(tradeKey);
  if (!score) {
    await scoreTrade(tradeKey);
    score = getTradeScore(tradeKey);
  }

  const cached = getThesisCard(tradeKey);
  if (!force && cached && cached.score_computed_at === score.computed_at) {
    return { ...cached, cached: true };
  }

  const ctx = await buildCardContext(trade);
  const card = buildThesisCard(trade, score, ctx);
  const polished = await polishCard(card); // null unless THESIS_LLM=true and it succeeds
  const saved = upsertThesisCard({
    tradeKey,
    card,
    polished,
    scoreComputedAt: score.computed_at,
  });
  return { ...saved, cached: false };
}
