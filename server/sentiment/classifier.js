import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { log } from '../logger.js';

const anthropic = config.anthropicApiKey
  ? new Anthropic({ apiKey: config.anthropicApiKey })
  : null;

const SYSTEM_PROMPT = `You are a financial market analyst. You will be given a social media post by a prominent political figure. Assess whether the post is likely to move the price of specific publicly-traded US stocks or sector ETFs in the near term.

Respond with ONLY a JSON object, no other text:
{
  "tickers": [
    { "ticker": "<US-listed symbol>", "direction": "buy" | "sell", "confidence": <0.0-1.0> }
  ],
  "rationale": "<one or two sentences>"
}

Rules:
- "buy" means the post is likely to push the price UP; "sell" means DOWN.
- Only include tickers where there is a plausible, direct causal link from the post's content. Vague political statements, personal attacks, or posts with no market relevance get an empty tickers array.
- Prefer specific companies named or clearly implied; sector ETFs (e.g. XLE, ITA, TAN) are acceptable when a whole sector is targeted.
- confidence reflects how likely a near-term price move in that direction is. Be conservative: most posts should score low or have no tickers.
- Never include more than 3 tickers.`;

/**
 * Classify a post's market impact.
 * Returns { tickers: [{ticker, direction, confidence}], rationale } or null on failure.
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
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.tickers)) return null;
    parsed.tickers = parsed.tickers
      .filter(
        (t) =>
          t &&
          typeof t.ticker === 'string' &&
          ['buy', 'sell'].includes(t.direction) &&
          typeof t.confidence === 'number' &&
          t.confidence >= 0 &&
          t.confidence <= 1
      )
      .slice(0, 3);
    return parsed;
  } catch (err) {
    log.error('sentiment', `Classification failed: ${err.message}`);
    return null;
  }
}
