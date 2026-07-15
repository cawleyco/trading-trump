// Deterministic, template-based thesis-card generator for a scored congress trade.
//
// buildThesisCard(trade, score, ctx) assembles a plain-language card entirely from
// the trade row, its persisted copy-score (factors + warnings), and an injected ctx
// (drift, cluster/repeat counts, politician stats, and — once Phase 6 lands —
// relevance signals). No LLM call: every sentence is stitched from data we already
// hold, so cards are free, instant, deterministic, and unit-testable. Missing data
// omits a sentence rather than printing "undefined".
//
// polishCard(card) is the optional Claude rewrite (Task 5.2), gated by THESIS_LLM and
// fault-tolerant: any failure returns null so callers fall back to the card as-is.

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { log } from '../logger.js';
import { logLlmUsage } from '../lib/llmUsage.js';
import { disclosureLagDays } from './freshness.js';

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function compactUsd(n) {
  if (!Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${round(n / 1_000_000)}M`;
  if (abs >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

function formatAmount(trade) {
  const min = Number(trade.amount_min);
  const max = Number(trade.amount_max);
  if (Number.isFinite(min) && Number.isFinite(max)) {
    return `${compactUsd(min)}–${compactUsd(max)}`;
  }
  if (trade.amount_range) return trade.amount_range;
  const mid = Number(trade.amount_mid);
  return Number.isFinite(mid) ? compactUsd(mid) : null;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

function verbPast(type) {
  return type === 'sell' ? 'sold' : 'purchased';
}

function verbNoun(type) {
  return type === 'sell' ? 'sale' : 'buy';
}

function movePhrase(pct) {
  const dir = pct >= 0 ? 'up' : 'down';
  return `${dir} ${Math.abs(round(pct, 1))}%`;
}

function edgeQuartile(edge) {
  if (edge >= 75) return 'Top-quartile';
  if (edge >= 50) return 'Above-median';
  if (edge >= 25) return 'Below-median';
  return 'Bottom-quartile';
}

function parseOptionExpiry(optionDetail) {
  if (!optionDetail) return null;
  try {
    const d = typeof optionDetail === 'string' ? JSON.parse(optionDetail) : optionDetail;
    return d?.expiry || null;
  } catch {
    return null;
  }
}

/**
 * Build the deterministic thesis card. Pure — no I/O.
 * @param {object} trade  congress_trades row
 * @param {object} score  { score, confidence, recommendation, factors, warnings }
 * @param {object} ctx    { driftPct, sinceDisclosurePct, repeatBuyCount, clusterCount,
 *                          politicianStats, relevanceSignals? }
 */
export function buildThesisCard(trade, score = {}, ctx = {}) {
  const factors = score.factors || {};
  const warnings = Array.isArray(score.warnings) ? score.warnings : [];

  // --- What happened -------------------------------------------------------
  const amount = formatAmount(trade);
  let what = `${trade.politician} ${verbPast(trade.type)} ${trade.ticker}`;
  if (amount) what += ` (${amount})`;
  if (trade.transaction_date) what += ` on ${trade.transaction_date}`;
  if (trade.disclosure_date) what += `, disclosed ${trade.disclosure_date}`;
  what += '.';

  // --- Why it might matter -------------------------------------------------
  const whyItMatters = [];
  const repeatBuys = Number(ctx.repeatBuyCount ?? 0);
  if (trade.type === 'buy' && repeatBuys > 0) {
    whyItMatters.push(`Repeat purchase — ${ordinal(repeatBuys + 1)} ${trade.ticker} buy in 90 days.`);
  }
  const clusterCount = Number(ctx.clusterCount ?? 0);
  if (clusterCount > 1) {
    whyItMatters.push(
      `${clusterCount} members traded ${trade.ticker} the same direction within 30 days.`
    );
  }
  const amountMid = Number(trade.amount_mid);
  if (Number.isFinite(amountMid) && amountMid >= 100_000) {
    whyItMatters.push(`Sizeable ${verbNoun(trade.type)} — about ${compactUsd(amountMid)} at the band midpoint.`);
  }
  // Phase 6 populates ctx.relevanceSignals with committee/bill/lobby overlap texts.
  if (Array.isArray(ctx.relevanceSignals)) {
    for (const s of ctx.relevanceSignals) {
      if (s?.text) whyItMatters.push(s.text);
    }
  } else if (factors.committeeRelevance?.hasData && Number(factors.committeeRelevance.score) >= 50) {
    whyItMatters.push(factors.committeeRelevance.detail);
  }

  // --- Since then ----------------------------------------------------------
  const moves = [];
  if (Number.isFinite(ctx.driftPct)) moves.push(`${movePhrase(ctx.driftPct)} since the trade date`);
  if (Number.isFinite(ctx.sinceDisclosurePct)) moves.push(`${movePhrase(ctx.sinceDisclosurePct)} since disclosure`);
  const sinceThen = moves.length ? `${trade.ticker} is ${moves.join(' and ')}.` : null;

  // --- Signal strength -----------------------------------------------------
  const signal = {
    copyScore: score.score ?? null,
    confidence: score.confidence ?? null,
    recommendation: score.recommendation ?? null,
  };
  const edge = ctx.politicianStats?.edge_score;
  if (Number.isFinite(edge)) {
    signal.politicianEdge = `${edgeQuartile(edge)} 90-day returns (edge ${round(edge)}/100).`;
  }

  // --- Risks ---------------------------------------------------------------
  const risks = [];
  const lag = disclosureLagDays(trade);
  if (Number.isFinite(lag) && lag > 0) {
    risks.push(`Disclosure lag of ${lag} day${lag === 1 ? '' : 's'}.`);
  }
  if (trade.is_option) {
    const expiry = parseOptionExpiry(trade.option_detail);
    risks.push(expiry ? `Options position expiring ${expiry}.` : 'Options position — expiry unknown.');
  }
  for (const w of warnings) {
    if (w.code === 'options-trade') continue; // already covered by the option sentence
    if (w?.message && !risks.includes(w.message)) risks.push(w.message);
  }

  return {
    what,
    whyItMatters,
    sinceThen,
    signal,
    risks,
    suggestedAction: score.recommendation ?? 'manual-review',
  };
}

// --- Optional Claude polish (Task 5.2) -------------------------------------

let anthropic = null;
function getClient() {
  if (anthropic) return anthropic;
  if (!config.anthropicApiKey) return null;
  anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  return anthropic;
}

// Bump when POLISH_SYSTEM changes so cardRunner re-polishes existing cards.
export const POLISH_PROMPT_VERSION = 'polish-v1';

const POLISH_SYSTEM = `You are a markets analyst. Rewrite the given thesis-card bullet points as a concise 4-sentence analyst note in plain English. Do not add any facts, numbers, tickers, or recommendations that are not present in the input. Do not speculate. Return only the note text, no preamble.`;

/**
 * Rewrite a deterministic card into a short analyst note via Claude. Returns the
 * prose string, or null on any failure / when disabled — callers must fall back
 * to the deterministic card silently.
 */
export async function polishCard(card, subject = {}) {
  if (!config.thesis.llmEnabled) return null;
  const client = getClient();
  if (!client) {
    log.warn('thesis-card', 'THESIS_LLM=true but ANTHROPIC_API_KEY not set — skipping polish');
    return null;
  }
  try {
    const resp = await client.messages.create({
      model: config.thesis.model,
      max_tokens: 400,
      // cache_control is inert below the model's minimum cacheable prefix
      // (4096 tokens on Haiku 4.5) but activates automatically if the prompt grows.
      system: [{ type: 'text', text: POLISH_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: JSON.stringify(card, null, 2) }],
    });
    logLlmUsage('thesis-polish', resp.usage, {
      tradeKey: subject.tradeKey,
      politician: subject.politician,
      ticker: subject.ticker,
    });
    const text = resp.content.find((b) => b.type === 'text')?.text?.trim();
    return text || null;
  } catch (err) {
    log.warn('thesis-card', `Polish failed, using deterministic card: ${err.message}`);
    return null;
  }
}
