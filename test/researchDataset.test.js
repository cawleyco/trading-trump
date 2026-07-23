import test from 'node:test'
import assert from 'node:assert/strict'
import { db, createYoutubeResearchDataset } from '../server/db.js'
import {
  datasetAsJsonl,
  defaultDatasetVersion,
  researchRowFromSource,
} from '../server/influence/researchDataset.js'

function source(overrides = {}) {
  return {
    id: 10, channel_id: 20, video_id: 30, asset_id: 40,
    event_time: '2025-01-01T12:00:00Z', direction: 'bullish', conflict_status: 'none',
    representative_mention_id: 50, occurrence_count: 3, collapsed_cluster_count: 1,
    mention_ids: '[50,51,52]', consolidation_version: 'video-asset-v1',
    symbol: 'AAPL', canonical_name: 'Apple', asset_type: 'equity', exchange: 'NASDAQ', market: 'US',
    channel_title: 'Fixture Creator', category: 'stocks', influence_tier: 'large', subscriber_count: 1000,
    youtube_video_id: 'fixture-video', video_title: 'Apple thesis', published_at: '2025-01-01T11:00:00Z',
    duration_seconds: 600, has_paid_product_placement: 0,
    mention_text: 'I am buying Apple', surrounding_text: 'Long-term Apple thesis', mention_start_seconds: 60,
    entity_confidence: 0.98, detection_method: 'hybrid', classified_direction: 'bullish',
    conviction_score: 90, relevance_score: 95, directness_score: 90, sponsorship_risk_score: 0,
    pump_risk_score: 5, time_horizon: 'months', mention_type: 'direct_recommendation',
    summary: 'Bullish Apple recommendation', evidence: '["I am buying"]', should_create_signal: 1,
    mention_quality_score: 80, model_name: 'anthropic', model_version: 'model-v1', prompt_version: 'prompt-v1',
    raw_model_output: '{"direction":"bullish"}', is_manual_override: 0,
    themes: 'ai,quality', transcript_provider: 'manual', transcript_authorization: 'authorized',
    transcript_fetched_at: '2025-01-02T00:00:00Z', segment_id: 60,
    video_snapshot_at: '2025-01-02T00:00:00Z', view_count: 100, like_count: 10, comment_count: 2,
    channel_snapshot_at: '2024-12-31T00:00:00Z', snapshot_subscribers: 900,
    snapshot_video_count: 50, snapshot_channel_views: 10000,
    backtest_result_id: 70, backtest_run_id: 80, entry_price: 100,
    return_1h: 1, return_6h: 2, return_24h: 3, return_7d: 4, return_30d: 5, return_90d: 6,
    max_drawdown_30d: -3, max_runup_30d: 8, benchmark_return_30d: 2,
    result_metadata: '{"outcomeStatus":{"30d":"measured"},"priceProvider":"alpaca"}',
    backtested_at: '2025-05-01T00:00:00Z',
    ...overrides,
  }
}

test('research rows freeze signal, evidence, snapshots, model provenance and outcomes', () => {
  const row = researchRowFromSource(source(), { cutoffTime: '2026-01-01T00:00:00Z', minimumQuality: 20 })
  assert.equal(row.included, true)
  assert.deepEqual(row.signal.mentionIds, [50, 51, 52])
  assert.equal(row.classification.modelVersion, 'model-v1')
  assert.equal(row.creator.snapshot.timing, 'at_or_before')
  assert.equal(row.video.snapshot.timing, 'after_event')
  assert.deepEqual(row.evidence.themes, ['ai', 'quality'])
  assert.equal(row.outcomes.directionalReturns['30d'], 5)
  assert.equal(row.outcomes.priceProvider, 'alpaca')
  assert.match(row.rowHash, /^[a-f0-9]{64}$/)
})

test('unusable observations remain in the frozen dataset with explicit exclusions', () => {
  const row = researchRowFromSource(source({
    direction: 'mixed', conflict_status: 'direction_conflict', backtest_result_id: null,
    mention_quality_score: 10, result_metadata: null,
  }), { cutoffTime: '2026-01-01T00:00:00Z', minimumQuality: 20 })
  assert.equal(row.included, false)
  assert.deepEqual(row.exclusionReasons, ['direction_conflict', 'below_quality_threshold', 'not_backtested'])
})

test('dataset versions carry millisecond precision and JSONL emits one complete row per line', () => {
  assert.equal(defaultDatasetVersion('2026-07-22T12:34:56.789Z'), 'youtube-20260722123456789')
  const text = datasetAsJsonl({ rows: [{ a: 1 }, { b: 2 }] })
  assert.deepEqual(text.trim().split('\n').map(JSON.parse), [{ a: 1 }, { b: 2 }])
})

test('dataset version uniqueness makes frozen manifests immutable', () => {
  assert.throws(() => db.transaction(() => {
    const input = {
      dataset_version: 'immutability-fixture-v1', schema_version: 'v1',
      consolidation_version: 'v1', cutoff_time: '2026-01-01T00:00:00Z', parameters: {},
    }
    createYoutubeResearchDataset(input)
    createYoutubeResearchDataset(input)
  })(), /UNIQUE/)
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM youtube_research_datasets WHERE dataset_version='immutability-fixture-v1'`).get().n, 0)
})
