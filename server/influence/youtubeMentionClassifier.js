import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { log } from '../logger.js';
import { createMentionClassification, getLatestAutoMentionClassification } from '../db.js';
import { defaultCache } from '../cache/computeCache.js';
import { mentionQualityScore } from './mentionQuality.js';
import { logLlmUsage } from '../lib/llmUsage.js';

const PROMPT_VERSION = 'youtube-mention-v1';
const anthropic = config.anthropicApiKey
  ? new Anthropic({ apiKey: config.anthropicApiKey })
  : null;

const SYSTEM_PROMPT = `You are classifying a finance/crypto YouTube transcript segment.

Return only valid JSON.

Classify the asset mention based on the creator's intent.

Required JSON:
{
  "direction": "bullish | bearish | neutral | mixed | unknown",
  "mentionType": "direct_recommendation | portfolio_update | watchlist | warning | educational_discussion | news_reaction | comparison | sponsored_promotion | joke_or_irrelevant | historical_reference",
  "timeHorizon": "intraday | days | weeks | months | years | unknown",
  "convictionScore": 0-100,
  "relevanceScore": 0-100,
  "directnessScore": 0-100,
  "sponsorshipRiskScore": 0-100,
  "pumpRiskScore": 0-100,
  "summary": "One sentence explaining the classification.",
  "evidence": ["short quote 1", "short quote 2"],
  "shouldCreateSignal": true
}`;

const DIRECTIONS = ['bullish', 'bearish', 'neutral', 'mixed', 'unknown'];
const TYPES = [
  'direct_recommendation', 'portfolio_update', 'watchlist', 'warning',
  'educational_discussion', 'news_reaction', 'comparison',
  'sponsored_promotion', 'joke_or_irrelevant', 'historical_reference',
];
const HORIZONS = ['intraday', 'days', 'weeks', 'months', 'years', 'unknown'];

function clamp(n) {
  return Math.max(0, Math.min(100, Number(n) || 0));
}

export function normalizeClassification(raw, mention = {}) {
  const direction = DIRECTIONS.includes(raw?.direction) ? raw.direction : 'unknown';
  const mentionType = TYPES.includes(raw?.mentionType) ? raw.mentionType : 'educational_discussion';
  const timeHorizon = HORIZONS.includes(raw?.timeHorizon) ? raw.timeHorizon : 'unknown';
  const convictionScore = clamp(raw?.convictionScore);
  const relevanceScore = clamp(raw?.relevanceScore);
  const directnessScore = clamp(raw?.directnessScore);
  const sponsorshipRiskScore = clamp(raw?.sponsorshipRiskScore);
  const pumpRiskScore = clamp(raw?.pumpRiskScore);
  const quality = mentionQualityScore({
    directnessScore,
    convictionScore,
    relevanceScore,
    sponsorshipRiskScore,
    pumpRiskScore,
  });
  const shouldCreateSignal = !!raw?.shouldCreateSignal &&
    relevanceScore >= 50 &&
    Number(mention.entity_confidence ?? 0) >= 0.75 &&
    mentionType !== 'joke_or_irrelevant' &&
    direction !== 'unknown';
  return {
    direction,
    mention_type: mentionType,
    time_horizon: timeHorizon,
    conviction_score: convictionScore,
    relevance_score: relevanceScore,
    directness_score: directnessScore,
    sponsorship_risk_score: sponsorshipRiskScore,
    pump_risk_score: pumpRiskScore,
    summary: String(raw?.summary || 'No summary provided.'),
    evidence: Array.isArray(raw?.evidence) ? raw.evidence.slice(0, 4).map(String) : [],
    should_create_signal: shouldCreateSignal,
    mention_quality_score: quality,
  };
}

export async function classifyYoutubeMention(context) {
  if (!config.influence.llmClassificationEnabled) {
    return null;
  }
  if (!anthropic) {
    log.warn('youtube-classifier', 'ANTHROPIC_API_KEY not set — YouTube mention classification disabled');
    return null;
  }
  try {
    const resp = await anthropic.messages.create({
      model: config.sentimentModel,
      max_tokens: 700,
      // cache_control is inert below the model's minimum cacheable prefix
      // (4096 tokens on Haiku 4.5) but activates automatically if the prompt grows.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: `Input:
- Channel name: ${context.channelTitle || ''}
- Video title: ${context.videoTitle || ''}
- Video description excerpt: ${(context.videoDescription || '').slice(0, 800)}
- Asset: ${context.assetSymbol} / ${context.assetName}
- Transcript segment: ${context.segmentText || context.surroundingText || ''}
- Surrounding context before: ${context.previousSegmentText || ''}
- Surrounding context after: ${context.nextSegmentText || ''}
- Paid product placement flag: ${!!context.hasPaidProductPlacement}
- Mention location seconds: ${context.mentionStartSeconds ?? ''}`,
      }],
    });
    logLlmUsage('youtube-classifier', resp.usage, {
      channel: context.channelTitle,
      video: context.videoTitle,
      asset: context.assetSymbol,
    });
    const text = resp.content.find((b) => b.type === 'text')?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    log.error('youtube-classifier', `Classification failed: ${err.message}`);
    return null;
  }
}

export async function classifyAndStoreYoutubeMention(mention, context = {}) {
  // Never pay for the same classification twice: reuse the stored result for
  // this mention + model + prompt version unless the caller forces a re-run.
  if (!context.manualClassification && !context.force) {
    const existing = getLatestAutoMentionClassification(
      mention.id, config.sentimentModel, PROMPT_VERSION
    );
    if (existing) return { ...existing, reused: true };
  }
  const fullContext = {
    ...context,
    assetSymbol: mention.symbol,
    assetName: mention.canonical_name,
    surroundingText: mention.surrounding_text,
    mentionStartSeconds: mention.mention_start_seconds,
  };
  // Content-addressed second layer: re-detection creates fresh mention ids
  // (defeating the per-mention reuse above), but identical prompt inputs
  // still hit the compute cache instead of re-spending tokens.
  const raw = context.manualClassification || await (await defaultCache()).memoize(
    'youtube-mention-classify',
    {
      model: config.sentimentModel,
      symbol: fullContext.assetSymbol,
      name: fullContext.assetName,
      segment: fullContext.segmentText || fullContext.surroundingText || '',
      before: fullContext.previousSegmentText || '',
      after: fullContext.nextSegmentText || '',
      channel: fullContext.channelTitle || '',
      video: fullContext.videoTitle || '',
      description: (fullContext.videoDescription || '').slice(0, 800),
      paid: !!fullContext.hasPaidProductPlacement,
      startSeconds: fullContext.mentionStartSeconds ?? null,
    },
    () => classifyYoutubeMention(fullContext),
    { version: PROMPT_VERSION, force: context.force === true }
  );
  if (!raw) return null;
  const normalized = normalizeClassification(raw, mention);
  return createMentionClassification({
    mention_id: mention.id,
    ...normalized,
    model_name: context.manualClassification ? 'manual' : 'anthropic',
    model_version: context.manualClassification ? null : config.sentimentModel,
    prompt_version: PROMPT_VERSION,
    raw_model_output: raw,
    is_manual_override: !!context.manualClassification,
  });
}
