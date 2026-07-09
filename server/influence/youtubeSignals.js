import { config } from '../config.js';
import {
  listAssetMentions,
  upsertInfluenceSignalEvent,
} from '../db.js';

function suggestedAction(mention) {
  const quality = Number(mention.mention_quality_score || 0);
  const pump = Number(mention.pump_risk_score || 0);
  if (pump >= 70) return 'avoid';
  if (quality >= 85) return 'copy_candidate';
  if (quality >= 70) return 'watch';
  return 'manual_review';
}

export function generateYoutubeSignals({ videoId, limit = 500 } = {}) {
  const mentions = listAssetMentions({ videoId, limit }).filter((m) => {
    if (!['bullish', 'bearish'].includes(m.direction)) return false;
    if (Number(m.mention_quality_score || 0) < config.influence.signalQualityThreshold) return false;
    if (Number(m.entity_confidence || 0) < 0.75) return false;
    return true;
  });
  const signals = [];
  for (const mention of mentions) {
    const action = suggestedAction(mention);
    const signal = upsertInfluenceSignalEvent({
      source_type: 'youtube_transcript',
      source_id: mention.id,
      module_key: 'youtube',
      asset_id: mention.asset_id,
      event_time: mention.event_time,
      direction: mention.direction,
      confidence: Math.min(1, Number(mention.relevance_score || 0) / 100),
      strength_score: Number(mention.mention_quality_score || 0),
      actionability_score: action === 'avoid' ? 20 : Number(mention.mention_quality_score || 0),
      suggested_action: action,
      title: `${mention.symbol} ${mention.direction} mention from ${mention.channel_title || 'YouTube creator'}`,
      explanation: mention.summary || `${mention.symbol} was mentioned in a YouTube transcript.`,
      evidence: {
        mentionId: mention.id,
        videoId: mention.video_id,
        channelId: mention.channel_id,
        mentionText: mention.mention_text,
        surroundingText: mention.surrounding_text,
        qualityScore: mention.mention_quality_score,
        pumpRiskScore: mention.pump_risk_score,
      },
    });
    signals.push(signal);
  }
  return signals;
}
