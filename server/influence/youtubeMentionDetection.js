import {
  createAssetMention,
  listAssetAliases,
  listContentSegmentsForVideo,
} from '../db.js';
import { resolveAssetMentionsInText } from './entityResolution.js';

function addSeconds(iso, seconds) {
  const base = new Date(iso).getTime();
  if (!Number.isFinite(base)) return new Date().toISOString();
  return new Date(base + Number(seconds || 0) * 1000).toISOString();
}

export function detectMentionsInSegments(video, segments, aliases = listAssetAliases()) {
  const mentions = [];
  for (const segment of segments) {
    const detected = resolveAssetMentionsInText(segment.text, aliases);
    for (const item of detected) {
      mentions.push({
        asset_id: item.asset.id,
        source_type: 'transcript_segment',
        source_id: segment.id,
        video_id: video.id,
        channel_id: video.channel_id,
        segment_id: segment.id,
        mention_text: item.mentionText,
        surrounding_text: item.surroundingText,
        mention_start_seconds: segment.start_seconds ?? null,
        mention_end_seconds: segment.end_seconds ?? null,
        event_time: addSeconds(video.published_at, segment.start_seconds ?? 0),
        detection_method: item.detectionMethod,
        entity_confidence: item.entityConfidence,
      });
    }
  }
  return mentions;
}

export function detectAndStoreYoutubeMentions(video) {
  const segments = listContentSegmentsForVideo(video.id);
  const detected = detectMentionsInSegments(video, segments);
  const ids = [];
  for (const mention of detected) {
    const id = createAssetMention(mention);
    if (id) ids.push(id);
  }
  return { detected: detected.length, stored: ids.length, ids };
}
