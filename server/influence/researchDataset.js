import crypto from 'node:crypto';
import {
  createYoutubeResearchDataset,
  finishYoutubeResearchDataset,
  getYoutubeResearchDataset,
  insertYoutubeResearchDatasetRows,
  listAllAssetMentions,
  listYoutubeResearchSourceRows,
} from '../db.js';
import { CONSOLIDATION_VERSION, consolidateYoutubeMentions } from '../backtest/youtubeBacktest.js';

export const RESEARCH_SCHEMA_VERSION = 'youtube-research-v1';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function json(value, fallback = null) {
  if (value == null || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function outcomeStatuses(row) {
  return json(row.result_metadata, {})?.outcomeStatus || {};
}

export function researchRowFromSource(row, { cutoffTime, minimumQuality = 0 } = {}) {
  const statuses = outcomeStatuses(row);
  const exclusionReasons = [];
  if (!['bullish', 'bearish'].includes(row.direction)) exclusionReasons.push(row.conflict_status || 'not_directional');
  if (!row.representative_mention_id) exclusionReasons.push('missing_representative_mention');
  if (!row.classified_direction) exclusionReasons.push('missing_classification');
  if (Number(row.mention_quality_score || 0) < minimumQuality) exclusionReasons.push('below_quality_threshold');
  if (!row.backtest_result_id) exclusionReasons.push('not_backtested');
  if (statuses['30d'] === 'immature') exclusionReasons.push('outcome_30d_immature');
  if (statuses['30d']?.startsWith('missing_')) exclusionReasons.push(statuses['30d']);
  if (row.backtest_result_id && row.return_30d == null && !statuses['30d']) exclusionReasons.push('outcome_30d_unavailable');

  const frozen = {
    canonicalSignalId: row.id,
    included: exclusionReasons.length === 0,
    exclusionReasons: [...new Set(exclusionReasons)],
    signal: {
      eventTime: row.event_time,
      direction: row.direction,
      conflictStatus: row.conflict_status,
      occurrenceCount: row.occurrence_count,
      collapsedClusterCount: row.collapsed_cluster_count,
      mentionIds: json(row.mention_ids, []),
      consolidationVersion: row.consolidation_version,
      asset: {
        id: row.asset_id, symbol: row.symbol, name: row.canonical_name,
        type: row.asset_type, exchange: row.exchange, market: row.market,
      },
    },
    classification: {
      direction: row.classified_direction,
      mentionType: row.mention_type,
      timeHorizon: row.time_horizon,
      qualityScore: row.mention_quality_score,
      convictionScore: row.conviction_score,
      relevanceScore: row.relevance_score,
      directnessScore: row.directness_score,
      sponsorshipRiskScore: row.sponsorship_risk_score,
      pumpRiskScore: row.pump_risk_score,
      shouldCreateSignal: !!row.should_create_signal,
      summary: row.summary,
      modelName: row.model_name,
      modelVersion: row.model_version,
      promptVersion: row.prompt_version,
      manualOverride: !!row.is_manual_override,
      rawModelOutput: json(row.raw_model_output, row.raw_model_output),
    },
    creator: {
      id: row.channel_id,
      title: row.channel_title,
      category: row.category,
      influenceTier: row.influence_tier,
      currentSubscribers: row.subscriber_count,
      snapshot: row.channel_snapshot_at ? {
        capturedAt: row.channel_snapshot_at,
        subscriberCount: row.snapshot_subscribers,
        videoCount: row.snapshot_video_count,
        viewCount: row.snapshot_channel_views,
        timing: row.channel_snapshot_at <= row.event_time ? 'at_or_before' : 'after_event',
      } : null,
    },
    video: {
      id: row.video_id,
      youtubeVideoId: row.youtube_video_id,
      title: row.video_title,
      publishedAt: row.published_at,
      durationSeconds: row.duration_seconds,
      paidProductPlacement: row.has_paid_product_placement == null ? null : !!row.has_paid_product_placement,
      snapshot: row.video_snapshot_at ? {
        capturedAt: row.video_snapshot_at,
        viewCount: row.view_count,
        likeCount: row.like_count,
        commentCount: row.comment_count,
        timing: row.video_snapshot_at <= row.event_time ? 'at_or_before' : 'after_event',
      } : null,
    },
    evidence: {
      representativeMentionId: row.representative_mention_id,
      mentionText: row.mention_text,
      surroundingText: row.surrounding_text,
      mentionStartSeconds: row.mention_start_seconds,
      entityConfidence: row.entity_confidence,
      detectionMethod: row.detection_method,
      classifierEvidence: json(row.evidence, row.evidence),
      themes: row.themes ? row.themes.split(',').sort() : [],
      transcript: {
        segmentId: row.segment_id,
        provider: row.transcript_provider,
        authorizationStatus: row.transcript_authorization,
        fetchedAt: row.transcript_fetched_at,
      },
    },
    outcomes: {
      backtestRunId: row.backtest_run_id,
      backtestResultId: row.backtest_result_id,
      backtestedAt: row.backtested_at,
      entryPrice: row.entry_price,
      directionalReturns: {
        '1h': row.return_1h, '6h': row.return_6h, '24h': row.return_24h,
        '7d': row.return_7d, '30d': row.return_30d, '90d': row.return_90d,
      },
      returnComponents: json(row.return_components, {}),
      benchmarkReturn30d: row.benchmark_return_30d,
      maxDrawdown30d: row.max_drawdown_30d,
      maxRunup30d: row.max_runup_30d,
      availability: statuses,
      priceProvider: json(row.result_metadata, {})?.priceProvider || null,
      priceSource: json(row.result_metadata, {})?.priceSource || null,
    },
    provenance: {
      frozenAtCutoff: cutoffTime,
      researchSchemaVersion: RESEARCH_SCHEMA_VERSION,
      sourceTables: [
        'youtube_canonical_signals', 'asset_mentions', 'mention_classifications',
        'youtube_channels', 'youtube_videos', 'youtube_channel_snapshots',
        'youtube_video_snapshots', 'youtube_backtest_signal_results',
      ],
    },
  };
  return { ...frozen, rowHash: hash(frozen) };
}

export function defaultDatasetVersion(cutoffTime = new Date().toISOString()) {
  return `youtube-${cutoffTime.replace(/[-:.TZ]/g, '').slice(0, 17)}`;
}

export function buildYoutubeResearchDataset({ datasetVersion, cutoffTime, minimumQuality = 0 } = {}) {
  const cutoff = cutoffTime || new Date().toISOString();
  const version = datasetVersion || defaultDatasetVersion(cutoff);
  // Idempotently materialise the canonical research unit before freezing it.
  consolidateYoutubeMentions(listAllAssetMentions({ endDate: cutoff.slice(0, 10) }));
  const datasetId = createYoutubeResearchDataset({
    dataset_version: version,
    schema_version: RESEARCH_SCHEMA_VERSION,
    consolidation_version: CONSOLIDATION_VERSION,
    cutoff_time: cutoff,
    parameters: { minimumQuality },
  });
  try {
    const rows = listYoutubeResearchSourceRows(cutoff)
      .map((row) => researchRowFromSource(row, { cutoffTime: cutoff, minimumQuality }));
    insertYoutubeResearchDatasetRows(datasetId, rows);
    const included = rows.filter((row) => row.included).length;
    const contentHash = hash(rows.map((row) => row.rowHash));
    finishYoutubeResearchDataset(datasetId, {
      status: 'complete', row_count: rows.length, included_count: included,
      excluded_count: rows.length - included, content_hash: contentHash,
      completed_at: new Date().toISOString(),
    });
    return getYoutubeResearchDataset(datasetId);
  } catch (err) {
    finishYoutubeResearchDataset(datasetId, {
      status: 'failed', row_count: 0, included_count: 0, excluded_count: 0,
      content_hash: null, completed_at: new Date().toISOString(),
    });
    throw err;
  }
}

export function datasetAsJsonl(dataset) {
  return dataset.rows.map((row) => JSON.stringify(row)).join('\n') + (dataset.rows.length ? '\n' : '');
}
