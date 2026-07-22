// Semantic theme tagging (Phase 2 narrative layer). Where mention_type captures
// the STRUCTURE of a mention (recommendation, warning, news reaction...), a
// theme captures its SUBSTANCE — the macro/thematic story the creator is
// telling (AI buildout, rate cuts, a crypto ETF, a bubble warning...).
//
// Design mirrors the mention classifier (server/influence/youtubeMentionClassifier.js):
//   - controlled multi-label vocabulary so groups stay comparable and don't
//     fragment into synonyms;
//   - batched LLM calls (many short summaries per request) to keep token cost
//     down;
//   - content-addressed compute-cache memoization so identical inputs never
//     re-spend, on top of DB-level idempotency (already-tagged mentions skip).
//
// Opt-in only: nothing here runs unless config.influence.themeTaggingEnabled.

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { log } from '../logger.js';
import { defaultCache } from '../cache/computeCache.js';
import { logLlmUsage } from '../lib/llmUsage.js';
import { listMentionsWithoutThemes, insertMentionThemes, countMentionThemes } from '../db.js';

export const TAXONOMY_VERSION = 'themes-v1';

// Curated, finance/crypto-oriented theme vocabulary. Keep keys stable — they
// are persisted; bump TAXONOMY_VERSION when the set changes materially.
export const THEME_TAXONOMY = [
  { key: 'ai_compute', label: 'AI & compute buildout', desc: 'AI models, GPUs/chips, data centers, compute demand' },
  { key: 'macro_rates', label: 'Macro & rates', desc: 'Fed, interest rates, inflation, recession, macro backdrop' },
  { key: 'earnings_fundamentals', label: 'Earnings & fundamentals', desc: 'earnings, revenue, margins, guidance, valuation on fundamentals' },
  { key: 'product_catalyst', label: 'Product / catalyst', desc: 'new product, launch, approval, contract, or specific upcoming catalyst' },
  { key: 'regulation_legal', label: 'Regulation & legal', desc: 'regulation, lawsuits, SEC/DOJ, policy, government action' },
  { key: 'ma_dealmaking', label: 'M&A & dealmaking', desc: 'mergers, acquisitions, buyouts, spinoffs, activist stakes' },
  { key: 'crypto_adoption', label: 'Crypto adoption & flows', desc: 'ETF, institutional adoption, halving, on-chain flows, listings' },
  { key: 'momentum_squeeze', label: 'Momentum & squeeze', desc: 'meme/momentum, short squeeze, hype, retail crowding' },
  { key: 'bubble_crash_warning', label: 'Bubble / crash warning', desc: 'overvaluation, bubble, imminent crash or correction warning' },
  { key: 'insider_institutional', label: 'Insider & institutional', desc: 'insider buys/sells, institutional or politician positioning, whales' },
  { key: 'value_dividend', label: 'Value & income', desc: 'undervalued/value play, dividends, cash flow, long-term hold' },
  { key: 'geopolitics_supply', label: 'Geopolitics & supply chain', desc: 'China, tariffs, war, sanctions, supply-chain or commodity shocks' },
  { key: 'distress_dilution', label: 'Distress & dilution', desc: 'debt, dilution, bankruptcy, going-concern or liquidity risk' },
];

const THEME_KEYS = new Set(THEME_TAXONOMY.map((t) => t.key));

const anthropic = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;

const SYSTEM_PROMPT = `You tag finance/crypto YouTube asset mentions with SEMANTIC THEMES — the macro/thematic story behind the mention, not its tone.

Choose only from this fixed vocabulary (use the key):
${THEME_TAXONOMY.map((t) => `- ${t.key}: ${t.desc}`).join('\n')}

Rules:
- Assign 1-3 themes per mention (most specific first). Use "other" only if none fit.
- Judge substance, not sentiment. A bearish AI-chip take is still ai_compute.
- Return ONLY valid JSON: {"tags":[{"id":<mentionId>,"themes":["key1","key2"]}, ...]} covering every input id.`;

function normalizeThemes(list) {
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    const key = String(t).trim();
    if (THEME_KEYS.has(key) && !out.includes(key)) out.push(key);
    if (out.length >= 3) break;
  }
  return out.length ? out : ['other'];
}

// One LLM call for a batch of mentions. Returns Map<id, themes[]> or null on
// failure. Memoized on the batch's content so re-runs never re-spend.
async function tagBatch(batch) {
  if (!anthropic) {
    log.warn('narrative-themes', 'ANTHROPIC_API_KEY not set — theme tagging disabled');
    return null;
  }
  const cache = await defaultCache();
  const raw = await cache.memoize(
    'narrative-theme-tag',
    {
      model: config.sentimentModel,
      items: batch.map((m) => ({ id: m.id, symbol: m.symbol, summary: m.summary })),
    },
    async () => {
      try {
        const input = batch
          .map((m) => `#${m.id} [${m.symbol}] ${m.summary || m.surrounding_text || ''}`.slice(0, 400))
          .join('\n');
        const resp = await anthropic.messages.create({
          model: config.sentimentModel,
          max_tokens: 1500,
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: `Tag these ${batch.length} mentions:\n${input}` }],
        });
        logLlmUsage('narrative-themes', resp.usage, { batch: batch.length });
        const text = resp.content.find((b) => b.type === 'text')?.text || '';
        const match = text.match(/\{[\s\S]*\}/);
        return match ? JSON.parse(match[0]) : null;
      } catch (err) {
        log.error('narrative-themes', `Batch tag failed: ${err.message}`);
        return null;
      }
    },
    { version: TAXONOMY_VERSION }
  );
  if (!raw?.tags) return null;
  const map = new Map();
  for (const t of raw.tags) map.set(Number(t.id), normalizeThemes(t.themes));
  return map;
}

/**
 * Tag classified mentions that have no theme row for the current taxonomy.
 * Returns { tagged, batches, skipped } counts.
 */
export async function tagMentionThemes({ limit = 2000, batchSize = 25, force = false } = {}) {
  if (!config.influence.themeTaggingEnabled && !force) {
    return { enabled: false, tagged: 0, batches: 0, message: 'Theme tagging is opt-in — set YOUTUBE_THEME_TAGGING_ENABLED=true.' };
  }
  const pending = listMentionsWithoutThemes(TAXONOMY_VERSION, limit);
  let tagged = 0;
  let batches = 0;
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const result = await tagBatch(batch);
    batches += 1;
    if (!result) continue;
    for (const m of batch) {
      const themes = result.get(m.id);
      if (themes?.length) {
        insertMentionThemes(m.id, themes, TAXONOMY_VERSION, config.sentimentModel);
        tagged += 1;
      }
    }
  }
  const totals = countMentionThemes(TAXONOMY_VERSION);
  log.info('narrative-themes', `Theme tagging: ${tagged} newly tagged across ${batches} batches (total ${totals.mentions} mentions, ${totals.tags} tags)`);
  return { enabled: true, tagged, batches, totals, pending: pending.length };
}
