// Normalized trade signal shared by every signal source and the backtester.

const SOURCES = ['congress', 'sentiment', 'auto-exit'];
const DIRECTIONS = ['buy', 'sell'];

/**
 * @param {object} raw
 * @param {'congress'|'sentiment'} raw.source
 * @param {string} raw.ticker           e.g. "NVDA"
 * @param {'buy'|'sell'} raw.direction
 * @param {number} [raw.confidence]     0..1, required for sentiment
 * @param {string} raw.rationale        human-readable "why"
 * @param {object} [raw.rawReference]   original source payload for the audit log
 * @param {string} [raw.eventTimestamp] ISO time of the underlying event (disclosure/post)
 */
export function makeTradeSignal(raw) {
  if (!SOURCES.includes(raw.source)) {
    throw new Error(`Invalid signal source: ${raw.source}`);
  }
  if (!DIRECTIONS.includes(raw.direction)) {
    throw new Error(`Invalid signal direction: ${raw.direction}`);
  }
  const ticker = String(raw.ticker || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z.]{0,9}$/.test(ticker)) {
    throw new Error(`Invalid ticker: "${raw.ticker}"`);
  }
  if (raw.confidence != null && (raw.confidence < 0 || raw.confidence > 1)) {
    throw new Error(`Confidence must be 0..1, got ${raw.confidence}`);
  }
  return {
    source: raw.source,
    ticker,
    direction: raw.direction,
    confidence: raw.confidence ?? null,
    rationale: raw.rationale || '',
    rawReference: raw.rawReference ?? null,
    eventTimestamp: raw.eventTimestamp ?? null,
    createdAt: new Date().toISOString(),
  };
}
