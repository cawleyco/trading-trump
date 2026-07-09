import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { log } from '../logger.js';

const anthropic = config.anthropicApiKey
  ? new Anthropic({ apiKey: config.anthropicApiKey })
  : null;

const RELEVANCE_TYPES = ['company', 'sector', 'legislation', 'regulation', 'contracts', 'opinion', 'none'];

const SYSTEM_PROMPT = `You are a financial market analyst. You will be given a social media post by a prominent political figure. Assess whether the post is likely to move the price of specific publicly-traded US stocks or sector ETFs in the near term.

Respond with ONLY a JSON object, no other text:
{
  "relevanceType": "company" | "sector" | "legislation" | "regulation" | "contracts" | "opinion" | "none",
  "marketRelevance": <0.0-1.0>,
  "tickers": [
    { "ticker": "<US-listed symbol>", "direction": "buy" | "sell", "confidence": <0.0-1.0>, "rationale": "<why this ticker is directly affected>" }
  ],
  "sectors": ["<sector bucket when sector-level but no single ticker>"],
  "rationale": "<one or two sentences>"
}

Rules:
- "buy" means the post is likely to push the price UP; "sell" means DOWN.
- relevanceType is "opinion" for vague policy/personal views with weak market actionability, and "none" for no market relevance.
- marketRelevance measures the post-level connection to public markets, separate from per-ticker confidence.
- Only include tickers where there is a plausible, direct causal link from the post's content. Vague political statements, personal attacks, or posts with no market relevance get relevanceType "opinion" or "none" and an empty tickers array.
- Prefer specific companies named or clearly implied; sector ETFs (e.g. XLE, ITA, TAN) are acceptable when a whole sector is targeted.
- Use sectors for sector-level impact even when you include no ticker; sector-only calls are research metadata and should not invent a ticker.
- confidence reflects how likely a near-term price move in that direction is. Be conservative: most posts should score low or have no tickers.
- Never include more than 3 tickers.`;

function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function normalizeTickerCall(t) {
  if (
    !t ||
    typeof t.ticker !== 'string' ||
    !['buy', 'sell'].includes(t.direction) ||
    typeof t.confidence !== 'number' ||
    t.confidence < 0 ||
    t.confidence > 1
  ) {
    return null;
  }
  return {
    ticker: t.ticker.trim().toUpperCase(),
    direction: t.direction,
    confidence: t.confidence,
    rationale: typeof t.rationale === 'string' ? t.rationale.trim() : '',
  };
}

export function normalizeClassification(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const relevanceType = RELEVANCE_TYPES.includes(parsed.relevanceType)
    ? parsed.relevanceType
    : (Array.isArray(parsed.tickers) && parsed.tickers.length > 0 ? 'company' : 'none');
  const tickers = Array.isArray(parsed.tickers)
    ? parsed.tickers.map(normalizeTickerCall).filter(Boolean).slice(0, 3)
    : [];
  const sectors = Array.isArray(parsed.sectors)
    ? [...new Set(parsed.sectors.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean))]
    : [];
  const marketRelevance = clamp01(
    parsed.marketRelevance,
    tickers.length > 0 || sectors.length > 0 ? 0.5 : 0
  );
  const rationale =
    typeof parsed.rationale === 'string' && parsed.rationale.trim()
      ? parsed.rationale.trim()
      : tickers.map((t) => t.rationale).filter(Boolean).join(' ') || '';
  return { relevanceType, marketRelevance, tickers, sectors, rationale };
}

export function isMarketRelevant(classification, minRelevance = config.signals.sentimentMinRelevance) {
  return Boolean(
    classification &&
    classification.marketRelevance >= minRelevance &&
    !['opinion', 'none'].includes(classification.relevanceType)
  );
}

/**
 * Classify a post's market impact.
 * Returns the normalized extended classifier JSON or null on failure.
 */
export async function classifyPost(postText) {
  if (!anthropic) {
    log.warn('sentiment', 'ANTHROPIC_API_KEY not set — sentiment classification disabled');
    return null;
  }
  try {
    const resp = await anthropic.messages.create({
      model: config.sentimentModel,
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Post:\n"""\n${postText}\n"""` }],
    });
    const text = resp.content.find((b) => b.type === 'text')?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn('sentiment', 'Classifier returned no JSON', { raw: text.slice(0, 200) });
      return null;
    }
    return normalizeClassification(JSON.parse(jsonMatch[0]));
  } catch (err) {
    log.error('sentiment', `Classification failed: ${err.message}`);
    return null;
  }
}
